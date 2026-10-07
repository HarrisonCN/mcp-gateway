/**
 * Usage quotas and metering.
 *
 * Metering: every upstream call is counted per hour bucket, client, tenant,
 * server and tool (calls, errors, total duration). `GET /api/v1/usage` exports
 * the aggregates as JSON or CSV, grouped by key / tenant / server / tool / hour /
 * day. Buckets are kept for `quotas.meteringRetentionDays` (default 35).
 *
 * Quotas: `quotas.rules` cap tool calls per period (`hour`, `day`, `month`,
 * UTC calendar periods) per client (default) or per tenant, optionally for some
 * servers / tools only. A call over a quota is refused with `-32007` (REST
 * `429` with `Retry-After`) before it reaches the upstream server.
 *
 * Counters are in memory per instance.
 *
 * @module gateway/usage
 */

import { globToRegExp } from '../utils/tool-filter.js';
import type { QuotaRule, QuotasConfig } from '../utils/types.js';

export const ERR_QUOTA_EXCEEDED = -32007;

export interface UsageEvent {
  clientId?: string;
  tenants?: string[];
  serverId: string;
  tool: string;
  success: boolean;
  durationMs: number;
  at?: number;
}

interface Bucket {
  hour: number;
  clientId: string;
  tenant: string;
  serverId: string;
  tool: string;
  calls: number;
  errors: number;
  durationMs: number;
  /** First tenant of the call (calls in several tenants are bucketed once per tenant). */
  primary: boolean;
}

export type UsageGroup = 'client' | 'tenant' | 'server' | 'tool' | 'hour' | 'day';

export interface UsageRow {
  [k: string]: string | number;
  calls: number;
  errors: number;
  durationMs: number;
}

const HOUR = 3_600_000;

/** Start (ms) of the UTC period containing `t`, and of the next one. */
export function periodBounds(period: QuotaRule['period'], t: number): [number, number] {
  const d = new Date(t);
  if (period === 'hour') {
    const start = Math.floor(t / HOUR) * HOUR;
    return [start, start + HOUR];
  }
  if (period === 'day') {
    const start = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
    return [start, start + 24 * HOUR];
  }
  return [Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1), Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1)];
}

const any = (v: string, ps: string[] | undefined) => ps === undefined || ps.some((p) => globToRegExp(p).test(v));

function toolMatch(ps: string[] | undefined, serverId: string, tool: string): boolean {
  return ps === undefined || ps.some((p) => globToRegExp(p).test(p.includes('/') ? `${serverId}/${tool}` : tool));
}

export interface QuotaDecision {
  rule: string;
  subject: string;
  limit: number;
  used: number;
  resetsAt: number;
}

export class UsageMeter {
  private readonly buckets = new Map<string, Bucket>();
  /** rule#subject#periodStart → count */
  private readonly counters = new Map<string, number>();

  constructor(
    private readonly config: () => QuotasConfig | undefined,
    private readonly now: () => number = Date.now,
  ) {}

  private rules(): Array<QuotaRule & { id: string }> {
    return (this.config()?.rules ?? []).map((r, i) => ({ ...r, id: r.name ?? `#${i + 1}` }));
  }

  private subjects(rule: QuotaRule, e: Pick<UsageEvent, 'clientId' | 'tenants'>): string[] {
    const client = e.clientId ?? 'anonymous';
    if (rule.per === 'tenant') {
      return (e.tenants ?? []).filter((t) => any(t, rule.tenants)).map((t) => `tenant:${t}`);
    }
    if (rule.tenants && !(e.tenants ?? []).some((t) => any(t, rule.tenants))) return [];
    return any(client, rule.clients) ? [client] : [];
  }

  private applicable(e: Pick<UsageEvent, 'clientId' | 'tenants' | 'serverId' | 'tool'>) {
    const out: Array<{ rule: QuotaRule & { id: string }; subject: string; key: string; end: number }> = [];
    const t = this.now();
    for (const rule of this.rules()) {
      if (!any(e.serverId, rule.servers) || !toolMatch(rule.tools, e.serverId, e.tool)) continue;
      const [start, end] = periodBounds(rule.period, t);
      for (const subject of this.subjects(rule, e)) out.push({ rule, subject, key: `${rule.id}\u0000${subject}\u0000${start}`, end });
    }
    return out;
  }

  /** Check and consume quota for one call. Returns the exceeded quota, or undefined (consumed). */
  take(e: Pick<UsageEvent, 'clientId' | 'tenants' | 'serverId' | 'tool'>): QuotaDecision | undefined {
    const hits = this.applicable(e);
    for (const h of hits) {
      const used = this.counters.get(h.key) ?? 0;
      if (used >= h.rule.limit) return { rule: h.rule.id, subject: h.subject, limit: h.rule.limit, used, resetsAt: h.end };
    }
    for (const h of hits) this.counters.set(h.key, (this.counters.get(h.key) ?? 0) + 1);
    return undefined;
  }

  /** Record a finished call for metering. */
  record(e: UsageEvent): void {
    const at = e.at ?? this.now();
    const hour = Math.floor(at / HOUR) * HOUR;
    const tenants = e.tenants && e.tenants.length ? e.tenants : [''];
    for (const [i, tenant] of tenants.entries()) {
      const key = `${hour}\u0000${e.clientId ?? 'anonymous'}\u0000${tenant}\u0000${e.serverId}\u0000${e.tool}`;
      let b = this.buckets.get(key);
      if (!b) this.buckets.set(key, (b = { hour, clientId: e.clientId ?? 'anonymous', tenant, serverId: e.serverId, tool: e.tool, calls: 0, errors: 0, durationMs: 0, primary: i === 0 }));
      b.calls++;
      if (!e.success) b.errors++;
      b.durationMs += e.durationMs;
    }
    this.prune();
  }

  private lastPrune = 0;
  private prune(): void {
    const t = this.now();
    if (t - this.lastPrune < 60_000) return;
    this.lastPrune = t;
    const keepFrom = t - (this.config()?.meteringRetentionDays ?? 35) * 24 * HOUR;
    for (const [k, b] of this.buckets) if (b.hour < keepFrom) this.buckets.delete(k);
    for (const k of this.counters.keys()) {
      const start = Number(k.slice(k.lastIndexOf('\u0000') + 1));
      if (start < t - 32 * 24 * HOUR) this.counters.delete(k);
    }
  }

  /** Aggregated usage between `since` and `until`, grouped by the given dimensions. */
  report(opts: { since?: number; until?: number; group?: UsageGroup[]; client?: string; tenant?: string; server?: string } = {}): UsageRow[] {
    const group = opts.group?.length ? opts.group : (['client'] as UsageGroup[]);
    const rows = new Map<string, UsageRow>();
    for (const b of this.buckets.values()) {
      if (opts.since !== undefined && b.hour + HOUR <= opts.since) continue;
      if (opts.until !== undefined && b.hour >= opts.until) continue;
      if (opts.client && b.clientId !== opts.client) continue;
      if (opts.tenant !== undefined && b.tenant !== opts.tenant) continue;
      if (opts.server && b.serverId !== opts.server) continue;
      // Calls of clients in several tenants are bucketed once per tenant; count them once.
      if (!b.primary && !group.includes('tenant') && opts.tenant === undefined) continue;
      const dims: Record<string, string> = {};
      for (const g of group) {
        dims[g] =
          g === 'client' ? b.clientId
          : g === 'tenant' ? b.tenant
          : g === 'server' ? b.serverId
          : g === 'tool' ? `${b.serverId}/${b.tool}`
          : g === 'hour' ? new Date(b.hour).toISOString()
          : new Date(b.hour).toISOString().slice(0, 10);
      }
      const key = group.map((g) => dims[g]).join('\u0000');
      let r = rows.get(key);
      if (!r) rows.set(key, (r = { ...dims, calls: 0, errors: 0, durationMs: 0 }));
      r.calls += b.calls;
      r.errors += b.errors;
      r.durationMs += b.durationMs;
    }
    return [...rows.values()].sort((a, b) => b.calls - a.calls);
  }

  /** Current quota usage per rule and subject. */
  quotaStatus(): Array<{ rule: string; period: string; limit: number; subject: string; used: number; resetsAt: string }> {
    const t = this.now();
    const out: Array<{ rule: string; period: string; limit: number; subject: string; used: number; resetsAt: string }> = [];
    for (const rule of this.rules()) {
      const [start, end] = periodBounds(rule.period, t);
      for (const [k, used] of this.counters) {
        const [rid, subject, s] = k.split('\u0000');
        if (rid === rule.id && Number(s) === start) out.push({ rule: rule.id, period: rule.period, limit: rule.limit, subject: subject!, used, resetsAt: new Date(end).toISOString() });
      }
    }
    return out;
  }
}

/** CSV (RFC 4180) of usage rows. */
export function usageCsv(rows: UsageRow[], group: UsageGroup[]): string {
  const cols = [...(group.length ? group : ['client']), 'calls', 'errors', 'durationMs'];
  const cell = (v: unknown) => {
    let s = String(v ?? '');
    if (typeof v === 'string' && /^[=+\-@\t\r]/.test(s)) s = `'${s}`; // spreadsheet formula injection
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [cols.join(','), ...rows.map((r) => cols.map((c) => cell(r[c])).join(','))].join('\r\n') + '\r\n';
}
