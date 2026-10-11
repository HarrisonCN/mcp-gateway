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

export const RolloutSchema = z.any(); // TODO 14.1.0

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

export class RolloutError extends Error {}

export class RolloutCoordinator {
  constructor(_policy: Partial<RolloutPolicy> = {}, _opts: { now?: () => number } = {}) {}
  publish(_config: Record<string, unknown>, _opts: { force?: boolean } = {}): Generation {
    throw new Error('not implemented (14.1.0)');
  }
  current(): Generation | undefined {
    throw new Error('not implemented (14.1.0)');
  }
  targetFor(_nodeId: string): Generation | undefined {
    throw new Error('not implemented (14.1.0)');
  }
  report(_nodeId: string, _r: NodeReport): void {
    throw new Error('not implemented (14.1.0)');
  }
  tick(): void {
    throw new Error('not implemented (14.1.0)');
  }
  rollback(_to?: number, _reason?: string): Generation {
    throw new Error('not implemented (14.1.0)');
  }
  forget(_nodeId: string): void {
    throw new Error('not implemented (14.1.0)');
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  status(): any {
    throw new Error('not implemented (14.1.0)');
  }
}
