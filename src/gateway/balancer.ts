/**
 * Multi-upstream load balancing and failover.
 *
 * A server with `replicas:` is one logical server backed by several upstream
 * connections. The primary keeps the server id; each replica is connected as
 * an internal server `<id>~<n>` (`replicaOf: <id>`) whose tools and catalog are
 * not exposed on their own. Every call to the logical id is routed by the
 * invoker through `LoadBalancer.order()` and retried on the next member when
 * the failure kind is in `loadBalancing.failoverOn`.
 *
 * Health: a member is skipped while it is disconnected, while the periodic
 * health ping marks it `degraded` / `offline`, or while it is ejected after
 * `ejectAfter` consecutive failed calls (for `ejectMs`). When every member is
 * unhealthy all of them are tried in order.
 *
 * @module gateway/balancer
 */

import type { LoadBalancingConfig, McpServerConfig } from '../utils/types.js';

export const REPLICA_SEPARATOR = '~';

export type FailureKind = 'not-connected' | 'timeout' | 'error';

/** Expand `replicas:` into internal replica servers (primary first). */
export function expandReplicas(servers: McpServerConfig[]): McpServerConfig[] {
  const out: McpServerConfig[] = [];
  for (const s of servers) {
    out.push(s);
    (s.replicas ?? []).forEach((r, i) => {
      const { replicas: _r, loadBalancing: _lb, ...base } = s;
      void _r;
      void _lb;
      out.push({
        ...base,
        ...r,
        id: `${s.id}${REPLICA_SEPARATOR}${i + 1}`,
        name: r.name ?? `${s.name} (replica ${i + 1})`,
        replicaOf: s.id,
        enabled: s.enabled !== false && r.enabled !== false,
      });
    });
  }
  return out;
}

interface MemberState {
  failures: number;
  ejectedUntil: number;
  /** EWMA of call latency (ms). */
  latency?: number;
  calls: number;
  errors: number;
}

export interface MemberSnapshot {
  id: string;
  weight: number;
  connected: boolean;
  healthy: boolean;
  ejectedUntil?: string;
  latencyMs?: number;
  calls: number;
  errors: number;
}

export interface BalancerDeps {
  /** Every registered server config (primaries and replicas). */
  servers: () => McpServerConfig[];
  isConnected: (id: string) => boolean;
  /** Health status from the periodic ping (`online`, `degraded`, `offline`, ...). */
  healthStatus: (id: string) => string | undefined;
  now?: () => number;
  random?: () => number;
}

const DEFAULTS = { strategy: 'round-robin', failoverOn: ['not-connected'] as FailureKind[], ejectAfter: 3, ejectMs: 30_000 } as const;

export class LoadBalancer {
  private readonly state = new Map<string, MemberState>();
  private readonly cursor = new Map<string, number>();

  constructor(private readonly deps: BalancerDeps) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  private config(id: string): McpServerConfig | undefined {
    return this.deps.servers().find((s) => s.id === id);
  }

  /** Load-balancing settings of a logical server (undefined = no replicas). */
  settings(id: string): Required<Pick<LoadBalancingConfig, 'strategy' | 'failoverOn' | 'ejectAfter' | 'ejectMs'>> & { retries: number } {
    const lb = this.config(id)?.loadBalancing ?? {};
    const members = this.members(id).length;
    return {
      strategy: lb.strategy ?? DEFAULTS.strategy,
      failoverOn: lb.failoverOn ?? DEFAULTS.failoverOn,
      ejectAfter: lb.ejectAfter ?? DEFAULTS.ejectAfter,
      ejectMs: lb.ejectMs ?? DEFAULTS.ejectMs,
      retries: Math.max(0, Math.min(lb.retries ?? members - 1, members - 1)),
    };
  }

  /** Member ids of a logical server: the primary, then its replicas in config order. */
  members(id: string): string[] {
    const all = this.deps.servers();
    const replicas = all.filter((s) => s.replicaOf === id && s.enabled !== false).map((s) => s.id);
    return replicas.length === 0 ? [id] : [id, ...replicas];
  }

  /** Logical servers that have replicas. */
  groups(): string[] {
    return [...new Set(this.deps.servers().filter((s) => s.replicaOf).map((s) => s.replicaOf!))];
  }

  private st(id: string): MemberState {
    let s = this.state.get(id);
    if (!s) this.state.set(id, (s = { failures: 0, ejectedUntil: 0, calls: 0, errors: 0 }));
    return s;
  }

  isHealthy(id: string): boolean {
    if (!this.deps.isConnected(id)) return false;
    const h = this.deps.healthStatus(id);
    if (h === 'degraded' || h === 'offline') return false;
    return this.st(id).ejectedUntil <= this.now();
  }

  private weight(id: string): number {
    const w = this.config(id)?.weight;
    return typeof w === 'number' && w > 0 ? w : 1;
  }

  /** Whether any member of a (logical) server is connected. */
  anyConnected(id: string): boolean {
    return this.members(id).some((m) => this.deps.isConnected(m));
  }

  /** Members in the order they should be tried for the next call. */
  order(id: string): string[] {
    const members = this.members(id);
    if (members.length === 1) return members;
    const healthy = members.filter((m) => this.isHealthy(m));
    const rest = members.filter((m) => !healthy.includes(m));
    if (healthy.length === 0) return members;
    const { strategy } = this.settings(id);
    let ordered: string[];
    switch (strategy) {
      case 'failover':
        ordered = healthy;
        break;
      case 'random':
        ordered = shuffle(healthy, this.deps.random ?? Math.random);
        break;
      case 'least-latency':
        ordered = [...healthy].sort((a, b) => (this.st(a).latency ?? 0) - (this.st(b).latency ?? 0));
        break;
      case 'weighted': {
        const rnd = (this.deps.random ?? Math.random)();
        const total = healthy.reduce((n, m) => n + this.weight(m), 0);
        let acc = 0;
        let pick = healthy[healthy.length - 1]!;
        for (const m of healthy) {
          acc += this.weight(m) / total;
          if (rnd < acc) {
            pick = m;
            break;
          }
        }
        ordered = [pick, ...healthy.filter((m) => m !== pick)];
        break;
      }
      default: {
        const c = this.cursor.get(id) ?? 0;
        this.cursor.set(id, c + 1);
        const k = c % healthy.length;
        ordered = [...healthy.slice(k), ...healthy.slice(0, k)];
      }
    }
    return [...ordered, ...rest];
  }

  /** Record a call outcome on a member (failure kind undefined = success). */
  report(member: string, group: string, failure: FailureKind | undefined, durationMs: number): void {
    const s = this.st(member);
    s.calls++;
    if (failure === undefined) {
      s.failures = 0;
      s.latency = s.latency === undefined ? durationMs : s.latency * 0.8 + durationMs * 0.2;
      return;
    }
    s.errors++;
    s.failures++;
    const { ejectAfter, ejectMs } = this.settings(group);
    if (ejectAfter > 0 && s.failures >= ejectAfter) {
      s.ejectedUntil = this.now() + ejectMs;
      s.failures = 0;
    }
  }

  snapshot(): Array<{ server: string; strategy: string; failoverOn: FailureKind[]; members: MemberSnapshot[] }> {
    return this.groups().map((g) => {
      const set = this.settings(g);
      return {
        server: g,
        strategy: set.strategy,
        failoverOn: set.failoverOn,
        members: this.members(g).map((m) => {
          const s = this.st(m);
          return {
            id: m,
            weight: this.weight(m),
            connected: this.deps.isConnected(m),
            healthy: this.isHealthy(m),
            ...(s.ejectedUntil > this.now() ? { ejectedUntil: new Date(s.ejectedUntil).toISOString() } : {}),
            ...(s.latency !== undefined ? { latencyMs: Math.round(s.latency) } : {}),
            calls: s.calls,
            errors: s.errors,
          };
        }),
      };
    });
  }

  /** Drop state of members that no longer exist (after a reload). */
  prune(): void {
    const ids = new Set(this.deps.servers().map((s) => s.id));
    for (const id of this.state.keys()) if (!ids.has(id)) this.state.delete(id);
  }
}

function shuffle<T>(xs: T[], random: () => number): T[] {
  const a = [...xs];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}
