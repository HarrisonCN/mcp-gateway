/**
 * Full-chain replay and time-travel debugging (10.6).
 *
 * An append-only **journal** records every applied configuration (redacted, with a content hash) and every tool
 * call — including calls the gateway refused — (client, tenant, server, tool, redacted arguments and — optionally —
 * the redacted result, outcome, duration
 * and the hash of the configuration it ran under). From the journal the gateway reconstructs what it looked like at
 * any moment and replays history:
 *
 * - `GET  /admin/time-travel` — journal status.
 * - `GET  /admin/time-travel/state?at=<ISO>` — the configuration in effect at that instant, call statistics up to it
 *   and the most recent calls before it.
 * - `GET  /admin/time-travel/calls?from&to&client&server&tool&limit` — calls in a time range.
 * - `GET  /admin/time-travel/chain/:id?windowMs=` — one call with the configuration it ran under and the calls of the
 *   same client around it (the call chain of an agent session).
 * - `GET  /admin/time-travel/config-diff?from=<ISO>&to=<ISO>` — what changed in the configuration between two
 *   instants.
 * - `POST /admin/time-travel/replay` `{ from?, to?, ids?, client?, server?, tool?, limit?, execute? }` — for each
 *   journaled call: the `policy.rules` decision under the configuration it ran with versus the running one, and with
 *   `execute: true` the call is executed again (through the full pipeline, against today's upstreams) and its result
 *   diffed against the recorded one.
 *
 * ```yaml
 * features:
 *   timeTravel:
 *     dir: .mcp-gateway/journal   # optional: persist as daily JSONL files (relative to the config file)
 *     retentionDays: 7            # files older than this are deleted
 *     maxEntries: 20000           # journal entries kept in memory (oldest dropped)
 *     results: true               # keep redacted results (needed for result diffs)
 *     maxBytes: 16384             # per argument / result payload; larger payloads are truncated
 * ```
 *
 * Without `dir` the journal lives in memory only and is lost on restart. Arguments, results and configuration are
 * passed through the gateway's secret redaction before they are stored; secrets that redaction does not recognise
 * would be stored — keep `results: false` for tools that return sensitive data.
 *
 * @module features/time-travel
 */

import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync } from 'fs';
import { createHash } from 'crypto';
import { join, resolve } from 'path';
import { z } from 'zod';
import { registerFeature, objectBody, badRequest, principalOf } from '../gateway/features.js';
import { registerCallHook } from '../gateway/hooks.js';
import { redactValue } from '../security/redact.js';
import { jsonDiff } from '../gateway/replay.js';
import { evaluatePolicy } from '../policy/tool-policy.js';
import type { GatewayConfig, ProxyResponse } from '../utils/types.js';
import { logger } from '../utils/logger.js';
import { type TimeTravelConfig, TimeTravelSchema } from './schemas/time-travel.js';
export { type TimeTravelConfig, TimeTravelSchema } from './schemas/time-travel.js';
type Parsed = z.output<typeof TimeTravelSchema>;

export interface ConfigEvent {
  type: 'config';
  at: string;
  hash: string;
  config: Record<string, unknown>;
}

export interface CallEvent {
  type: 'call';
  at: string;
  id: string;
  clientId?: string;
  tenant?: string;
  serverId: string;
  tool: string;
  args?: Record<string, unknown>;
  argsTruncated?: boolean;
  success: boolean;
  /** Refused by the gateway (policy, quota, budget, …) without reaching the upstream. */
  refused?: boolean;
  durationMs?: number;
  result?: unknown;
  resultTruncated?: boolean;
  error?: { code?: number; message: string };
  configHash?: string;
}

export type JournalEvent = ConfigEvent | CallEvent;

/** Keys of a config that are bookkeeping, not configuration. */
const VOLATILE = new Set(['configDir']);

export function configSnapshot(cfg: GatewayConfig): { hash: string; config: Record<string, unknown> } {
  const plain = Object.fromEntries(Object.entries(cfg as unknown as Record<string, unknown>).filter(([k, v]) => !VOLATILE.has(k) && v !== undefined));
  const config = redactValue(JSON.parse(JSON.stringify(plain)) as Record<string, unknown>);
  return { hash: createHash('sha256').update(JSON.stringify(plain)).digest('hex').slice(0, 16), config };
}

const size = (v: unknown) => {
  try {
    return JSON.stringify(v)?.length ?? 0;
  } catch {
    return Infinity;
  }
};

/** In-memory journal with optional daily JSONL persistence. */
export class Journal {
  readonly events: JournalEvent[] = [];
  private seq = 0;
  private loadedDir?: string;
  private lastHash?: string;
  readonly hashes = new WeakMap<object, string>();

  constructor(private cfg: () => Parsed, private readonly baseDir: () => string | undefined = () => undefined) {}

  private dir(): string | undefined {
    const d = this.cfg().dir;
    return d ? resolve(this.baseDir() ?? process.cwd(), d) : undefined;
  }

  /** Load persisted files once per directory (newest `maxEntries` events). */
  load(): void {
    const dir = this.dir();
    if (!dir || this.loadedDir === dir) return;
    this.loadedDir = dir;
    if (!existsSync(dir)) return;
    const cutoff = Date.now() - this.cfg().retentionDays * 86_400_000;
    const files = readdirSync(dir).filter((f) => /^journal-\d{4}-\d{2}-\d{2}\.jsonl$/.test(f)).sort();
    const loaded: JournalEvent[] = [];
    for (const f of files) {
      const day = Date.parse(f.slice(8, 18));
      if (day + 86_400_000 < cutoff) {
        try {
          unlinkSync(join(dir, f));
        } catch {
          /* ignore */
        }
        continue;
      }
      for (const line of readFileSync(join(dir, f), 'utf8').split('\n')) {
        if (!line.trim()) continue;
        try {
          loaded.push(JSON.parse(line) as JournalEvent);
        } catch {
          // torn line (crash mid-write): skip
        }
      }
    }
    const keep = loaded.slice(-this.cfg().maxEntries);
    this.events.unshift(...keep);
    this.trim();
    const lastCfg = [...this.events].reverse().find((e): e is ConfigEvent => e.type === 'config');
    this.lastHash = lastCfg?.hash;
  }

  private trim(): void {
    const max = this.cfg().maxEntries;
    if (this.events.length > max) this.events.splice(0, this.events.length - max);
  }

  private persist(e: JournalEvent): void {
    const dir = this.dir();
    if (!dir) return;
    try {
      mkdirSync(dir, { recursive: true });
      appendFileSync(join(dir, `journal-${e.at.slice(0, 10)}.jsonl`), JSON.stringify(e) + '\n');
    } catch (err) {
      logger.warn(`time-travel: journal write failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private push(e: JournalEvent): void {
    this.events.push(e);
    this.trim();
    this.persist(e);
  }

  /** Record the config when it differs from the last recorded one; returns its hash. */
  noteConfig(cfg: GatewayConfig, now = new Date()): string {
    const known = this.hashes.get(cfg);
    if (known && known === this.lastHash) return known;
    const snap = configSnapshot(cfg);
    this.hashes.set(cfg, snap.hash);
    if (snap.hash !== this.lastHash) {
      this.lastHash = snap.hash;
      this.push({ type: 'config', at: now.toISOString(), hash: snap.hash, config: snap.config });
    }
    return snap.hash;
  }

  noteCall(c: Omit<CallEvent, 'type' | 'id' | 'at'> & { at?: string }): CallEvent {
    const { maxBytes, results } = this.cfg();
    const e: CallEvent = { type: 'call', id: `tt-${Date.now().toString(36)}-${(this.seq++).toString(36)}`, ...c, at: c.at ?? new Date().toISOString() };
    if (e.args !== undefined) {
      const a = redactValue(e.args);
      if (size(a) > maxBytes) {
        delete e.args;
        e.argsTruncated = true;
      } else e.args = a;
    }
    if (!results) delete e.result;
    else if (e.result !== undefined) {
      const r = redactValue(e.result);
      if (size(r) > maxBytes) {
        delete e.result;
        e.resultTruncated = true;
      } else e.result = r;
    }
    this.push(e);
    return e;
  }

  calls(): CallEvent[] {
    return this.events.filter((e): e is CallEvent => e.type === 'call');
  }

  configs(): ConfigEvent[] {
    return this.events.filter((e): e is ConfigEvent => e.type === 'config');
  }

  /** The configuration in effect at `t` (last config event at or before it). */
  configAt(t: number): ConfigEvent | undefined {
    let found: ConfigEvent | undefined;
    for (const e of this.events) {
      if (e.type !== 'config') continue;
      if (Date.parse(e.at) <= t) found = e;
      else break;
    }
    return found;
  }

  configByHash(hash: string | undefined): ConfigEvent | undefined {
    return hash ? this.configs().find((c) => c.hash === hash) : undefined;
  }

  clear(): void {
    this.events.length = 0;
    this.lastHash = undefined;
  }
}

let journal: Journal | undefined;
let journalCfg: Parsed = TimeTravelSchema.parse({});
let journalBase: string | undefined;

export function parsedOf(cfg: GatewayConfig): Parsed | undefined {
  const raw = cfg.timeTravel;
  if (!raw) return undefined;
  const p = TimeTravelSchema.parse(raw);
  return p.enabled ? p : undefined;
}

/** The process-wide journal for a config (created on first use). */
export function journalFor(cfg: GatewayConfig): Journal | undefined {
  const p = parsedOf(cfg);
  if (!p) return undefined;
  journalCfg = p;
  journalBase = cfg.configDir;
  if (!journal) journal = new Journal(() => journalCfg, () => journalBase);
  journal.load();
  return journal;
}

/** Test helper: forget the process-wide journal. */
export function resetJournal(): void {
  journal = undefined;
}

registerCallHook({
  id: 'time-travel',
  after: (call, result: ProxyResponse, cfg) => {
    const j = journalFor(cfg);
    if (!j) return;
    const hash = j.noteConfig(cfg);
    j.noteCall({
      clientId: call.clientId,
      tenant: call.tenant,
      serverId: call.serverId,
      tool: call.tool,
      args: call.args,
      success: result.success,
      durationMs: result.durationMs,
      result: result.success ? result.result : undefined,
      error: result.success ? undefined : { code: result.error?.code, message: result.error?.message ?? 'failed' },
      configHash: hash,
    });
  },
  refused: (call, error, cfg) => {
    const j = journalFor(cfg);
    if (!j) return;
    const hash = j.noteConfig(cfg);
    j.noteCall({ clientId: call.clientId, tenant: call.tenant, serverId: call.serverId, tool: call.tool, args: call.args, success: false, refused: true, durationMs: 0, error: { code: error.code, message: error.message }, configHash: hash });
  },
});

const time = (v: unknown, fallback: number): number | string => {
  if (v === undefined || v === '') return fallback;
  const t = typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : Date.parse(String(v));
  return Number.isFinite(t) ? t : `invalid time ${JSON.stringify(v)}`;
};

interface CallFilter {
  from: number;
  to: number;
  client?: string;
  server?: string;
  tool?: string;
}

function filterCalls(list: CallEvent[], f: CallFilter): CallEvent[] {
  return list.filter((c) => {
    const t = Date.parse(c.at);
    return t >= f.from && t <= f.to && (!f.client || c.clientId === f.client) && (!f.server || c.serverId === f.server) && (!f.tool || c.tool === f.tool);
  });
}

const str = (v: unknown) => (typeof v === 'string' && v ? v : undefined);

registerFeature({
  id: 'time-travel',
  since: '10.6.0',
  summary: 'Full-chain replay and time-travel debugging: journal of configs and calls, state at any instant, replay with diffs',
  mount: (router, ctx) => {
    const need = (res: import('express').Response): Journal | undefined => {
      const j = journalFor(ctx.config());
      if (!j) badRequest(res, 'features.timeTravel is not configured');
      else j.noteConfig(ctx.config());
      return j;
    };
    router.get('/', (_req, res) => {
      const cfg = ctx.config();
      const p = parsedOf(cfg);
      const j = journalFor(cfg);
      if (j) j.noteConfig(cfg);
      const calls = j?.calls() ?? [];
      res.json({
        enabled: !!p,
        persisted: !!p?.dir,
        entries: j?.events.length ?? 0,
        calls: calls.length,
        configs: j?.configs().length ?? 0,
        from: j?.events[0]?.at ?? null,
        to: j?.events.at(-1)?.at ?? null,
        maxEntries: p?.maxEntries ?? null,
      });
    });
    router.get('/state', (req, res) => {
      const j = need(res);
      if (!j) return;
      const at = time(req.query.at, Date.now());
      if (typeof at === 'string') return badRequest(res, at);
      const config = j.configAt(at);
      const before = j.calls().filter((c) => Date.parse(c.at) <= at);
      const byServer: Record<string, number> = {};
      const byTool: Record<string, number> = {};
      let errors = 0;
      for (const c of before) {
        byServer[c.serverId] = (byServer[c.serverId] ?? 0) + 1;
        byTool[`${c.serverId}/${c.tool}`] = (byTool[`${c.serverId}/${c.tool}`] ?? 0) + 1;
        if (!c.success) errors++;
      }
      res.json({
        at: new Date(at).toISOString(),
        config: config ? { hash: config.hash, appliedAt: config.at, servers: ((config.config.servers as Array<{ id?: string }> | undefined) ?? []).map((s) => s.id), config: config.config } : null,
        calls: { total: before.length, errors, byServer, byTool },
        recent: before.slice(-20).reverse(),
        ...(config ? {} : { note: 'no configuration was journaled at or before this instant' }),
      });
    });
    router.get('/calls', (req, res) => {
      const j = need(res);
      if (!j) return;
      const from = time(req.query.from, 0);
      const to = time(req.query.to, Date.now());
      if (typeof from === 'string') return badRequest(res, from);
      if (typeof to === 'string') return badRequest(res, to);
      const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 1000);
      const list = filterCalls(j.calls(), { from, to, client: str(req.query.client), server: str(req.query.server), tool: str(req.query.tool) });
      res.json({ total: list.length, calls: list.slice(-limit).reverse() });
    });
    router.get('/chain/:id', (req, res) => {
      const j = need(res);
      if (!j) return;
      const calls = j.calls();
      const c = calls.find((x) => x.id === req.params.id);
      if (!c) return void res.status(404).json({ error: 'Not Found', message: `No journaled call ${req.params.id}` });
      const windowMs = Math.min(Math.max(Number(req.query.windowMs) || 60_000, 1), 86_400_000);
      const t = Date.parse(c.at);
      const chain = calls.filter((x) => x.clientId === c.clientId && Math.abs(Date.parse(x.at) - t) <= windowMs);
      const cfgEv = j.configByHash(c.configHash) ?? j.configAt(t);
      res.json({ call: c, config: cfgEv ? { hash: cfgEv.hash, appliedAt: cfgEv.at } : null, windowMs, chain: chain.map((x) => ({ id: x.id, at: x.at, serverId: x.serverId, tool: x.tool, success: x.success, durationMs: x.durationMs, current: x.id === c.id })) });
    });
    router.get('/config-diff', (req, res) => {
      const j = need(res);
      if (!j) return;
      const from = time(req.query.from, 0);
      const to = time(req.query.to, Date.now());
      if (typeof from === 'string') return badRequest(res, from);
      if (typeof to === 'string') return badRequest(res, to);
      const a = j.configAt(from);
      const b = j.configAt(to);
      res.json({ from: a ? { hash: a.hash, appliedAt: a.at } : null, to: b ? { hash: b.hash, appliedAt: b.at } : null, changes: a && b ? jsonDiff(a.config, b.config) : [] });
    });
    router.post('/replay', async (req, res) => {
      const b = objectBody(req, res);
      if (!b) return;
      const j = need(res);
      if (!j) return;
      const from = time(b.from, 0);
      const to = time(b.to, Date.now());
      if (typeof from === 'string') return badRequest(res, from);
      if (typeof to === 'string') return badRequest(res, to);
      if (b.ids !== undefined && (!Array.isArray(b.ids) || !b.ids.every((x) => typeof x === 'string'))) return badRequest(res, '"ids" must be an array of journal ids');
      const limit = Math.min(Math.max(Number(b.limit) || 20, 1), 100);
      const execute = b.execute === true;
      let list = filterCalls(j.calls(), { from, to, client: str(b.client), server: str(b.server), tool: str(b.tool) });
      if (Array.isArray(b.ids)) {
        const ids = new Set(b.ids as string[]);
        list = j.calls().filter((c) => ids.has(c.id));
      }
      list = list.slice(-limit);
      const current = ctx.config();
      const out = [];
      for (const c of list) {
        const then = j.configByHash(c.configHash) ?? j.configAt(Date.parse(c.at));
        const reqP = { clientId: c.clientId, serverId: c.serverId, tool: c.tool, args: c.args ?? {} };
        const decisionThen = then ? evaluatePolicy(then.config.policy as GatewayConfig['policy'], reqP).effect : 'unknown';
        const decisionNow = evaluatePolicy(current.policy, reqP).effect;
        const item: Record<string, unknown> = { id: c.id, at: c.at, serverId: c.serverId, tool: c.tool, clientId: c.clientId, policy: { then: decisionThen, now: decisionNow, changed: decisionThen !== decisionNow } };
        if (execute) {
          if (c.argsTruncated || c.args === undefined) item.replay = { skipped: 'arguments were not journaled (truncated)' };
          else {
            const r = await ctx.invoke(c.serverId, c.tool, c.args, principalOf(req), `replay:${c.clientId ?? 'anonymous'}`);
            const now = r.success ? redactValue(r.result) : undefined;
            item.replay = {
              success: r.success,
              ...(r.success ? {} : { error: r.error?.message }),
              outcomeChanged: r.success !== c.success,
              ...(c.result !== undefined && r.success ? { diff: jsonDiff(c.result, now, 50) } : { diff: null, note: c.resultTruncated ? 'recorded result was truncated' : c.result === undefined ? 'no recorded result (results: false or failed call)' : undefined }),
            };
          }
        }
        out.push(item);
      }
      res.json({ calls: out.length, executed: execute, policyChanged: out.filter((x) => (x.policy as { changed: boolean }).changed).length, results: out });
    });
    router.post('/reset', (_req, res) => {
      const j = need(res);
      if (!j) return;
      j.clear();
      res.json({ reset: true, note: 'in-memory journal cleared; persisted files are kept' });
    });
  },
});
