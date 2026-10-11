/**
 * Cluster config rollout coordination (14.1.0 "集群协调") — PLACEHOLDER (tests-first).
 *
 * The control plane numbers every distributed config as a generation, decides which generation each data plane
 * should run (all-at-once or canary → promote), rolls back automatically when data planes fail to apply or fail
 * their post-apply health check, and reports any data plane that stays off its target generation for longer than
 * `maxDivergenceMs` (no long-lived config divergence inside the cluster).
 *
 * @module gateway/rollout
 */
import { z } from 'zod';
import { configEtag } from './config-etag.js';

/** `controlPlane.rollout` (14.1.0, control role only). */
export const RolloutSchema = z
  .object({
    strategy: z.enum(['all-at-once', 'canary']).default('all-at-once'),
    canary: z
      .object({ nodes: z.number().int().min(1).max(1000).optional(), percent: z.number().min(1).max(100).optional() })
      .strict()
      .optional(),
    bakeMs: z.number().int().min(0).max(86_400_000).default(30_000),
    failureThreshold: z.number().int().min(1).max(1000).default(1),
    autoRollback: z.boolean().default(true),
    maxDivergenceMs: z.number().int().min(1000).max(86_400_000).default(60_000),
    history: z.number().int().min(2).max(100).default(10),
  })
  .strict()
  .superRefine((r, ctx) => {
    if (r.strategy === 'canary' && r.canary?.nodes === undefined && r.canary?.percent === undefined) {
      ctx.addIssue({ code: 'custom', path: ['canary'], message: 'a canary rollout needs `canary.nodes` or `canary.percent`' });
    }
  });

export interface RolloutPolicy {
  /** `all-at-once` (default): every data plane targets the newest generation. `canary`: canary nodes first, promote after `bakeMs`. */
  strategy: 'all-at-once' | 'canary';
  /** Canary size: a node count or a percentage of the known data planes (rounded up, at least 1). */
  canary?: { nodes?: number; percent?: number };
  /** How long every canary node must have run the new generation without failures before it is promoted (default 30000). */
  bakeMs: number;
  /** Data planes that must report a failed apply / health check of the target generation before it is rolled back (default 1). */
  failureThreshold: number;
  /** Roll back automatically on failure (default true). */
  autoRollback: boolean;
  /** A data plane off its target generation longer than this is reported as diverged (default 60000). */
  maxDivergenceMs: number;
  /** Generations kept for rollback (default 10). */
  history: number;
}

export interface Generation {
  generation: number;
  etag: string;
  config: Record<string, unknown>;
  publishedAt: string;
  source: 'publish' | 'rollback';
  rollbackOf?: number;
  bad?: boolean;
}

export interface NodeReport {
  generation?: number;
  etag?: string;
  failedGeneration?: number;
  error?: string;
}

export type RolloutState = 'idle' | 'canary' | 'complete' | 'failed' | 'rolled-back';

export class RolloutError extends Error {}

interface NodeState {
  nodeId: string;
  etag?: string;
  generation?: number;
  /** Target etag + when this node got it as its target (divergence clock). */
  targetEtag?: string;
  targetSince: number;
  lastSeen: number;
}

const DEFAULTS: RolloutPolicy = { strategy: 'all-at-once', bakeMs: 30_000, failureThreshold: 1, autoRollback: true, maxDivergenceMs: 60_000, history: 10 };

/** Control-plane side: generations, per-node targets, canary promotion, failure rollback, divergence. */
export class RolloutCoordinator {
  private readonly policy: RolloutPolicy;
  private readonly now: () => number;
  private gens: Generation[] = [];
  private next = 1;
  private state: RolloutState = 'idle';
  /** Generation every non-canary node runs while a canary is in progress. */
  private stable?: Generation;
  private canary: string[] = [];
  private canarySince?: number;
  private nodes = new Map<string, NodeState>();
  private failures: Array<{ nodeId: string; generation: number; error: string }> = [];
  private lastRollback?: { from: number; to: number; restored: number; reason: string; at: string };

  constructor(policy: Partial<RolloutPolicy> = {}, opts: { now?: () => number } = {}) {
    this.policy = { ...DEFAULTS, ...policy };
    this.now = opts.now ?? Date.now;
  }

  private latest(): Generation | undefined {
    return this.gens[this.gens.length - 1];
  }

  private push(g: Omit<Generation, 'generation' | 'publishedAt'>): Generation {
    const gen: Generation = { ...g, generation: this.next++, publishedAt: new Date(this.now()).toISOString() };
    this.gens.push(gen);
    while (this.gens.length > this.policy.history) this.gens.shift();
    this.failures = [];
    return gen;
  }

  private canarySize(): number {
    const known = this.nodes.size;
    const c = this.policy.canary ?? {};
    const n = c.nodes ?? Math.ceil((known * (c.percent ?? 0)) / 100);
    return Math.max(1, Math.min(n, Math.max(known, 1)));
  }

  /** Publish a config. Identical content keeps the current generation; content of a bad generation needs `force`. */
  publish(config: Record<string, unknown>, opts: { force?: boolean } = {}): Generation {
    const etag = configEtag(config);
    const cur = this.latest();
    if (cur && cur.etag === etag) return cur;
    if (!opts.force && this.gens.some((g) => g.bad && g.etag === etag)) {
      throw new RolloutError(`this config is generation ${this.gens.find((g) => g.bad && g.etag === etag)!.generation}, which failed and was rolled back; publish with force to retry it`);
    }
    const prev = this.current();
    const gen = this.push({ etag, config, source: 'publish' });
    if (this.policy.strategy === 'canary' && prev && this.nodes.size > 0) {
      this.state = 'canary';
      this.stable = prev;
      this.canary = [...this.nodes.keys()].sort().slice(0, this.canarySize());
      this.canarySince = undefined;
    } else {
      this.state = 'complete';
      this.stable = undefined;
      this.canary = [];
    }
    this.retarget();
    return gen;
  }

  /** The newest generation (the rollout target). */
  current(): Generation | undefined {
    return this.latest();
  }

  /** The generation a data plane should run now. */
  targetFor(nodeId: string): Generation | undefined {
    const cur = this.latest();
    if (!cur) return undefined;
    if (this.state === 'canary' && this.stable && !this.canary.includes(nodeId)) return this.stable;
    return cur;
  }

  private touch(nodeId: string): NodeState {
    let n = this.nodes.get(nodeId);
    if (!n) {
      n = { nodeId, targetSince: this.now(), lastSeen: this.now() };
      this.nodes.set(nodeId, n);
    }
    const target = this.targetFor(nodeId)?.etag;
    if (n.targetEtag !== target) {
      n.targetEtag = target;
      n.targetSince = this.now();
    }
    return n;
  }

  private retarget(): void {
    for (const id of this.nodes.keys()) this.touch(id);
  }

  /** A data plane reports what it runs (heartbeat) and any generation it failed to apply. */
  report(nodeId: string, r: NodeReport): void {
    const n = this.touch(nodeId);
    n.lastSeen = this.now();
    if (r.etag !== undefined) n.etag = r.etag;
    if (r.generation !== undefined) n.generation = r.generation;
    else if (r.etag !== undefined) n.generation = [...this.gens].reverse().find((g) => g.etag === r.etag)?.generation;
    const cur = this.latest();
    if (cur && r.failedGeneration === cur.generation && (this.state === 'canary' || this.state === 'complete' || this.state === 'failed')) {
      if (!this.failures.some((f) => f.nodeId === nodeId)) this.failures.push({ nodeId, generation: cur.generation, error: (r.error ?? 'apply failed').slice(0, 500) });
      if (this.failures.length >= this.policy.failureThreshold) {
        if (this.policy.autoRollback && this.lastGood(cur.generation)) {
          const reason = `generation ${cur.generation} failed on ${this.failures.map((f) => `${f.nodeId} (${f.error})`).join(', ')}`;
          this.rollback(undefined, reason);
        } else this.state = 'failed';
      }
    }
    this.tick();
  }

  private lastGood(before: number): Generation | undefined {
    return [...this.gens].reverse().find((g) => g.generation < before && !g.bad);
  }

  /** Advance time-based transitions: canary promotion after bakeMs. */
  tick(): void {
    if (this.state !== 'canary') return;
    const cur = this.latest()!;
    const allOn = this.canary.every((id) => this.nodes.get(id)?.etag === cur.etag);
    if (!allOn || this.failures.length) {
      this.canarySince = undefined;
      return;
    }
    this.canarySince ??= this.now();
    if (this.now() - this.canarySince >= this.policy.bakeMs) {
      this.state = 'complete';
      this.stable = undefined;
      this.canary = [];
      this.retarget();
    }
  }

  /** Roll back to `to` (default: the last good generation before the current one) as a new generation. */
  rollback(to?: number, reason = 'manual rollback'): Generation {
    const cur = this.latest();
    if (!cur) throw new RolloutError('nothing has been published yet');
    const target = to === undefined ? this.lastGood(cur.generation) : this.gens.find((g) => g.generation === to);
    if (!target) throw new RolloutError(to === undefined ? 'no earlier generation to roll back to' : `generation ${to} is not kept (history: ${this.gens.map((g) => g.generation).join(', ')})`);
    if (this.failures.length) cur.bad = true;
    const gen = this.push({ etag: target.etag, config: target.config, source: 'rollback', rollbackOf: cur.generation });
    this.lastRollback = { from: cur.generation, to: gen.generation, restored: target.generation, reason, at: new Date(this.now()).toISOString() };
    this.state = 'rolled-back';
    this.stable = undefined;
    this.canary = [];
    this.retarget();
    return gen;
  }

  forget(nodeId: string): void {
    this.nodes.delete(nodeId);
    this.canary = this.canary.filter((id) => id !== nodeId);
  }

  status() {
    const cur = this.latest();
    const t = this.now();
    const nodes = [...this.nodes.values()]
      .map((n) => {
        const target = this.targetFor(n.nodeId);
        const inSync = !!target && n.etag === target.etag;
        const off = inSync ? 0 : t - n.targetSince;
        const diverged = !inSync && off > this.policy.maxDivergenceMs;
        return { nodeId: n.nodeId, ...(n.generation !== undefined ? { generation: n.generation } : {}), target: target?.generation, inSync, diverged, ...(diverged ? { divergedForMs: off } : {}), lastSeen: new Date(n.lastSeen).toISOString() };
      })
      .sort((a, b) => a.nodeId.localeCompare(b.nodeId));
    return {
      state: this.state,
      strategy: this.policy.strategy,
      ...(cur ? { generation: cur.generation, etag: cur.etag } : {}),
      ...(this.stable ? { stableGeneration: this.stable.generation } : {}),
      canaryNodes: [...this.canary],
      nodes,
      converged: nodes.every((n) => n.inSync),
      diverged: nodes.filter((n) => n.diverged).map((n) => n.nodeId),
      failures: this.failures.map((f) => ({ ...f })),
      ...(this.lastRollback ? { lastRollback: { ...this.lastRollback } } : {}),
      history: this.gens.map((g) => ({ generation: g.generation, etag: g.etag, publishedAt: g.publishedAt, source: g.source, ...(g.rollbackOf ? { rollbackOf: g.rollbackOf } : {}), bad: !!g.bad })),
    };
  }
}
