/**
 * Edge autonomy (10.7, EXPERIMENTAL).
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
 * - **Disconnected** means: the upstream is not `online` in the gateway's health registry, the `offline` feature says
 *   the network is gone (remote servers), an operator forced it (`POST /admin/edge-autonomy/connectivity`), or the
 *   call just failed with not-connected / timeout.
 * - **Reconcile** — every `reconcile.intervalMs` (and on `POST /admin/edge-autonomy/reconcile`) queued calls whose
 *   server is connected again are replayed through the full pipeline as the original client, oldest first. With
 *   `reconcile.idempotencyArg` each replay carries the outbox id in that argument so the upstream can de-duplicate.
 *   A replay that fails is retried up to `maxAttempts`, then marked `conflict` for an operator (`GET /outbox`,
 *   `POST /outbox/:id/retry`, `DELETE /outbox/:id`).
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
 *     reconcile: { intervalMs: 5000, maxAttempts: 5, idempotencyArg: idempotencyKey }
 * ```
 *
 * EXPERIMENTAL: there is no conflict *resolution* (a replay that the upstream rejects is parked, not merged), queued
 * calls are answered before they ran (callers get a receipt, not a result), and cached answers can be stale by up to
 * `maxAgeSeconds`. Use it for tools where those trade-offs are acceptable.
 *
 * @module features/edge-autonomy
 */

import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import { registerFeature, badRequest, objectBody, type FeatureContext } from '../gateway/features.js';
import { deniedPrincipal, type Principal } from '../auth/authorizer.js';
import { registerCallHook, type HookCall } from '../gateway/hooks.js';
import { globToRegExp } from '../utils/tool-filter.js';
import { EdgeRuntimeSchema, callEdgeTool } from './edge-runtime.js';
import { OfflineSchema, isOffline, isRemote } from './offline.js';
import { ERR_NOT_CONNECTED, ERR_TIMEOUT } from '../proxy/index.js';
import type { GatewayConfig, ProxyResponse } from '../utils/types.js';
import { logger } from '../utils/logger.js';

/** Same code as the offline feature: refused because the network / upstream is gone. */
export const ERR_EDGE_DENIED = -32018;

const Rule = z
  .object({
    match: z.string().min(1),
    action: z.enum(['cache', 'wasm', 'queue', 'deny']),
    maxAgeSeconds: z.number().int().min(1).max(365 * 86_400).default(86_400),
    wasmTool: z.string().min(1).optional(),
    message: z.string().optional(),
  })
  .strict()
  .refine((r) => r.action !== 'wasm' || r.wasmTool, { message: 'action: wasm needs "wasmTool" (a features.edgeRuntime tool name)' });

export const EdgeAutonomySchema = z
  .object({
    enabled: z.boolean().default(true),
    dir: z.string().min(1).optional(),
    rules: z.array(Rule).min(1),
    cacheEntries: z.number().int().min(1).max(100_000).default(1000),
    outboxLimit: z.number().int().min(1).max(100_000).default(10_000),
    reconcile: z
      .object({
        intervalMs: z.number().int().min(100).max(3_600_000).default(5000),
        maxAttempts: z.number().int().min(1).max(100).default(5),
        idempotencyArg: z.string().min(1).optional(),
      })
      .strict()
      .default({}),
  })
  .strict();
export type EdgeAutonomyConfig = z.input<typeof EdgeAutonomySchema>;
type Parsed = z.output<typeof EdgeAutonomySchema>;
type RuleCfg = Parsed['rules'][number];

export interface OutboxEntry {
  id: string;
  at: string;
  clientId?: string;
  /** Principal of the queued call (11.1): the replay is authorized as this caller again. */
  principal?: Principal;
  serverId: string;
  tool: string;
  args: Record<string, unknown>;
  status: 'queued' | 'applied' | 'conflict';
  attempts: number;
  lastError?: string;
  appliedAt?: string;
}
export interface Decision {
  at: string;
  serverId: string;
  tool: string;
  clientId?: string;
  action: RuleCfg['action'] | 'miss';
  reason: string;
  detail?: string;
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

/** State of the edge-autonomy module (one per process). */
export class EdgeState {
  cache = new Map<string, CacheEntry>();
  outbox: OutboxEntry[] = [];
  decisions: Decision[] = [];
  /** Operator overrides: server id (or "*") → forced disconnected. */
  forced = new Set<string>();
  reconciling = false;
  private loaded?: string;
  dir?: string;

  load(dir: string | undefined): void {
    this.dir = dir;
    if (!dir || this.loaded === dir) return;
    this.loaded = dir;
    try {
      if (existsSync(join(dir, 'outbox.json'))) this.outbox = JSON.parse(readFileSync(join(dir, 'outbox.json'), 'utf8')) as OutboxEntry[];
      if (existsSync(join(dir, 'cache.json'))) this.cache = new Map(Object.entries(JSON.parse(readFileSync(join(dir, 'cache.json'), 'utf8')) as Record<string, CacheEntry>));
    } catch (e) {
      logger.warn(`edge-autonomy: could not load state from ${dir}: ${(e as Error).message}`);
    }
  }

  persist(what: 'outbox' | 'cache'): void {
    if (!this.dir) return;
    try {
      mkdirSync(this.dir, { recursive: true });
      const tmp = join(this.dir, `.${what}.tmp`);
      writeFileSync(tmp, JSON.stringify(what === 'outbox' ? this.outbox : Object.fromEntries(this.cache)));
      renameSync(tmp, join(this.dir, `${what}.json`));
    } catch (e) {
      logger.warn(`edge-autonomy: ${what} write failed: ${(e as Error).message}`);
    }
  }

  decide(d: Omit<Decision, 'at'>): void {
    this.decisions.push({ at: new Date().toISOString(), ...d });
    if (this.decisions.length > 500) this.decisions.shift();
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
    this.loaded = undefined;
    this.dir = undefined;
  }
}

export const edgeState = new EdgeState();
/** Argument objects of in-flight reconcile replays: never answered locally (a replay must reach the upstream). */
const replaying = new WeakSet<object>();
let liveCtx: FeatureContext | undefined;

export function edgeAutonomyOf(cfg: GatewayConfig): Parsed | undefined {
  if (!cfg.edgeAutonomy) return undefined;
  const p = EdgeAutonomySchema.parse(cfg.edgeAutonomy);
  return p.enabled ? p : undefined;
}

export function ruleFor(c: Parsed, serverId: string, tool: string): RuleCfg | undefined {
  return c.rules.find((r) => globToRegExp(r.match).test(`${serverId}/${tool}`));
}

/** Why a server counts as disconnected right now (undefined = connected). */
export function disconnected(cfg: GatewayConfig, serverId: string): string | undefined {
  if (edgeState.forced.has('*') || edgeState.forced.has(serverId)) return 'forced by operator';
  const s = cfg.servers.find((x) => x.id === serverId);
  if (cfg.offline && s && isRemote(s)) {
    const o = OfflineSchema.parse(cfg.offline);
    if (o.enabled && isOffline(o) && !o.allowRemote.some((p) => globToRegExp(p).test(serverId))) return 'network offline';
  }
  const online = liveCtx?.onlineServers?.();
  if (online && s && !online.includes(serverId)) return 'upstream not connected';
  return undefined;
}

const textResult = (text: string, meta: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({ content: [{ type: 'text', text }], ...extra, _meta: { 'mcp-gateway/edge': meta } });

/** Decide locally for a disconnected server. `undefined` = no rule (fail as usual). */
export async function localDecision(c: Parsed, cfg: GatewayConfig, call: HookCall, reason: string): Promise<ProxyResponse | undefined> {
  const r = ruleFor(c, call.serverId, call.tool);
  if (!r) return undefined;
  const base = { serverId: call.serverId, tool: call.tool, clientId: call.clientId, reason };
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
    case 'queue': {
      if (edgeState.outbox.filter((e) => e.status === 'queued').length >= c.outboxLimit) {
        edgeState.decide({ ...base, action: 'deny', detail: 'outbox full' });
        return { success: false, durationMs: 0, error: { code: ERR_EDGE_DENIED, message: `Edge outbox is full (${c.outboxLimit} queued calls); "${call.serverId}" is unreachable (${reason})` } };
      }
      const e: OutboxEntry = { id: `ob-${randomUUID()}`, at: new Date().toISOString(), clientId: call.clientId, ...(call.principal ? { principal: call.principal } : {}), serverId: call.serverId, tool: call.tool, args: call.args, status: 'queued', attempts: 0 };
      edgeState.outbox.push(e);
      edgeState.persist('outbox');
      edgeState.decide({ ...base, action: 'queue', detail: e.id });
      return { success: true, durationMs: 0, result: textResult(`Queued: "${call.serverId}" is unreachable (${reason}); the call will be replayed when it is back (receipt ${e.id}).`, { decision: 'queued', outboxId: e.id, reason }, { structuredContent: { queued: true, outboxId: e.id } }) };
    }
    case 'deny':
      edgeState.decide({ ...base, action: 'deny' });
      return { success: false, durationMs: 0, error: { code: ERR_EDGE_DENIED, message: r.message ?? `"${call.serverId}/${call.tool}" is not available while "${call.serverId}" is unreachable (${reason})` } };
  }
}

/** Replay queued calls whose server is connected again. */
export async function reconcile(cfg: GatewayConfig, invoke: FeatureContext['invoke'], principalFor: (clientId: string | undefined) => Principal = deniedPrincipal): Promise<{ applied: number; failed: number; conflicts: number; pending: number }> {
  const c = edgeAutonomyOf(cfg);
  const out = { applied: 0, failed: 0, conflicts: 0, pending: 0 };
  if (!c || edgeState.reconciling) return out;
  edgeState.reconciling = true;
  try {
    for (const e of edgeState.outbox) {
      if (e.status !== 'queued') continue;
      if (disconnected(cfg, e.serverId)) {
        out.pending++;
        continue;
      }
      e.attempts++;
      const args = c.reconcile.idempotencyArg ? { ...e.args, [c.reconcile.idempotencyArg]: e.id } : { ...e.args };
      replaying.add(args);
      let r: ProxyResponse;
      try {
        // 11.1: replayed under the principal that queued the call (re-authorized now), else the client's current scope.
        r = await invoke(e.serverId, e.tool, args, e.principal ?? principalFor(e.clientId), e.clientId);
      } catch (err) {
        r = { success: false, durationMs: 0, error: { code: -32603, message: (err as Error).message } };
      }
      if (r.success) {
        e.status = 'applied';
        e.appliedAt = new Date().toISOString();
        delete e.lastError;
        out.applied++;
      } else {
        e.lastError = r.error?.message ?? 'failed';
        if (e.attempts >= c.reconcile.maxAttempts) {
          e.status = 'conflict';
          out.conflicts++;
        } else out.failed++;
      }
    }
    // keep the last 1000 applied entries for the record
    const applied = edgeState.outbox.filter((e) => e.status === 'applied');
    if (applied.length > 1000) {
      const drop = new Set(applied.slice(0, applied.length - 1000).map((e) => e.id));
      edgeState.outbox = edgeState.outbox.filter((e) => !drop.has(e.id));
    }
    edgeState.persist('outbox');
  } finally {
    edgeState.reconciling = false;
  }
  return out;
}

registerCallHook(
  {
    id: 'edge-autonomy',
    before: async (call, cfg) => {
      const c = edgeAutonomyOf(cfg);
      if (!c) return;
      edgeState.load(c.dir ? resolve(cfg.configDir ?? process.cwd(), c.dir) : undefined);
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
  summary: 'Edge autonomy (EXPERIMENTAL): local cache / WASM / queue / deny decisions while an upstream is unreachable, outbox reconcile on reconnect',
  mount: (router, ctx) => {
    liveCtx = ctx;
    let timer: NodeJS.Timeout | undefined;
    let stopped = false;
    const loop = async () => {
      const c = edgeAutonomyOf(ctx.config());
      if (c && edgeState.outbox.some((e) => e.status === 'queued')) await reconcile(ctx.config(), ctx.invoke, ctx.principalFor).catch((e: unknown) => logger.warn(`edge-autonomy: reconcile failed: ${(e as Error).message}`));
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
      if (timer) clearTimeout(timer);
      if (liveCtx === ctx) liveCtx = undefined;
    });
    const conf = (res: import('express').Response): Parsed | undefined => {
      const c = edgeAutonomyOf(ctx.config());
      if (!c) badRequest(res, 'features.edgeAutonomy is not configured');
      else edgeState.load(c.dir ? resolve(ctx.config().configDir ?? process.cwd(), c.dir) : undefined);
      return c;
    };
    router.get('/', (_req, res) => {
      const c = conf(res);
      if (!c) return;
      const cfg = ctx.config();
      res.json({
        experimental: true,
        persisted: !!c.dir,
        servers: cfg.servers.map((s) => ({ id: s.id, disconnected: disconnected(cfg, s.id) ?? null })),
        forced: [...edgeState.forced],
        rules: c.rules,
        cache: { entries: edgeState.cache.size },
        outbox: { queued: edgeState.outbox.filter((e) => e.status === 'queued').length, applied: edgeState.outbox.filter((e) => e.status === 'applied').length, conflicts: edgeState.outbox.filter((e) => e.status === 'conflict').length },
      });
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
    router.post('/reconcile', async (_req, res) => {
      if (!conf(res)) return;
      res.json(await reconcile(ctx.config(), ctx.invoke, ctx.principalFor));
    });
    router.post('/outbox/:id/retry', (req, res) => {
      if (!conf(res)) return;
      const e = edgeState.outbox.find((x) => x.id === req.params.id);
      if (!e) return void res.status(404).json({ error: 'Not Found', message: `no outbox entry ${req.params.id}` });
      if (e.status !== 'conflict') return void res.status(409).json({ error: 'Conflict', message: `entry is ${e.status}` });
      Object.assign(e, { status: 'queued', attempts: 0 });
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
