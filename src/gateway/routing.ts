/**
 * Smart routing (3.4): traffic splits (canary / A/B) across servers and score-based upstream selection.
 *
 * `routing.splits` sends a share of the calls for a server (optionally only some tools) to other servers that expose
 * the same tools — a canary build, a second vendor, an A/B experiment. Variants are picked by weight, sticky per
 * client by default (hash of client id + split name), so one caller sees one variant. A variant with `guard` is
 * rolled back automatically (weight 0) once its error rate or p50 latency crosses the limit over `minCalls` calls.
 *
 * `loadBalancing.strategy: smart` (servers with `replicas:`) orders members by a score of latency (EWMA), error
 * rate (EWMA) and `cost` per call, weighted by `loadBalancing.score` — lowest first. See `LoadBalancer`.
 *
 * @module gateway/routing
 */

import type { RoutingConfig, TrafficSplitConfig } from '../utils/types.js';
import { globToRegExp } from '../utils/tool-filter.js';

export interface SplitVariantStats {
  server: string;
  label: string;
  weight: number;
  /** Effective weight (0 when rolled back). */
  effectiveWeight: number;
  calls: number;
  errors: number;
  errorRate: number;
  latencyMs?: number;
  rolledBack?: { at: string; reason: string };
}

export interface SplitSnapshot {
  name: string;
  server: string;
  tools?: string[];
  sticky: 'client' | 'none';
  variants: SplitVariantStats[];
}

interface VariantState {
  calls: number;
  errors: number;
  latency?: number;
  rolledBack?: { at: number; reason: string };
}

/** FNV-1a 32-bit hash with a murmur3 finalizer → [0, 1). */
export function stableFraction(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 0) / 0x1_0000_0000;
}

export interface RouteDecision {
  /** Server id the call goes to (may equal the requested one). */
  server: string;
  split: string;
  variant: string;
}

export class SmartRouter {
  private readonly state = new Map<string, VariantState>();

  constructor(
    private readonly config: () => RoutingConfig | undefined,
    private readonly opts: { random?: () => number; now?: () => number; isConnected?: (id: string) => boolean } = {},
  ) {}

  private splits(): TrafficSplitConfig[] {
    return (this.config()?.splits ?? []).filter((s) => s.enabled !== false);
  }

  private st(split: string, server: string): VariantState {
    const k = `${split}\u0000${server}`;
    let s = this.state.get(k);
    if (!s) this.state.set(k, (s = { calls: 0, errors: 0 }));
    return s;
  }

  private now(): number {
    return this.opts.now?.() ?? Date.now();
  }

  /** The split that applies to a call, if any (first match wins). */
  splitFor(serverId: string, tool: string): TrafficSplitConfig | undefined {
    return this.splits().find((s) => s.server === serverId && (!s.tools?.length || s.tools.some((p) => globToRegExp(p).test(tool))));
  }

  private effectiveWeight(split: TrafficSplitConfig, v: TrafficSplitConfig['variants'][number]): number {
    const st = this.st(split.name, v.server);
    if (st.rolledBack) return 0;
    if (this.opts.isConnected && v.server !== split.server && !this.opts.isConnected(v.server)) return 0;
    return Math.max(0, v.weight);
  }

  /** Pick the target for a tool call; undefined when no split applies. */
  route(serverId: string, tool: string, clientId?: string): RouteDecision | undefined {
    const split = this.splitFor(serverId, tool);
    if (!split) return undefined;
    const variants = split.variants.map((v) => ({ v, w: this.effectiveWeight(split, v) }));
    const total = variants.reduce((n, x) => n + x.w, 0);
    if (total <= 0) return { server: split.server, split: split.name, variant: 'baseline' };
    const sticky = (split.sticky ?? 'client') === 'client' && clientId;
    const r = sticky ? stableFraction(`${split.name}:${clientId}`) : (this.opts.random ?? Math.random)();
    let acc = 0;
    for (const { v, w } of variants) {
      acc += w / total;
      if (r < acc) return { server: v.server, split: split.name, variant: v.label ?? v.server };
    }
    const last = [...variants].reverse().find((x) => x.w > 0)!.v;
    return { server: last.server, split: split.name, variant: last.label ?? last.server };
  }

  /** Record the outcome of a routed call; may roll a guarded variant back. */
  report(d: RouteDecision, success: boolean, durationMs: number): void {
    const split = this.splits().find((s) => s.name === d.split);
    const st = this.st(d.split, d.server);
    st.calls++;
    if (!success) st.errors++;
    if (success) st.latency = st.latency === undefined ? durationMs : st.latency * 0.8 + durationMs * 0.2;
    const v = split?.variants.find((x) => x.server === d.server);
    const g = v?.guard;
    if (!g || st.rolledBack || st.calls < (g.minCalls ?? 20)) return;
    const rate = st.errors / st.calls;
    if (g.maxErrorRate !== undefined && rate > g.maxErrorRate) {
      st.rolledBack = { at: this.now(), reason: `error rate ${(rate * 100).toFixed(1)}% > ${(g.maxErrorRate * 100).toFixed(1)}%` };
    } else if (g.maxLatencyMs !== undefined && st.latency !== undefined && st.latency > g.maxLatencyMs) {
      st.rolledBack = { at: this.now(), reason: `latency ${Math.round(st.latency)}ms > ${g.maxLatencyMs}ms` };
    }
  }

  /** Clear stats (and rollbacks) of one split, or all. */
  reset(split?: string): boolean {
    let found = false;
    for (const k of [...this.state.keys()]) {
      if (split === undefined || k.startsWith(`${split}\u0000`)) {
        this.state.delete(k);
        found = true;
      }
    }
    return found || split === undefined || this.splits().some((s) => s.name === split);
  }

  snapshot(): SplitSnapshot[] {
    return this.splits().map((s) => ({
      name: s.name,
      server: s.server,
      ...(s.tools?.length ? { tools: s.tools } : {}),
      sticky: s.sticky ?? 'client',
      variants: s.variants.map((v) => {
        const st = this.st(s.name, v.server);
        return {
          server: v.server,
          label: v.label ?? v.server,
          weight: v.weight,
          effectiveWeight: this.effectiveWeight(s, v),
          calls: st.calls,
          errors: st.errors,
          errorRate: st.calls ? Math.round((st.errors / st.calls) * 1000) / 1000 : 0,
          ...(st.latency !== undefined ? { latencyMs: Math.round(st.latency) } : {}),
          ...(st.rolledBack ? { rolledBack: { at: new Date(st.rolledBack.at).toISOString(), reason: st.rolledBack.reason } } : {}),
        };
      }),
    }));
  }
}
