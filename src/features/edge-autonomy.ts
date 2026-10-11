/**
 * Edge autonomy (10.7; generally available since 14.6.0 "Edge Autonomy 正式化").
 *
 * An edge gateway keeps deciding on its own while an upstream (or the whole network) is unreachable, and reconciles
 * with the upstream once it is back:
 *
 * - **Local decisions** — rules matched on `server/tool` choose what a call does while its server is disconnected:
 *   - `cache` — answer with the last good result recorded for the same tool and arguments (within `maxAgeSeconds`);
 *   - `wasm` — run a local WASM tool of `features.edgeRuntime` instead (`wasmTool`);
 *   - `queue` — accept the call into a durable **outbox** and answer at once with a receipt; the call is replayed
 *     upstream on reconnect;
 *   - `deny` — refuse locally (`-32018`) with a clear message, e.g. for payments that must never be deferred.
 *   Policy (`policy.rules`, Cedar / OPA, quotas, budgets) still runs first: the gateway's local policy decides even
 *   when nothing upstream is reachable. A matching rule without a local answer (cache miss) fails with `-32018`
 *   instead of trying the unreachable upstream.
 * - **Offline permission boundaries (14.6.0)** — before any local answer, the call's offline risk is classified:
 *   a declared `policies[]` entry (`risk`, `offline: allow|deny`) wins, then MCP tool annotations (`readOnlyHint`,
 *   `destructiveHint`, `idempotentHint`), then the tool name (payments → critical; deletes and writes → high; reads →
 *   low; anything else → medium). High and critical calls are **denied offline by default** (`highRisk: deny`) unless
 *   a policy allows them: a cached "success" of a payment, or a deferred delete, is not something an edge decides alone.
 * - **Disconnected** means: the upstream is not `online` in the gateway's health registry, the `offline` feature says
 *   the network is gone (remote servers), an operator forced it (`POST /admin/edge-autonomy/connectivity`), or the
 *   call just failed with not-connected / timeout.
 * - **Queue (14.6.0)** — every queued call has a TTL (`policies[].ttlSeconds`, else `queue.ttlSeconds`); an expired
 *   call is never replayed (`queue.onExpiry`: parked for review, or dropped). `queue.maxItems` bounds the queue.
 *   Idempotency keys: the client's own key (`reconcile.idempotencyArg` in its arguments) or the outbox id; a repeated
 *   key with the same payload returns the first receipt, with another payload the call goes to the review queue.
 * - **Reconcile** — every `reconcile.intervalMs` (and on `POST /admin/edge-autonomy/reconcile`) queued calls whose
 *   server is connected again are replayed through the full pipeline, in queue order (a client's later calls to a
 *   server wait for its earlier ones). 14.6.0 makes it safe across crashes and revocations:
 *   - one reconciler at a time (a lease, `reconcile.leaseMs`) with a **fencing epoch**: a reconciler that was
 *     superseded stops before its next replay;
 *   - the **intent log** of 14.4 durable tasks (a `DurableKv` under `<dir>/.reconcile`): an intent is written before a
 *     replay and its commit after it, so a replay that committed is never sent again, and one that was in flight when
 *     the process died is resent (same key) only when the call is idempotent — otherwise it goes to review
 *     (`outcome-unknown`);
 *   - **revocations**: each replay runs under the caller's *current* credential (a key removed or re-scoped while the
 *     edge was offline does not act through the queue — MGW-2026-018), and is refused when the client id was revoked
 *     locally (portal / operator notices) or by a revocation authority (14.5 replicated revocations). Before replaying
 *     the edge asks the authorities to confirm they are fresh since reconnect (multi-region: one sync round with every
 *     peer); until they are, queued calls wait;
 *   - **conflicts**: a replay the upstream rejects as a conflict (or stale version), concurrent offline writes by
 *     different clients to the same record (`policies[].conflictKey`) and in-doubt non-idempotent replays go to the
 *     **review queue** (`GET /review`; an operator retries or drops them). Other failures are retried up to
 *     `maxAttempts`, then parked as `conflict` (10.7).
 * - **Sealed at rest (14.6.0)** — `outbox.json` / `cache.json` are AES-256-GCM sealed (key from `seal.keyEnv`, else a
 *   generated `<dir>/.seal.key`), written 0600 in a 0700 directory; a file that fails authentication is quarantined
 *   (`*.tampered-<ts>`) and never replayed.
 *
 * ```yaml
 * features:
 *   edgeAutonomy:
 *     dir: .mcp-gateway/edge            # persist outbox + last-good cache (relative to the config file)
 *     rules:                            # first match wins; unmatched calls fail as usual
 *       - { match: "crm/get_*",    action: cache, maxAgeSeconds: 86400 }
 *       - { match: "geo/distance", action: wasm,  wasmTool: distance }
 *       - { match: "crm/update_*", action: queue }
 *       - { match: "payments/*",   action: deny }
 *     policies:                         # 14.6.0: declared offline policy (first match)
 *       - { match: "crm/update_*", offline: allow, idempotent: true, conflictKey: [id], ttlSeconds: 3600 }
 *     highRisk: deny                    # default
 *     queue: { ttlSeconds: 86400, maxItems: 10000, onExpiry: review }
 *     reconcile: { intervalMs: 5000, maxAttempts: 5, idempotencyArg: idempotencyKey, leaseMs: 30000 }
 * ```
 *
 * @module features/edge-autonomy
 */

import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import { registerFeature, badRequest, objectBody, type FeatureContext } from '../gateway/features.js';
import { clientPrincipal, deniedPrincipal, type Principal } from '../auth/authorizer.js';
import { registerCallHook, type HookCall } from '../gateway/hooks.js';
import { confirmRevocations, onRevocation, revokedBy } from '../gateway/revocations.js';
import { registerMetricSource } from '../monitor/index.js';
import { globToRegExp } from '../utils/tool-filter.js';
import { ERR_NOT_CONNECTED, ERR_TIMEOUT } from '../proxy/index.js';
import type { GatewayConfig, ProxyResponse } from '../utils/types.js';
import { logger } from '../utils/logger.js';
import { DirKv, SimulatedCrash, StoreKv, type DurableKv } from '../orchestration/durable-tasks.js';
import { MemoryStateStore } from '../state/store.js';
import { ERR_EDGE_DENIED, type EdgeAutonomyConfig, EdgeAutonomySchema, RISKS, type OfflineRisk, Rule } from './schemas/edge-autonomy.js';
export { ERR_EDGE_DENIED, type EdgeAutonomyConfig, EdgeAutonomySchema } from './schemas/edge-autonomy.js';
import { EdgeRuntimeSchema } from './schemas/edge-runtime.js';
import { OfflineSchema } from './schemas/offline.js';
import { requireDependency } from '../gateway/kernel-runtime.js';
import { instanceLocal } from '../kernel/instance.js';
/** 14.0.0: per gateway instance (F3). */
const eaState = instanceLocal('edge-autonomy', 'eaState', () => ({
  liveCtx: undefined as FeatureContext | undefined,
  inflight: undefined as Promise<ReconcileResult> | undefined,
  kv: undefined as { key: string; kv: DurableKv } | undefined,
}));

// 13.0: declared dependencies (manifest dependsOn) instead of static imports of other feature modules.
const { callEdgeTool } = await requireDependency<typeof import('./edge-runtime.js')>('edge-autonomy', 'edge-runtime');
const { isOffline, isRemote } = await requireDependency<typeof import('./offline.js')>('edge-autonomy', 'offline');
type Parsed = z.output<typeof EdgeAutonomySchema>;
type RuleCfg = Parsed['rules'][number];
type PolicyCfg = Parsed['policies'][number];
void Rule;

/** Why an entry waits for an operator (14.6.0). */
export type ReviewReason = 'expired' | 'idempotency-conflict' | 'conflict-key' | 'upstream-conflict' | 'outcome-unknown';
/** Why an entry was refused for good (14.6.0): it is never executed. */
export type RejectReason = 'revoked' | 'credential-removed';

export interface OutboxEntry {
  id: string;
  at: string;
  clientId?: string;
  /** Principal of the queued call (11.1). 14.6.0: only a hint — the replay re-resolves the caller's current scope. */
  principal?: Principal;
  serverId: string;
  tool: string;
  args: Record<string, unknown>;
  /** 14.6.0: `review` waits for an operator, `rejected` is final (revoked / removed credential). */
  status: 'queued' | 'applied' | 'conflict' | 'review' | 'rejected';
  attempts: number;
  lastError?: string;
  appliedAt?: string;
  /** 14.6.0: queue order. */
  seq?: number;
  /** 14.6.0: not replayed after this time (ISO). */
  expiresAt?: string;
  /** 14.6.0: offline risk when queued. */
  risk?: OfflineRisk;
  /** 14.6.0: idempotency key sent to the upstream (the client's own, else the outbox id). */
  idempotencyKey?: string;
  /** 14.6.0: hash of the payload (idempotency-key reuse detection). */
  payloadHash?: string;
  /** 14.6.0: record identity (`policies[].conflictKey`) for concurrent-write detection. */
  conflict?: string;
  conflictWith?: string[];
  reviewReason?: ReviewReason | RejectReason;
  /** 14.6.0: an operator re-queued it: conflict-key checks are skipped, an in-doubt replay is resent. */
  operatorOverride?: boolean;
}
export interface Decision {
  at: string;
  serverId: string;
  tool: string;
  clientId?: string;
  action: RuleCfg['action'] | 'miss';
  reason: string;
  detail?: string;
  /** 14.6.0: offline risk of the call. */
  risk?: OfflineRisk;
}
interface CacheEntry {
  at: number;
  result: unknown;
}

const argsKey = (serverId: string, tool: string, args: unknown) => createHash('sha256').update(JSON.stringify([serverId, tool, sortKeys(args)])).digest('hex');
function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([k, x]) => [k, sortKeys(x)]));
  return v;
}

// ─── sealing (14.6.0) ────────────────────────────────────────────────────────────────────────────────────────────

/** A sealed file failed authentication (tampered, truncated, or sealed with another key). */
export class SealError extends Error {
  constructor(m: string) {
    super(m);
    this.name = 'SealError';
  }
}

function keyFrom(raw: string): Buffer | undefined {
  const t = raw.trim();
  const b = /^[0-9a-f]{64}$/i.test(t) ? Buffer.from(t, 'hex') : Buffer.from(t, 'base64');
  return b.length === 32 ? b : undefined;
}

/** AES-256-GCM sealing of the persisted edge state; the file kind is bound as associated data. */
export class Sealer {
  readonly source: 'env' | 'file';
  private readonly key: Buffer;
  constructor(dir: string, keyEnv?: string) {
    if (keyEnv) {
      const k = process.env[keyEnv] ? keyFrom(process.env[keyEnv]!) : undefined;
      if (!k) throw new SealError(`seal.keyEnv: environment variable ${keyEnv} must hold a 32-byte key (base64 or hex)`);
      this.key = k;
      this.source = 'env';
      return;
    }
    const f = join(dir, '.seal.key');
    if (existsSync(f)) {
      const k = keyFrom(readFileSync(f, 'utf8'));
      if (!k) throw new SealError(`${f} does not hold a 32-byte key`);
      this.key = k;
    } else {
      this.key = randomBytes(32);
      writeFileSync(f, this.key.toString('base64'), { mode: 0o600, flag: 'wx' });
    }
    this.source = 'file';
  }
  seal(kind: string, value: unknown): string {
    const iv = randomBytes(12);
    const c = createCipheriv('aes-256-gcm', this.key, iv);
    c.setAAD(Buffer.from(`mcp-gateway/edge/${kind}/v1`));
    const data = Buffer.concat([c.update(JSON.stringify(value), 'utf8'), c.final()]);
    return JSON.stringify({ v: 1, sealed: 'aes-256-gcm', kind, iv: iv.toString('base64'), tag: c.getAuthTag().toString('base64'), data: data.toString('base64') });
  }
  open(kind: string, text: string): unknown {
    let doc: { v?: number; sealed?: string; kind?: string; iv?: string; tag?: string; data?: string };
    try {
      doc = JSON.parse(text);
    } catch {
      throw new SealError(`${kind}: not a sealed document (tampered or truncated)`);
    }
    if (doc.sealed !== 'aes-256-gcm' || doc.kind !== kind || !doc.iv || !doc.tag || typeof doc.data !== 'string') throw new SealError(`${kind}: not a sealed ${kind} document (tampered)`);
    try {
      const d = createDecipheriv('aes-256-gcm', this.key, Buffer.from(doc.iv, 'base64'));
      d.setAAD(Buffer.from(`mcp-gateway/edge/${kind}/v1`));
      d.setAuthTag(Buffer.from(doc.tag, 'base64'));
      const out = Buffer.concat([d.update(Buffer.from(doc.data, 'base64')), d.final()]);
      return JSON.parse(out.toString('utf8'));
    } catch {
      throw new SealError(`${kind}: authentication failed (tampered, or sealed with another key)`);
    }
  }
}

// ─── metrics (14.6.0) ────────────────────────────────────────────────────────────────────────────────────────────

const RESULTS = ['applied', 'failed', 'conflict', 'rejected', 'review', 'expired', 'deduplicated', 'fenced'] as const;
type ResultKind = (typeof RESULTS)[number];
class EdgeMetrics {
  decisions: Record<string, number> = {};
  denied: Record<OfflineRisk, number> = { low: 0, medium: 0, high: 0, critical: 0 };
  reconcile: Record<ResultKind, number> = Object.fromEntries(RESULTS.map((r) => [r, 0])) as Record<ResultKind, number>;
  sealFailures = 0;
  outcomeUnknown = 0;
}

/** State of the edge-autonomy module (one per gateway instance). */
export class EdgeState {
  cache = new Map<string, CacheEntry>();
  outbox: OutboxEntry[] = [];
  decisions: Decision[] = [];
  /** Operator overrides: server id (or "*") → forced disconnected. */
  forced = new Set<string>();
  reconciling = false;
  /** 14.6.0: client ids revoked locally (core revocation notices), persisted with the outbox. */
  revoked = new Map<string, { at: string; reason?: string }>();
  /** 14.6.0: last queue sequence number. */
  seq = 0;
  /** 14.6.0: annotations seen per `server/tool` (the classifier still works while the upstream's tool list is gone). */
  annotations = new Map<string, Record<string, unknown>>();
  metrics = new EdgeMetrics();
  seal: { ok: boolean; error?: string; source?: 'env' | 'file' } = { ok: true };
  lastReconcile?: { at: string; result: ReconcileResult; epoch: number };
  epoch = 0;
  private loaded?: string;
  private sealer?: Sealer;
  dir?: string;

  load(dir: string | undefined, keyEnv?: string): void {
    this.dir = dir;
    const sig = dir ? `${dir}|${keyEnv ?? ''}` : undefined;
    if (!dir || this.loaded === sig) return;
    this.loaded = sig;
    try {
      ensureDir(dir);
      this.sealer = new Sealer(dir, keyEnv);
      this.seal = { ok: true, source: this.sealer.source };
    } catch (e) {
      this.sealer = undefined;
      this.seal = { ok: false, error: (e as Error).message };
      this.metrics.sealFailures++;
      logger.error(`edge-autonomy: cannot seal state in ${dir}: ${(e as Error).message} — nothing is persisted`);
      return;
    }
    const outbox = this.readSealed(dir, 'outbox');
    if (outbox !== undefined) {
      if (Array.isArray(outbox)) {
        // ≤ 14.5 plaintext layout: migrated once, then sealed
        this.outbox = outbox as OutboxEntry[];
        this.seq = this.outbox.length;
        this.outbox.forEach((e, i) => (e.seq ??= i + 1));
        logger.warn(`edge-autonomy: migrated the plaintext outbox in ${dir} to a sealed outbox`);
        this.persist('outbox');
      } else {
        const d = outbox as { entries?: OutboxEntry[]; seq?: number; revoked?: Record<string, { at: string; reason?: string }> };
        this.outbox = Array.isArray(d.entries) ? d.entries : [];
        this.seq = typeof d.seq === 'number' ? d.seq : this.outbox.length;
        this.revoked = new Map(Object.entries(d.revoked ?? {}));
      }
    }
    const cache = this.readSealed(dir, 'cache');
    if (cache && typeof cache === 'object') {
      this.cache = new Map(Object.entries(cache as Record<string, CacheEntry>));
      if (Array.isArray(cache)) this.cache.clear();
    }
  }

  /** Read `<kind>.json`: sealed (opened), legacy plaintext (returned as is, then re-sealed), or quarantined. */
  private readSealed(dir: string, kind: 'outbox' | 'cache'): unknown {
    const f = join(dir, `${kind}.json`);
    if (!existsSync(f)) return undefined;
    let text: string;
    try {
      text = readFileSync(f, 'utf8');
    } catch (e) {
      logger.warn(`edge-autonomy: could not read ${f}: ${(e as Error).message}`);
      return undefined;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = undefined;
    }
    const looksSealed = !!parsed && typeof parsed === 'object' && 'sealed' in (parsed as object);
    if (parsed !== undefined && !looksSealed && (kind === 'cache' || Array.isArray(parsed))) {
      if (kind === 'cache') {
        this.cache = new Map(Object.entries(parsed as Record<string, CacheEntry>));
        this.persist('cache');
      }
      return parsed;
    }
    try {
      return this.sealer!.open(kind, text);
    } catch (e) {
      const q = `${f}.tampered-${Date.now()}`;
      try {
        renameSync(f, q);
        chmodSync(q, 0o600);
      } catch {
        /* keep going: the file is ignored either way */
      }
      this.seal = { ...this.seal, ok: false, error: (e as Error).message };
      this.metrics.sealFailures++;
      logger.error(`edge-autonomy: ${(e as Error).message} — ${f} quarantined as ${q}; its entries are NOT replayed`);
      return undefined;
    }
  }

  persist(what: 'outbox' | 'cache'): void {
    if (!this.dir || !this.sealer) return;
    try {
      ensureDir(this.dir);
      const tmp = join(this.dir, `.${what}.${process.pid}.tmp`);
      const value = what === 'outbox' ? { entries: this.outbox, seq: this.seq, revoked: Object.fromEntries(this.revoked) } : Object.fromEntries(this.cache);
      writeFileSync(tmp, this.sealer.seal(what, value), { mode: 0o600 });
      renameSync(tmp, join(this.dir, `${what}.json`));
    } catch (e) {
      logger.warn(`edge-autonomy: ${what} write failed: ${(e as Error).message}`);
    }
  }

  decide(d: Omit<Decision, 'at'>): void {
    this.decisions.push({ at: new Date().toISOString(), ...d });
    if (this.decisions.length > 500) this.decisions.shift();
    this.metrics.decisions[d.action] = (this.metrics.decisions[d.action] ?? 0) + 1;
  }

  remember(c: Parsed, call: HookCall, result: unknown): void {
    this.cache.delete(argsKey(call.serverId, call.tool, call.args));
    this.cache.set(argsKey(call.serverId, call.tool, call.args), { at: Date.now(), result });
    while (this.cache.size > c.cacheEntries) this.cache.delete(this.cache.keys().next().value!);
    this.persist('cache');
  }

  reset(): void {
    this.cache.clear();
    this.outbox = [];
    this.decisions = [];
    this.forced.clear();
    this.revoked.clear();
    this.annotations.clear();
    this.seq = 0;
    this.epoch = 0;
    this.metrics = new EdgeMetrics();
    this.seal = { ok: true };
    this.lastReconcile = undefined;
    this.sealer = undefined;
    this.loaded = undefined;
    this.dir = undefined;
  }
}

function ensureDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    chmodSync(dir, 0o700); // an existing directory (≤ 14.5 created it with the umask)
  } catch {
    /* not ours to change */
  }
}

export const edgeState = instanceLocal('edge-autonomy', 'edgeState', () => new EdgeState()); // 14.0.0: per gateway instance (F3)
/** Argument objects of in-flight reconcile replays: never answered locally (a replay must reach the upstream). */
const replaying = new WeakSet<object>();

/**
 * Fault injection for the reconcile tests (process-wide; unset in production). `beforeReplay` runs before each replay
 * (`ctl.supersede()` makes another reconciler take the fencing epoch; a thrown error counts as a failed attempt),
 * `afterCommit` after the intent log committed a replay and before the queue is written (throw {@link SimulatedCrash}).
 */
export const edgeFaults: {
  beforeReplay?: (e: OutboxEntry, ctl: { index: number; supersede: () => Promise<void> }) => void | Promise<void>;
  afterCommit?: (e: OutboxEntry) => void;
} = {};

export function edgeAutonomyOf(cfg: GatewayConfig): Parsed | undefined {
  if (!cfg.edgeAutonomy) return undefined;
  const p = EdgeAutonomySchema.parse(cfg.edgeAutonomy);
  return p.enabled ? p : undefined;
}

const stateDir = (c: Parsed, cfg: GatewayConfig) => (c.dir ? resolve(cfg.configDir ?? process.cwd(), c.dir) : undefined);
const loadState = (c: Parsed, cfg: GatewayConfig) => edgeState.load(stateDir(c, cfg), c.seal.keyEnv);
const maxItems = (c: Parsed) => c.queue.maxItems ?? c.outboxLimit;

export function ruleFor(c: Parsed, serverId: string, tool: string): RuleCfg | undefined {
  return c.rules.find((r) => globToRegExp(r.match).test(`${serverId}/${tool}`));
}
export function policyFor(c: Parsed, serverId: string, tool: string): PolicyCfg | undefined {
  return c.policies.find((p) => globToRegExp(p.match).test(`${serverId}/${tool}`));
}

// ─── offline risk (14.6.0) ───────────────────────────────────────────────────────────────────────────────────────

const READ = new Set(['get', 'list', 'search', 'read', 'fetch', 'find', 'query', 'describe', 'lookup', 'show', 'view', 'count', 'check', 'status', 'head', 'browse', 'peek', 'inspect', 'export']);
const PAYMENT = new Set(['pay', 'payment', 'payments', 'charge', 'charges', 'refund', 'refunds', 'transfer', 'payout', 'payouts', 'purchase', 'checkout', 'withdraw', 'withdrawal', 'capture', 'debit', 'wire', 'remit']);
const DELETE = new Set(['delete', 'remove', 'destroy', 'drop', 'purge', 'wipe', 'erase', 'truncate', 'revoke', 'terminate', 'kill', 'archive', 'unlink', 'rm', 'del']);
const WRITE = new Set(['create', 'update', 'set', 'put', 'post', 'write', 'insert', 'upsert', 'patch', 'send', 'add', 'edit', 'modify', 'move', 'rename', 'publish', 'submit', 'approve', 'reject', 'cancel', 'book', 'order', 'assign', 'merge', 'commit', 'push', 'deploy', 'execute', 'exec', 'run', 'trigger', 'invoke', 'grant', 'reset', 'replace', 'save', 'store', 'upload', 'import', 'apply', 'enable', 'disable', 'start', 'stop', 'restart', 'close', 'open', 'sign', 'mint', 'issue', 'register', 'subscribe', 'unsubscribe', 'notify', 'email', 'message', 'reply', 'forward', 'transfer', 'schedule', 'reserve']);
const words = (tool: string) =>
  tool
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((w) => w.toLowerCase());
const rank = (r: OfflineRisk) => RISKS.indexOf(r);
const maxRisk = (a: OfflineRisk, b: OfflineRisk): OfflineRisk => (rank(a) >= rank(b) ? a : b);

/** Offline risk of `server/tool`: declared policy risk, else annotations, else tool-name heuristics (14.6.0). */
export function classifyOffline(c: Parsed, serverId: string, tool: string, annotations?: Record<string, unknown>): { risk: OfflineRisk; reasons: string[] } {
  const p = policyFor(c, serverId, tool);
  if (p?.risk) return { risk: p.risk, reasons: ['declared'] };
  const reasons: string[] = [];
  let risk: OfflineRisk = 'medium';
  const w = words(tool);
  const a = annotations ?? {};
  if (w.some((x) => PAYMENT.has(x))) {
    risk = 'critical';
    reasons.push('payment');
  }
  if (a.destructiveHint === true) {
    risk = maxRisk(risk, 'high');
    reasons.push('destructive');
  }
  if (a.readOnlyHint === true && !reasons.length) return { risk: 'low', reasons: ['read-only'] };
  if (a.readOnlyHint === false) {
    risk = maxRisk(risk, 'high');
    reasons.push('write');
  }
  if (a.readOnlyHint === undefined) {
    const readVerb = w.length > 0 && READ.has(w[0]!);
    if (w.some((x) => DELETE.has(x)) && !readVerb) {
      risk = maxRisk(risk, 'high');
      reasons.push('delete');
    } else if (w.some((x) => WRITE.has(x)) && !readVerb) {
      risk = maxRisk(risk, 'high');
      if (!reasons.includes('write')) reasons.push('write');
    } else if (readVerb && !reasons.length) return { risk: 'low', reasons: ['read'] };
  }
  if (a.idempotentHint === false && (a.readOnlyHint !== true || reasons.length)) {
    risk = maxRisk(risk, 'high');
    reasons.push('non-idempotent');
  }
  if (!reasons.length) reasons.push('unclassified');
  return { risk, reasons };
}

function annotationsOf(serverId: string, tool: string): Record<string, unknown> | undefined {
  const key = `${serverId}/${tool}`;
  try {
    const t = eaState.liveCtx?.tools().find((x) => x.serverId === serverId && x.name === tool);
    if (t?.annotations) edgeState.annotations.set(key, t.annotations);
  } catch {
    /* tool list unavailable */
  }
  return edgeState.annotations.get(key);
}

/** Whether `call` may be answered locally while its server is disconnected (14.6.0). */
export function offlineVerdict(c: Parsed, serverId: string, tool: string): { allowed: boolean; risk: OfflineRisk; reasons: string[]; why?: string } {
  const p = policyFor(c, serverId, tool);
  const { risk, reasons } = classifyOffline(c, serverId, tool, annotationsOf(serverId, tool));
  if (p?.offline === 'deny') return { allowed: false, risk, reasons, why: `"${serverId}/${tool}" is not allowed offline (offline policy "${p.match}")` };
  if (p?.offline === 'allow') return { allowed: true, risk, reasons };
  if (rank(risk) >= rank('high') && c.highRisk === 'deny')
    return { allowed: false, risk, reasons, why: `"${serverId}/${tool}" is a ${risk}-risk call (${reasons.join(', ')}) and high-risk calls are not allowed offline; declare an edgeAutonomy policy with offline: allow to permit it` };
  return { allowed: true, risk, reasons };
}

/** Why a server counts as disconnected right now (undefined = connected). */
export function disconnected(cfg: GatewayConfig, serverId: string): string | undefined {
  if (edgeState.forced.has('*') || edgeState.forced.has(serverId)) return 'forced by operator';
  const s = cfg.servers.find((x) => x.id === serverId);
  if (cfg.offline && s && isRemote(s)) {
    const o = OfflineSchema.parse(cfg.offline);
    if (o.enabled && isOffline(o) && !o.allowRemote.some((p) => globToRegExp(p).test(serverId))) return 'network offline';
  }
  const online = eaState.liveCtx?.onlineServers?.();
  if (online && s && !online.includes(serverId)) return 'upstream not connected';
  return undefined;
}

const textResult = (text: string, meta: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({ content: [{ type: 'text', text }], ...extra, _meta: { 'mcp-gateway/edge': meta } });
const deny = (code: number, message: string): ProxyResponse => ({ success: false, durationMs: 0, error: { code, message } });

// ─── intent log (14.4 DurableKv) ─────────────────────────────────────────────────────────────────────────────────

function kvFor(c: Parsed, cfg: GatewayConfig): DurableKv {
  const dir = stateDir(c, cfg);
  const key = dir ?? 'memory';
  if (eaState.kv?.key !== key) {
    if (dir) ensureDir(dir);
    eaState.kv = { key, kv: dir ? new DirKv(join(dir, '.reconcile')) : new StoreKv(new MemoryStateStore(), 'edge-autonomy:') };
  }
  return eaState.kv.kv;
}

const clientScope = (call: { clientId?: string; principal?: Principal }) => call.principal?.id ?? call.clientId ?? 'anonymous';

/** Decide locally for a disconnected server. `undefined` = no rule (fail as usual). */
export async function localDecision(c: Parsed, cfg: GatewayConfig, call: HookCall, reason: string): Promise<ProxyResponse | undefined> {
  const r = ruleFor(c, call.serverId, call.tool);
  if (!r) return undefined;
  const base = { serverId: call.serverId, tool: call.tool, clientId: call.clientId, reason };
  if (r.action !== 'deny') {
    // 14.6.0: offline permission boundary — before any local answer (a cached "success" is an answer too)
    const v = offlineVerdict(c, call.serverId, call.tool);
    if (!v.allowed) {
      edgeState.decide({ ...base, action: 'deny', risk: v.risk, detail: v.why });
      edgeState.metrics.denied[v.risk]++;
      return deny(ERR_EDGE_DENIED, v.why!);
    }
  }
  switch (r.action) {
    case 'cache': {
      const hit = edgeState.cache.get(argsKey(call.serverId, call.tool, call.args));
      if (!hit || Date.now() - hit.at > r.maxAgeSeconds * 1000) {
        edgeState.decide({ ...base, action: 'miss', detail: hit ? 'cached result too old' : 'no cached result' });
        return undefined;
      }
      edgeState.decide({ ...base, action: 'cache', detail: `age ${Math.round((Date.now() - hit.at) / 1000)} s` });
      const res = hit.result && typeof hit.result === 'object' ? (hit.result as Record<string, unknown>) : { value: hit.result };
      const meta = (res._meta && typeof res._meta === 'object' ? res._meta : {}) as Record<string, unknown>;
      return { success: true, durationMs: 0, result: { ...res, _meta: { ...meta, 'mcp-gateway/edge': { decision: 'cache', cachedAt: new Date(hit.at).toISOString(), reason } } } };
    }
    case 'wasm': {
      const er = cfg.edgeRuntime ? EdgeRuntimeSchema.parse(cfg.edgeRuntime) : undefined;
      const t = er?.enabled ? er.tools.find((x) => x.name === r.wasmTool) : undefined;
      if (!t) {
        edgeState.decide({ ...base, action: 'miss', detail: `edge runtime tool "${r.wasmTool}" is not configured` });
        return undefined;
      }
      const out = await callEdgeTool(t, call.args);
      edgeState.decide({ ...base, action: 'wasm', detail: out.ok ? `ran ${t.name}` : out.error?.message });
      if (!out.ok) return { success: false, durationMs: out.durationMs, error: { code: out.error!.code, message: out.error!.message } };
      const res = out.result as Record<string, unknown>;
      return { success: true, durationMs: out.durationMs, result: { ...res, _meta: { ...((res._meta as object) ?? {}), 'mcp-gateway/edge': { decision: 'wasm', tool: t.name, reason } } } };
    }
    case 'queue':
      return enqueue(c, cfg, call, reason, base);
    case 'deny':
      edgeState.decide({ ...base, action: 'deny' });
      return deny(ERR_EDGE_DENIED, r.message ?? `"${call.serverId}/${call.tool}" is not available while "${call.serverId}" is unreachable (${reason})`);
  }
}

async function enqueue(c: Parsed, cfg: GatewayConfig, call: HookCall, reason: string, base: Omit<Decision, 'at' | 'action'>): Promise<ProxyResponse> {
  const queued = edgeState.outbox.filter((e) => e.status === 'queued').length;
  if (queued >= maxItems(c)) {
    edgeState.decide({ ...base, action: 'deny', detail: 'queue full' });
    return deny(ERR_EDGE_DENIED, `Edge queue is full (${maxItems(c)} queued calls); "${call.serverId}" is unreachable (${reason})`);
  }
  const p = policyFor(c, call.serverId, call.tool);
  const now = Date.now();
  const id = `ob-${randomUUID()}`;
  const idemArg = c.reconcile.idempotencyArg;
  const own = idemArg && typeof call.args[idemArg] === 'string' && (call.args[idemArg] as string).length ? (call.args[idemArg] as string) : undefined;
  const payloadHash = argsKey(call.serverId, call.tool, idemArg ? Object.fromEntries(Object.entries(call.args).filter(([k]) => k !== idemArg)) : call.args);
  const { risk } = classifyOffline(c, call.serverId, call.tool, annotationsOf(call.serverId, call.tool));
  const e: OutboxEntry = {
    id,
    at: new Date(now).toISOString(),
    clientId: call.clientId,
    ...(call.principal ? { principal: call.principal } : {}),
    serverId: call.serverId,
    tool: call.tool,
    args: call.args,
    status: 'queued',
    attempts: 0,
    seq: ++edgeState.seq,
    expiresAt: new Date(now + (p?.ttlSeconds ?? c.queue.ttlSeconds) * 1000).toISOString(),
    risk,
    idempotencyKey: own ?? id,
    payloadHash,
  };
  if (p?.conflictKey) e.conflict = JSON.stringify([call.serverId, ...p.conflictKey.map((k) => call.args[k] ?? null)]);
  if (own) {
    // the client's own idempotency key, scoped to the caller (14.4 semantics): recorded in the intent log store
    const kv = kvFor(c, cfg);
    const k = `idem:${clientScope(call)}:${call.serverId}:${own}`;
    const prev = await kv.get(k);
    if (prev) {
      const { id: firstId, hash } = JSON.parse(prev) as { id: string; hash: string };
      if (hash === payloadHash && edgeState.outbox.some((x) => x.id === firstId)) {
        edgeState.decide({ ...base, action: 'queue', detail: `duplicate of ${firstId}` });
        return { success: true, durationMs: 0, result: textResult(`Already queued (receipt ${firstId}).`, { decision: 'queued', outboxId: firstId, duplicate: true, reason }, { structuredContent: { queued: true, outboxId: firstId, duplicate: true } }) };
      }
      e.status = 'review';
      e.reviewReason = 'idempotency-conflict';
      e.conflictWith = [firstId];
      e.lastError = `idempotency key "${own}" was used for another payload (${firstId})`;
    } else await kv.set(k, JSON.stringify({ id, hash: payloadHash }), (p?.ttlSeconds ?? c.queue.ttlSeconds) * 1000 + 86_400_000);
  }
  edgeState.outbox.push(e);
  edgeState.persist('outbox');
  edgeState.decide({ ...base, action: 'queue', risk, detail: e.status === 'review' ? `${id} (review: ${e.reviewReason})` : id });
  const review = e.status === 'review' ? { review: e.reviewReason } : {};
  return {
    success: true,
    durationMs: 0,
    result: textResult(
      e.status === 'review'
        ? `Queued for operator review: "${call.serverId}" is unreachable (${reason}) and ${e.lastError} (receipt ${id}).`
        : `Queued: "${call.serverId}" is unreachable (${reason}); the call will be replayed when it is back (receipt ${id}, expires ${e.expiresAt}).`,
      { decision: 'queued', outboxId: id, reason, expiresAt: e.expiresAt, ...review },
      { structuredContent: { queued: true, outboxId: id, expiresAt: e.expiresAt, ...review } },
    ),
  };
}

// ─── reconcile ───────────────────────────────────────────────────────────────────────────────────────────────────

type ReconcileResult = {
  applied: number;
  failed: number;
  conflicts: number;
  pending: number;
  /** 14.6.0 */
  rejected: number;
  review: number;
  expired: number;
  deduplicated: number;
  held: number;
  fenced: boolean;
  busy?: boolean;
  waiting?: string;
  epoch?: number;
};
const emptyResult = (): ReconcileResult => ({ applied: 0, failed: 0, conflicts: 0, pending: 0, rejected: 0, review: 0, expired: 0, deduplicated: 0, held: 0, fenced: false });

/** Context the replay needs from the gateway. */
export interface ReplayContext {
  invoke: FeatureContext['invoke'];
  principalFor?: (clientId: string | undefined) => Principal;
  resolveScope?: FeatureContext['resolveScope'];
}

/** The principal a replay runs as — the caller's *current* credential (14.6.0, MGW-2026-018), or why it may not run. */
export function replayPrincipal(rc: ReplayContext, e: OutboxEntry): { principal: Principal } | { reject: RejectReason; detail: string } {
  const ids = [e.clientId, e.principal?.id];
  for (const id of ids) if (id && edgeState.revoked.has(id)) return { reject: 'revoked', detail: `client ${id} was revoked (${edgeState.revoked.get(id)!.reason ?? 'revocation notice'})` };
  const by = revokedBy(ids);
  if (by) return { reject: 'revoked', detail: `client ${e.clientId ?? e.principal?.id} was revoked (${by})` };
  const p = e.principal;
  if (!p) {
    const r = rc.resolveScope?.(e.clientId);
    if (r && !r.known) return { reject: 'credential-removed', detail: `client ${e.clientId} no longer exists` };
    return { principal: (rc.principalFor ?? deniedPrincipal)(e.clientId) };
  }
  if (p.kind !== 'client' || !rc.resolveScope) return { principal: p };
  const r = rc.resolveScope(p.id);
  if (r === undefined) return { principal: p }; // the scope travels with the credential (JWT / OAuth)
  if (!r.known) return { reject: 'credential-removed', detail: `credential ${p.id} was removed while the call was queued` };
  return { principal: { ...clientPrincipal(p.id, r.scope), ...(p.delegation?.length ? { delegation: p.delegation } : {}) } };
}

const isRepeatable = (c: Parsed, e: OutboxEntry) => policyFor(c, e.serverId, e.tool)?.idempotent === true || edgeState.annotations.get(`${e.serverId}/${e.tool}`)?.idempotentHint === true;
const UPSTREAM_CONFLICT = /\b(conflict|precondition|stale|version mismatch|version conflict|etag|409|412)\b/i;
const ERR_REGION_STALE = -32027;
const ERR_REGION_REVOKED = -32028;

/**
 * Replay queued outbox entries whose server is reachable again. Runs are serialized: a call made while a reconcile is
 * already running (e.g. the background loop) joins it and returns that run's result instead of reporting zeros.
 */
export async function reconcile(cfg: GatewayConfig, invoke: FeatureContext['invoke'] | ReplayContext, principalFor: (clientId: string | undefined) => Principal = deniedPrincipal): Promise<ReconcileResult> {
  if (!edgeAutonomyOf(cfg)) return emptyResult();
  if (eaState.inflight) return eaState.inflight;
  const rc: ReplayContext = typeof invoke === 'function' ? { invoke, principalFor } : invoke;
  eaState.inflight = reconcileOnce(cfg, rc);
  try {
    return await eaState.inflight;
  } finally {
    eaState.inflight = undefined;
  }
}

async function reconcileOnce(cfg: GatewayConfig, rc: ReplayContext): Promise<ReconcileResult> {
  const c = edgeAutonomyOf(cfg)!;
  loadState(c, cfg);
  const out = emptyResult();
  const kv = kvFor(c, cfg);
  if (!(await kv.claim('reconcile:lease', c.reconcile.leaseMs))) return { ...out, busy: true };
  // fencing epoch: bumped under the lease (a plain counter, no per-run files)
  const bump = async () => {
    const n = Number((await kv.get('reconcile:epoch')) ?? 0) + 1;
    await kv.set('reconcile:epoch', String(n));
    return n;
  };
  const epoch = await bump();
  await kv.set('reconcile:lease-owner', String(epoch));
  edgeState.epoch = epoch;
  out.epoch = epoch;
  const current = async () => Number(await kv.get('reconcile:epoch')) === epoch;
  edgeState.reconciling = true;
  let crashed = false;
  const count = (k: ResultKind, n = 1) => (edgeState.metrics.reconcile[k] += n);
  try {
    const now = Date.now();
    // 1. expiry: an expired call is never replayed
    for (const e of [...edgeState.outbox]) {
      if (e.status !== 'queued' || !e.expiresAt || Date.parse(e.expiresAt) > now) continue;
      out.expired++;
      count('expired');
      if (c.queue.onExpiry === 'drop') edgeState.outbox = edgeState.outbox.filter((x) => x !== e);
      else Object.assign(e, { status: 'review', reviewReason: 'expired', lastError: `expired at ${e.expiresAt} before it could be replayed` });
    }
    const queue = edgeState.outbox.filter((e) => e.status === 'queued').sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
    const ready = queue.filter((e) => !disconnected(cfg, e.serverId));
    // 2. revocations learned on reconnect come first
    if (ready.length && c.reconcile.requireFreshRevocations) {
      const conf = await confirmRevocations(now);
      if (!conf.fresh) {
        out.pending += queue.length;
        out.waiting = `revocations not confirmed fresh: ${conf.detail ?? 'unknown'}`;
        return out;
      }
    }
    // 3. replay in order, fenced
    const blocked = new Set<string>();
    let index = 0;
    for (const e of queue) {
      const lane = `${clientScope(e)}|${e.serverId}`;
      if (disconnected(cfg, e.serverId)) {
        out.pending++;
        blocked.add(lane);
        continue;
      }
      if (blocked.has(lane)) {
        out.held++;
        continue;
      }
      const who = replayPrincipal(rc, e);
      if ('reject' in who) {
        Object.assign(e, { status: 'rejected', reviewReason: who.reject, lastError: who.detail });
        out.rejected++;
        count('rejected');
        edgeState.persist('outbox');
        continue;
      }
      if (e.conflict && !e.operatorOverride) {
        const mine = clientScope(e);
        const others = edgeState.outbox.filter(
          (x) => x !== e && x.conflict === e.conflict && clientScope(x) !== mine && ((x.status === 'queued' && (x.seq ?? 0) < (e.seq ?? 0)) || (x.status === 'applied' && x.appliedAt && x.appliedAt > e.at)),
        );
        if (others.length) {
          Object.assign(e, { status: 'review', reviewReason: 'conflict-key', conflictWith: others.map((x) => x.id), lastError: `concurrent offline writes to the same record by another client (${others.map((x) => x.id).join(', ')})` });
          out.review++;
          count('review');
          edgeState.persist('outbox');
          continue;
        }
      }
      if (!(await current())) {
        out.fenced = true;
        count('fenced');
        break;
      }
      if (edgeFaults.beforeReplay) {
        try {
          await edgeFaults.beforeReplay(e, { index, supersede: async () => void (await bump()) });
        } catch (err) {
          if (err instanceof SimulatedCrash) throw err;
          e.attempts++;
          e.lastError = (err as Error).message;
          out.failed++;
          count('failed');
          blocked.add(lane);
          index++;
          continue;
        }
        if (!(await current())) {
          out.fenced = true;
          count('fenced');
          break;
        }
      }
      index++;
      // intent log: committed → never again; in doubt → resend only when repeatable
      const ikey = `edge:${e.id}`;
      if (await kv.get(`result:${ikey}`)) {
        Object.assign(e, { status: 'applied', appliedAt: e.appliedAt ?? new Date().toISOString() });
        delete e.lastError;
        out.deduplicated++;
        count('deduplicated');
        edgeState.persist('outbox');
        continue;
      }
      const intent = await kv.get(`intent:${ikey}`);
      if (intent && (JSON.parse(intent) as { state: string }).state === 'started' && !e.operatorOverride && !isRepeatable(c, e)) {
        Object.assign(e, { status: 'review', reviewReason: 'outcome-unknown', lastError: 'the gateway stopped while this call was being replayed; it may or may not have run upstream' });
        edgeState.metrics.outcomeUnknown++;
        out.review++;
        count('review');
        edgeState.persist('outbox');
        continue;
      }
      await kv.set(`intent:${ikey}`, JSON.stringify({ state: 'started', epoch, at: Date.now() }));
      if (!(await current())) {
        // Dekker-style: a reconciler that took over either sees this intent or we see its epoch
        out.fenced = true;
        count('fenced');
        break;
      }
      e.attempts++;
      edgeState.persist('outbox');
      const args = c.reconcile.idempotencyArg ? { ...e.args, [c.reconcile.idempotencyArg]: e.idempotencyKey ?? e.id } : { ...e.args };
      replaying.add(args);
      let r: ProxyResponse;
      try {
        r = await rc.invoke(e.serverId, e.tool, args, who.principal, e.clientId);
      } catch (err) {
        r = { success: false, durationMs: 0, error: { code: -32603, message: (err as Error).message } };
      }
      if (r.success) {
        await kv.set(`result:${ikey}`, '1', 400 * 86_400_000);
        await kv.set(`intent:${ikey}`, JSON.stringify({ state: 'committed', epoch, at: Date.now() }));
        edgeFaults.afterCommit?.(e);
        e.status = 'applied';
        e.appliedAt = new Date().toISOString();
        delete e.lastError;
        delete e.reviewReason;
        out.applied++;
        count('applied');
      } else {
        await kv.set(`intent:${ikey}`, JSON.stringify({ state: 'failed', epoch, at: Date.now() }));
        const code = r.error?.code;
        e.lastError = r.error?.message ?? 'failed';
        if (code === ERR_REGION_REVOKED) {
          Object.assign(e, { status: 'rejected', reviewReason: 'revoked' });
          out.rejected++;
          count('rejected');
        } else if (code === ERR_REGION_STALE) {
          e.attempts--; // not the call's fault: the region cannot confirm revocations yet
          out.pending++;
          blocked.add(lane);
        } else if (UPSTREAM_CONFLICT.test(e.lastError)) {
          Object.assign(e, { status: 'review', reviewReason: 'upstream-conflict' });
          out.review++;
          count('review');
        } else if (e.attempts >= c.reconcile.maxAttempts) {
          e.status = 'conflict';
          out.conflicts++;
          count('conflict');
        } else {
          out.failed++;
          count('failed');
          blocked.add(lane);
        }
      }
      edgeState.persist('outbox');
    }
    // keep the last 1000 applied entries for the record
    const applied = edgeState.outbox.filter((e) => e.status === 'applied');
    if (applied.length > 1000) {
      const drop = new Set(applied.slice(0, applied.length - 1000).map((e) => e.id));
      edgeState.outbox = edgeState.outbox.filter((e) => !drop.has(e.id));
    }
    edgeState.persist('outbox');
  } catch (err) {
    if (err instanceof SimulatedCrash) crashed = true;
    throw err;
  } finally {
    edgeState.reconciling = false;
    if (!crashed) {
      // release the lease unless another reconciler claimed it since (it then owns it)
      if ((await kv.get('reconcile:lease-owner').catch(() => undefined)) === String(epoch)) await kv.del('reconcile:lease').catch(() => undefined);
      edgeState.lastReconcile = { at: new Date().toISOString(), result: { ...out }, epoch };
    }
  }
  return out;
}

// ─── report / metrics ────────────────────────────────────────────────────────────────────────────────────────────

const byStatus = () => {
  const n = { queued: 0, applied: 0, conflict: 0, review: 0, rejected: 0 };
  for (const e of edgeState.outbox) n[e.status]++;
  return n;
};
const oldestQueuedAge = () => {
  const q = edgeState.outbox.filter((e) => e.status === 'queued');
  return q.length ? Math.max(0, Math.round((Date.now() - Math.min(...q.map((e) => Date.parse(e.at)))) / 1000)) : 0;
};

export function edgeReport(cfg: GatewayConfig): Record<string, unknown> | undefined {
  const c = edgeAutonomyOf(cfg);
  if (!c) return undefined;
  const s = byStatus();
  return {
    highRisk: c.highRisk,
    persisted: !!c.dir,
    seal: edgeState.seal,
    servers: cfg.servers.map((x) => ({ id: x.id, disconnected: disconnected(cfg, x.id) ?? null })),
    forced: [...edgeState.forced],
    policies: c.policies,
    queue: { ...s, maxItems: maxItems(c), ttlSeconds: c.queue.ttlSeconds, onExpiry: c.queue.onExpiry, oldestAgeSeconds: oldestQueuedAge() },
    denied: { ...edgeState.metrics.denied },
    decisions: { ...edgeState.metrics.decisions },
    reconcile: { epoch: edgeState.epoch, last: edgeState.lastReconcile ?? null, totals: { ...edgeState.metrics.reconcile }, outcomeUnknown: edgeState.metrics.outcomeUnknown, requireFreshRevocations: c.reconcile.requireFreshRevocations },
    revocations: edgeState.revoked.size,
    cache: { entries: edgeState.cache.size },
  };
}

function prometheus(): string[] {
  const s = byStatus();
  const m = edgeState.metrics;
  const out = ['# HELP mcp_gateway_edge_queue_items Edge outbox entries by status', '# TYPE mcp_gateway_edge_queue_items gauge'];
  for (const [k, v] of Object.entries(s)) out.push(`mcp_gateway_edge_queue_items{status="${k}"} ${v}`);
  out.push('# HELP mcp_gateway_edge_queue_oldest_age_seconds Age of the oldest queued call', '# TYPE mcp_gateway_edge_queue_oldest_age_seconds gauge', `mcp_gateway_edge_queue_oldest_age_seconds ${oldestQueuedAge()}`);
  out.push('# HELP mcp_gateway_edge_decisions_total Local decisions while disconnected', '# TYPE mcp_gateway_edge_decisions_total counter');
  for (const [k, v] of Object.entries(m.decisions)) out.push(`mcp_gateway_edge_decisions_total{action="${k}"} ${v}`);
  out.push('# HELP mcp_gateway_edge_offline_denied_total Calls denied offline by the permission boundary, by risk', '# TYPE mcp_gateway_edge_offline_denied_total counter');
  for (const r of RISKS) out.push(`mcp_gateway_edge_offline_denied_total{risk="${r}"} ${m.denied[r]}`);
  out.push('# HELP mcp_gateway_edge_reconcile_total Reconcile outcomes per entry', '# TYPE mcp_gateway_edge_reconcile_total counter');
  for (const r of RESULTS) out.push(`mcp_gateway_edge_reconcile_total{result="${r}"} ${m.reconcile[r]}`);
  out.push('# HELP mcp_gateway_edge_outcome_unknown_total Replays in flight when the gateway stopped', '# TYPE mcp_gateway_edge_outcome_unknown_total counter', `mcp_gateway_edge_outcome_unknown_total ${m.outcomeUnknown}`);
  out.push('# HELP mcp_gateway_edge_seal_failures_total Sealed state files that failed authentication', '# TYPE mcp_gateway_edge_seal_failures_total counter', `mcp_gateway_edge_seal_failures_total ${m.sealFailures}`);
  return out;
}

registerCallHook(
  {
    id: 'edge-autonomy',
    before: async (call, cfg) => {
      const c = edgeAutonomyOf(cfg);
      if (!c) return;
      loadState(c, cfg);
      if (replaying.has(call.args)) return; // reconcile replay: must reach the upstream
      const reason = disconnected(cfg, call.serverId);
      if (!reason) return;
      const r = await localDecision(c, cfg, call, reason);
      if (!r) {
        // A rule matched but had no local answer (cache miss, WASM tool missing): fail clearly instead of trying an
        // upstream that is known to be unreachable.
        if (!ruleFor(c, call.serverId, call.tool)) return;
        return { refuse: { code: ERR_EDGE_DENIED, message: `"${call.serverId}" is unreachable (${reason}) and no local answer is available for ${call.tool}`, data: { decision: 'edge', server: call.serverId, reason } } };
      }
      if (!r.success) return { refuse: { code: r.error!.code, message: r.error!.message, data: { decision: 'edge', server: call.serverId, reason } } };
      return { respond: r };
    },
    after: async (call, result, cfg) => {
      const c = edgeAutonomyOf(cfg);
      if (!c) return;
      const rule = ruleFor(c, call.serverId, call.tool);
      if (!rule) return;
      annotationsOf(call.serverId, call.tool); // remember annotations while the upstream is reachable
      const edgeMeta = (result.result as { _meta?: Record<string, unknown> } | undefined)?._meta?.['mcp-gateway/edge'];
      if (result.success) {
        if (rule.action === 'cache' && !edgeMeta) edgeState.remember(c, call, result.result);
        return;
      }
      // The upstream dropped during the call: decide locally now (not for reconcile replays).
      if (!replaying.has(call.args) && (result.error?.code === ERR_NOT_CONNECTED || result.error?.code === ERR_TIMEOUT)) {
        const local = await localDecision(c, cfg, call, result.error.code === ERR_TIMEOUT ? 'upstream timed out' : 'upstream not connected');
        if (local) return local;
      }
    },
  },
  { first: true },
);

registerFeature({
  id: 'edge-autonomy',
  since: '10.7.0',
  summary: 'Edge autonomy: offline permission boundaries, local cache / WASM / queue / deny decisions while an upstream is unreachable, sealed queue with expiry, fenced reconcile that honours revocations',
  mount: (router, ctx) => {
    eaState.liveCtx = ctx;
    const rc: ReplayContext = { invoke: ctx.invoke, principalFor: ctx.principalFor, resolveScope: ctx.resolveScope };
    let timer: NodeJS.Timeout | undefined;
    let stopped = false;
    // 14.6.0: local revocation notices (developer portal, operator) are remembered with the queue
    const unsubscribe = onRevocation((clientId, reason) => {
      const c = edgeAutonomyOf(ctx.config());
      if (!c) return;
      loadState(c, ctx.config());
      edgeState.revoked.set(clientId, { at: new Date().toISOString(), ...(reason ? { reason } : {}) });
      edgeState.persist('outbox');
    });
    registerMetricSource('edge-autonomy', () => (edgeAutonomyOf(ctx.config()) ? prometheus() : []));
    const loop = async () => {
      const c = edgeAutonomyOf(ctx.config());
      if (c) loadState(c, ctx.config());
      if (c && edgeState.outbox.some((e) => e.status === 'queued')) await reconcile(ctx.config(), rc).catch((e: unknown) => logger.warn(`edge-autonomy: reconcile failed: ${(e as Error).message}`));
      if (!stopped) {
        timer = setTimeout(() => void loop(), c?.reconcile.intervalMs ?? 5000);
        timer.unref?.();
      }
    };
    if (edgeAutonomyOf(ctx.config())) {
      timer = setTimeout(() => void loop(), 100);
      timer.unref?.();
    }
    ctx.onStop?.(() => {
      stopped = true;
      unsubscribe();
      if (timer) clearTimeout(timer);
      if (eaState.liveCtx === ctx) eaState.liveCtx = undefined;
    });
    const conf = (res: import('express').Response): Parsed | undefined => {
      const c = edgeAutonomyOf(ctx.config());
      if (!c) badRequest(res, 'features.edgeAutonomy is not configured');
      else loadState(c, ctx.config());
      return c;
    };
    router.get('/', (_req, res) => {
      const c = conf(res);
      if (!c) return;
      const cfg = ctx.config();
      const s = byStatus();
      res.json({
        experimental: false,
        persisted: !!c.dir,
        seal: edgeState.seal,
        highRisk: c.highRisk,
        servers: cfg.servers.map((x) => ({ id: x.id, disconnected: disconnected(cfg, x.id) ?? null })),
        forced: [...edgeState.forced],
        rules: c.rules,
        policies: c.policies,
        cache: { entries: edgeState.cache.size },
        outbox: { queued: s.queued, applied: s.applied, conflicts: s.conflict, review: s.review, rejected: s.rejected },
      });
    });
    router.get('/report', (_req, res) => {
      if (!conf(res)) return;
      res.json(edgeReport(ctx.config()));
    });
    router.get('/decisions', (_req, res) => {
      if (!conf(res)) return;
      res.json({ decisions: [...edgeState.decisions].reverse() });
    });
    router.post('/connectivity', (req, res) => {
      const b = objectBody(req, res);
      if (!b) return;
      if (!conf(res)) return;
      const servers = b.servers === undefined ? ['*'] : b.servers;
      if (!Array.isArray(servers) || !servers.every((s) => typeof s === 'string')) return badRequest(res, '"servers" must be an array of server ids (default: all)');
      if (typeof b.disconnected !== 'boolean') return badRequest(res, '"disconnected" must be true or false');
      for (const s of servers as string[]) b.disconnected ? edgeState.forced.add(s) : edgeState.forced.delete(s);
      if (!b.disconnected && servers.includes('*')) edgeState.forced.clear();
      res.json({ forced: [...edgeState.forced] });
    });
    router.get('/outbox', (req, res) => {
      if (!conf(res)) return;
      const status = typeof req.query.status === 'string' ? req.query.status : undefined;
      res.json({ entries: edgeState.outbox.filter((e) => !status || e.status === status) });
    });
    router.get('/review', (_req, res) => {
      if (!conf(res)) return;
      res.json({ entries: edgeState.outbox.filter((e) => e.status === 'review' || e.status === 'conflict') });
    });
    router.post('/reconcile', async (_req, res) => {
      if (!conf(res)) return;
      try {
        res.json(await reconcile(ctx.config(), rc));
      } catch (e) {
        res.status(500).json({ error: 'Internal Server Error', message: (e as Error).message });
      }
    });
    router.post('/outbox/:id/retry', (req, res) => {
      const c = conf(res);
      if (!c) return;
      const e = edgeState.outbox.find((x) => x.id === req.params.id);
      if (!e) return void res.status(404).json({ error: 'Not Found', message: `no outbox entry ${req.params.id}` });
      if (e.status !== 'conflict' && e.status !== 'review')
        return void res.status(409).json({ error: 'Conflict', message: e.status === 'rejected' ? `entry was rejected (${e.reviewReason}); a revoked or removed credential's call is never replayed` : `entry is ${e.status}` });
      const expired = e.expiresAt && Date.parse(e.expiresAt) <= Date.now();
      Object.assign(e, { status: 'queued', attempts: 0, operatorOverride: true }, expired ? { expiresAt: new Date(Date.now() + (policyFor(c, e.serverId, e.tool)?.ttlSeconds ?? c.queue.ttlSeconds) * 1000).toISOString() } : {});
      delete e.reviewReason;
      edgeState.persist('outbox');
      res.json(e);
    });
    router.delete('/outbox/:id', (req, res) => {
      if (!conf(res)) return;
      const i = edgeState.outbox.findIndex((x) => x.id === req.params.id);
      if (i < 0) return void res.status(404).json({ error: 'Not Found', message: `no outbox entry ${req.params.id}` });
      const [e] = edgeState.outbox.splice(i, 1);
      edgeState.persist('outbox');
      res.json({ deleted: e!.id });
    });
  },
});
