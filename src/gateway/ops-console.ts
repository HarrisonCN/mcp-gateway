/**
 * Operations console (14.8.0) — `/api/v1/admin/ops/*`, configured by `controlPlane.console`.
 *
 * - `GET  /admin/ops/cluster` — one cluster status view: role, config generations, data planes (in sync / diverged),
 *   regions (freshness, replication lag), edge gateways (queued calls), plugin circuits, DLQ counts, servers, modules.
 * - `GET  /admin/ops/traces[?limit&client&server&tool&outcome=ok|denied|error]` — recent call traces, newest first.
 * - `GET  /admin/ops/traces/:requestId` — one call end to end: auth → tenant → policy → plugins → route → upstream →
 *   cache → response, each step with its time and status, the W3C trace id of the gateway span (the OTel span the
 *   invoker already emits) and, for a refused call, the denial explanation.
 * - `POST /admin/ops/explain` — `{ client, server, tool, arguments? }`: would this call be allowed, and if not which
 *   layer / rule / tenant / permission refuses it and where that lives in the config (`configPath`).
 * - `GET  /admin/ops/timeline[?kind&since&until&subject&limit]` — incident timeline: restarts, config applies, GitOps
 *   releases, revocations, plugin circuit opens, region staleness, refusals (audit), newest first.
 * - `POST /admin/ops/troubleshoot` — guided checks for one call (upstream reachability, auth / key, tenancy, policy via
 *   the 14.7 simulation, rate limits, plugin health) → a redacted report, kept for sharing at
 *   `GET /admin/ops/reports/:id`.
 *
 * RBAC: operators (unscoped keys) see everything and may run the wizard; clients matching `controlPlane.console.viewers`
 * get the read-only views (cluster, traces, explain, timeline, reports). Nothing here returns key material, secret
 * values or call arguments. With `explainDenials: true` an operator request that sends `X-MCP-Explain: 1` gets the
 * explanation in the error data of a refused call too; other clients never do.
 *
 * Request data (client ids, request ids, tool names) only ever keys `Map`s, never plain objects.
 *
 * @module gateway/ops-console
 */

import { randomUUID } from 'node:crypto';
import express, { type Request, type RequestHandler, type Response } from 'express';
import { ipKeyGenerator, rateLimit } from 'express-rate-limit';
import { z } from 'zod';
import type { GatewayConfig, RequestMetric } from '../utils/types.js';
import type { Principal } from '../auth/authorizer.js';
import { authorize } from '../auth/authorizer.js';
import { evaluatePolicy } from '../policy/tool-policy.js';
import { globToRegExp } from '../utils/tool-filter.js';
import { redactString } from '../security/redact.js';
import { TIMELINE_KINDS, emitOpsEvent, opsListeners, opsSources, type OpsEvent, type OpsListener } from './ops-events.js';
import { onRevocation } from './revocations.js';
import { simulateDecision } from '../config/gitops.js';
import { VERSION } from '../utils/version.js';

// ─── config ──────────────────────────────────────────────────────────────────────────────────────────────────────

export const OpsConsoleSchema = z
  .object({
    /** Serve `/api/v1/admin/ops/*` (default true). */
    enabled: z.boolean().default(true),
    /** Client id globs (e.g. `key:oncall`) with read-only console access. */
    viewers: z.array(z.string().min(1).max(200)).max(100).default([]),
    /** Call traces kept in memory (default 500). */
    traceBuffer: z.number().int().min(10).max(100_000).default(500),
    /** Timeline events kept in memory (default 1000). */
    timelineBuffer: z.number().int().min(10).max(100_000).default(1000),
    /** Add the denial explanation to refused-call error data for operator requests sending `X-MCP-Explain: 1`. */
    explainDenials: z.boolean().default(false),
  })
  .strict();
export type OpsConsoleConfig = z.input<typeof OpsConsoleSchema>;

type OpsSettings = z.output<typeof OpsConsoleSchema>;
const DEFAULT_SETTINGS: OpsSettings = OpsConsoleSchema.parse({});
const settingsCache = new WeakMap<object, OpsSettings>();
/** Effective `controlPlane.console` settings (memoized per config section object). */
export function opsSettings(cfg: GatewayConfig): OpsSettings {
  const raw = (cfg.controlPlane as { console?: unknown } | undefined)?.console;
  if (!raw || typeof raw !== 'object') return DEFAULT_SETTINGS;
  let s = settingsCache.get(raw);
  if (!s) {
    const r = OpsConsoleSchema.safeParse(raw);
    s = r.success ? r.data : { ...DEFAULT_SETTINGS, enabled: false }; // an invalid section never widens access
    settingsCache.set(raw, s);
  }
  return s;
}

// ─── events (timeline) — see gateway/ops-events ─────────────────────────────────────────────────────────────────

export { TIMELINE_KINDS, emitOpsEvent, registerOpsSource, type OpsEvent, type TimelineKind } from './ops-events.js';

/** Bounded event ring of one gateway. */
export class OpsTimeline {
  private readonly events: OpsEvent[] = [];
  private readonly off: () => void;
  constructor(private readonly size: () => number) {
    const fn: OpsListener = (e) => this.push(e);
    const set = opsListeners;
    set.add(fn);
    const offRev = onRevocation((clientId, reason) => emitOpsEvent({ kind: 'revocation', severity: 'warning', subject: clientId, detail: reason ?? 'credential revoked', source: 'revocations' }));
    this.off = () => {
      set.delete(fn);
      offRev();
    };
  }
  push(e: OpsEvent): void {
    this.events.push(e);
    const max = this.size();
    if (this.events.length > max) this.events.splice(0, this.events.length - max);
  }
  list(): OpsEvent[] {
    return [...this.events];
  }
  stop(): void {
    this.off();
  }
}

// ─── traces ──────────────────────────────────────────────────────────────────────────────────────────────────────

export const TRACE_STEPS = ['auth', 'tenant', 'policy', 'plugins', 'route', 'upstream', 'cache', 'response'] as const;
export type TraceStep = (typeof TRACE_STEPS)[number];
/** Which pipeline stage (gateway/stages) times each console step. */
const STEP_STAGE: Record<TraceStep, string> = { auth: 'auth', tenant: 'authz', policy: 'policy', plugins: 'hooks', route: 'routing', upstream: 'upstream', cache: 'cache', response: 'finish' };

export interface TraceInput {
  requestId: string;
  serverId: string;
  tool: string;
  kind: string;
  via: string;
  clientId?: string;
  traceparent?: string;
  success: boolean;
  durationMs: number;
  errorCode?: number;
  errorMessage?: string;
  data?: Record<string, unknown>;
  stages: ReadonlyMap<string, number>;
  notes: ReadonlyMap<string, string>;
  totalMs: number;
  authMs?: number;
}

export interface CallTrace {
  requestId: string;
  at: string;
  serverId: string;
  tool: string;
  kind: string;
  via: string;
  clientId?: string;
  traceId?: string;
  traceparent?: string;
  success: boolean;
  outcome: 'ok' | 'denied' | 'error';
  decision?: string;
  errorCode?: number;
  error?: string;
  totalMs: number;
  steps: Array<{ step: TraceStep; status: 'ok' | 'denied' | 'error' | 'skipped'; ms: number | null; note?: string }>;
  explain?: DenialExplanation;
}

const r3 = (x: number) => Math.round(x * 1000) / 1000;

/** The console step a refusal decision belongs to. */
function stepOfDecision(decision: string | undefined, data: Record<string, unknown> | undefined): TraceStep {
  switch (decision) {
    case 'forbidden':
    case 'cross-tenant':
    case 'scope':
    case 'tenant-role':
    case 'delegation':
      return 'tenant';
    case 'deny':
    case 'approve':
    case 'residency':
    case 'quota':
    case 'budget':
    case 'error':
      return data && typeof data.plugin === 'string' ? 'plugins' : 'policy';
    case 'module-failed':
      return 'plugins';
    case 'reroute-denied':
    case 'snapshot-mismatch':
    case 'reroute-loop':
    case 'args-unstable':
      return 'route';
    case 'upstream-error':
    case undefined:
      return 'upstream';
    default:
      return 'plugins'; // a feature module's own refusal (dlp, sanitize, …)
  }
}

export class TraceStore {
  private readonly traces = new Map<string, CallTrace>();
  constructor(private readonly size: () => number) {}

  add(t: CallTrace): void {
    this.traces.set(t.requestId, t);
    const max = this.size();
    while (this.traces.size > max) {
      const first = this.traces.keys().next().value;
      if (first === undefined) break;
      this.traces.delete(first);
    }
  }
  get(id: string): CallTrace | undefined {
    return this.traces.get(id);
  }
  list(): CallTrace[] {
    return [...this.traces.values()].reverse();
  }
}

/** Build a trace from one finished invocation. */
export function buildTrace(i: TraceInput, cfg: GatewayConfig): CallTrace {
  const decision = i.success ? undefined : typeof i.data?.decision === 'string' ? i.data.decision : typeof i.data?.reason === 'string' ? i.data.reason : i.errorCode !== undefined ? 'upstream-error' : undefined;
  const refused = !i.success && decision !== undefined && decision !== 'upstream-error';
  const failedAt = i.success ? undefined : refused ? stepOfDecision(decision, i.data) : 'upstream';
  const failIdx = failedAt ? TRACE_STEPS.indexOf(failedAt) : -1;
  const cacheNote = i.notes.get('cache');
  const steps = TRACE_STEPS.map((step, idx) => {
    const stage = STEP_STAGE[step];
    const ms = step === 'auth' ? (i.authMs === undefined ? null : r3(i.authMs)) : i.stages.has(stage) ? r3(i.stages.get(stage)!) : null;
    let status: 'ok' | 'denied' | 'error' | 'skipped' = 'ok';
    if (failIdx >= 0 && idx === failIdx) status = refused ? 'denied' : 'error';
    else if (failIdx >= 0 && idx > failIdx && step !== 'response') status = 'skipped';
    else if (step === 'cache' && (!cacheNote || cacheNote === 'bypass') && ms === null) status = 'skipped';
    else if (ms === null && step !== 'auth' && step !== 'response') status = i.success ? 'skipped' : status;
    const note = step === 'cache' ? cacheNote : step === 'route' ? i.notes.get('route') : step === 'auth' && ms === null ? 'authenticated at the HTTP layer (not timed for this interface)' : undefined;
    return { step, status, ms, ...(note ? { note } : {}) };
  });
  const tp = i.traceparent && /^[\da-f]{2}-([\da-f]{32})-[\da-f]{16}-[\da-f]{2}$/.exec(i.traceparent);
  return {
    requestId: i.requestId,
    at: new Date().toISOString(),
    serverId: i.serverId,
    tool: i.tool,
    kind: i.kind,
    via: i.via,
    ...(i.clientId ? { clientId: i.clientId } : {}),
    ...(tp ? { traceId: tp[1], traceparent: i.traceparent } : {}),
    success: i.success,
    outcome: i.success ? 'ok' : refused ? 'denied' : 'error',
    ...(decision ? { decision } : {}),
    ...(i.errorCode !== undefined ? { errorCode: i.errorCode } : {}),
    ...(i.errorMessage ? { error: redactString(i.errorMessage).slice(0, 500) } : {}),
    totalMs: r3(i.totalMs),
    steps,
    ...(refused ? { explain: explainDenial({ clientId: i.clientId, serverId: i.serverId, tool: i.tool }, decision, i.data ?? {}, i.errorMessage ?? '', cfg) } : {}),
  };
}

// ─── denial explanation ──────────────────────────────────────────────────────────────────────────────────────────

export interface DenialExplanation {
  decision: string;
  layer: 'exposure' | 'scope' | 'tenant' | 'delegation' | 'policy' | 'approval' | 'plugin' | 'residency' | 'quota' | 'budget' | 'module' | 'route' | 'server' | 'unknown';
  reason: string;
  client?: string;
  rule?: string;
  policy?: string;
  tenant?: string;
  permission?: string;
  configPath?: string;
}

type KeyEntry = string | { key?: string; name?: string; servers?: string[]; tools?: string[]; scope?: { servers?: string[]; tools?: string[] } };

/** Index of the API key behind a `key:<name>` client id (never compares or returns key material). */
function keyIndex(cfg: GatewayConfig, clientId: string | undefined): number {
  if (!clientId?.startsWith('key:')) return -1;
  const name = clientId.slice(4);
  const keys = ((cfg.auth as { apiKeys?: KeyEntry[] } | undefined)?.apiKeys ?? []) as KeyEntry[];
  return keys.findIndex((k) => typeof k === 'object' && k !== null && k.name === name);
}

function ruleIndex(cfg: GatewayConfig, rule: string | undefined): number {
  if (!rule) return -1;
  const rules = (cfg.policy as { rules?: Array<{ name?: string }> } | undefined)?.rules ?? [];
  const byName = rules.findIndex((r) => r?.name === rule);
  if (byName >= 0) return byName;
  const m = /^#(\d+)$/.exec(rule);
  return m ? Number(m[1]) - 1 : -1;
}

function tenantOfViewer(cfg: GatewayConfig, clientId: string | undefined, serverId: string): number {
  const tenants = (cfg.tenants ?? []) as Array<{ id: string; servers?: string[]; members?: Array<{ client: string; role: string }> }>;
  return tenants.findIndex((t) => (t.members ?? []).some((m) => m.role === 'viewer' && clientId !== undefined && globToRegExp(m.client).test(clientId)) && (t.servers ?? []).some((g) => globToRegExp(g).test(serverId)));
}

/** Why a call was refused, and where that decision lives in the config. Pure; never returns secrets. */
export function explainDenial(call: { clientId?: string; serverId: string; tool: string }, decision: string | undefined, data: Record<string, unknown>, message: string, cfg: GatewayConfig): DenialExplanation {
  const base = { decision: decision ?? 'refused', reason: redactString(message).slice(0, 500), ...(call.clientId ? { client: call.clientId } : {}) };
  const reason = typeof data.reason === 'string' ? data.reason : undefined;
  const rule = typeof data.rule === 'string' ? data.rule : undefined;
  if (decision === 'forbidden' || decision === 'cross-tenant') {
    if (reason === 'not-exposed') {
      const i = (cfg.servers ?? []).findIndex((s) => s.id === call.serverId);
      return { ...base, layer: 'exposure', permission: 'tool exposure', ...(i >= 0 ? { configPath: `servers[${i}].tools` } : {}) };
    }
    if (decision === 'cross-tenant' || reason === 'cross-tenant') {
      return { ...base, layer: 'tenant', ...(typeof data.owner === 'string' ? { tenant: data.owner } : {}), permission: 'cross-tenant access', configPath: 'tenancy.isolation' };
    }
    if (reason === 'tenant-role') {
      const t = tenantOfViewer(cfg, call.clientId, call.serverId);
      const tenants = cfg.tenants as Array<{ id: string }> | undefined;
      return { ...base, layer: 'tenant', permission: 'tools/call (admin or owner role)', ...(t >= 0 ? { tenant: tenants![t]!.id, configPath: `tenants[${t}].members` } : { configPath: 'tenants' }) };
    }
    if (reason === 'delegation') return { ...base, layer: 'delegation', permission: 'delegated tools', ...(typeof data.agent === 'string' ? { policy: data.agent } : {}), configPath: 'features.agentIdentity' };
    if (reason === 'scope') {
      const i = keyIndex(cfg, call.clientId);
      const field = /^Server /.test(message) ? 'servers' : 'tools';
      return { ...base, layer: 'scope', permission: field === 'servers' ? `server ${call.serverId}` : `tool ${call.serverId}/${call.tool}`, configPath: i >= 0 ? `auth.apiKeys[${i}].scope.${field}` : call.clientId?.startsWith('key:') ? 'auth.apiKeys' : 'tenants (or the token claims mcp_servers / mcp_tools)' };
    }
    return { ...base, layer: 'unknown' };
  }
  if (decision === 'deny' || decision === 'approve' || decision === 'error') {
    if (typeof data.plugin === 'string') {
      const i = ((cfg.plugins ?? []) as Array<{ name?: string; module?: string } | string>).findIndex((p) => (typeof p === 'string' ? p : p?.name ?? p?.module) === data.plugin);
      return { ...base, layer: 'plugin', policy: data.plugin, ...(i >= 0 ? { configPath: `plugins[${i}]` } : { configPath: 'plugins' }) };
    }
    const i = ruleIndex(cfg, rule);
    return { ...base, layer: decision === 'approve' ? 'approval' : 'policy', ...(rule ? { rule } : {}), ...(i >= 0 ? { configPath: `policy.rules[${i}]` } : { configPath: 'policy.default' }) };
  }
  if (decision === 'residency') return { ...base, layer: 'residency', configPath: 'compliance.residency' };
  if (decision === 'quota') return { ...base, layer: 'quota', ...(typeof data.quota === 'string' ? { rule: data.quota } : {}), configPath: 'quotas' };
  if (decision === 'budget') return { ...base, layer: 'budget', ...(typeof data.budget === 'string' ? { rule: data.budget } : {}), configPath: 'costs.budgets' };
  if (decision === 'module-failed') return { ...base, layer: 'module', ...(typeof data.module === 'string' ? { policy: data.module } : {}), configPath: 'modules.failurePolicy' };
  if (decision === 'reroute-denied' || decision === 'snapshot-mismatch' || decision === 'reroute-loop' || decision === 'args-unstable') return { ...base, layer: 'route', configPath: 'routing' };
  if (decision) return { ...base, layer: 'module', policy: decision, configPath: `features.${decision.replace(/-([a-z])/g, (_m, c: string) => c.toUpperCase())}` };
  return { ...base, layer: 'unknown' };
}

/** Would this call be allowed? The authorizer, then the tool policy — the order the gateway applies them. */
export function explainCall(cfg: GatewayConfig, principal: Principal, call: { clientId: string; serverId: string; tool: string; args: Record<string, unknown> }, deps: { serverExists: (id: string) => boolean; exposed: (serverId: string, tool: string) => boolean }): { allowed: boolean; checked: string[] } & Partial<DenialExplanation> {
  const checked: string[] = ['server'];
  if (!deps.serverExists(call.serverId)) return { allowed: false, checked, decision: 'forbidden', layer: 'server', reason: `server "${call.serverId}" is not configured`, client: call.clientId, configPath: 'servers' };
  checked.push('exposure', 'scope', 'tenant', 'delegation');
  const d = authorize(principal, { serverId: call.serverId, name: call.tool, kind: 'tool' }, { exposed: deps.exposed });
  if (d) return { allowed: false, checked, ...explainDenial(call, typeof d.data.decision === 'string' ? d.data.decision : 'forbidden', d.data, d.message, cfg) };
  checked.push('policy');
  const p = evaluatePolicy(cfg.policy, { clientId: call.clientId, serverId: call.serverId, tool: call.tool, args: call.args });
  if (p.effect !== 'allow') {
    const msg = p.message ?? (p.effect === 'deny' ? `Tool call denied by policy${p.rule ? ` (rule ${p.rule})` : ''}` : `Tool call needs approval${p.rule ? ` (rule ${p.rule})` : ''}`);
    return { allowed: false, checked, ...explainDenial(call, p.effect, { rule: p.rule }, msg, cfg) };
  }
  return { allowed: true, checked, ...(p.rule ? { rule: p.rule } : {}) };
}

// ─── router ──────────────────────────────────────────────────────────────────────────────────────────────────────

export interface OpsDeps {
  config: () => GatewayConfig;
  authenticate: RequestHandler;
  isOperator: (req: Request) => boolean;
  traces: TraceStore;
  timeline: OpsTimeline;
  recent: (limit?: number) => RequestMetric[];
  principalFor: (clientId: string) => Principal;
  resolveClient: (clientId: string) => { known: boolean } | undefined;
  generations: () => { current: number; alive: number; pinned: Record<string, number>; committed: number; rollbacks: number };
  committedAt: () => string;
  dataPlanes: () => { total: number; online: number; inSync: number; diverged: Array<{ nodeId: string; status: string; configEtag?: string }> };
  dataPlane?: () => unknown;
  edges: () => Array<{ edgeId: string; lastSeen: string; queuedCalls: number; errors: number }>;
  plugins: () => Array<{ name: string; circuit: string; failures: number; refusals: number; failure: string; lastError?: string }>;
  servers: () => Array<{ id: string; status: string }>;
  serverInfo: (id: string) => { exists: boolean; connected: boolean; status?: string; tools: string[] } ;
  exposed: (serverId: string, tool: string) => boolean;
  failedModules: () => string[];
  portable: () => Record<string, unknown>;
}

const MAX_REPORTS = 200;
/** Troubleshooting runs per minute per client (express-rate-limit, in memory per instance). */
export const TROUBLESHOOT_PER_MINUTE = 30;

/** Clients that may read the console: operators, and `controlPlane.console.viewers`. */
export function consoleRole(req: Request, cfg: GatewayConfig, isOperator: (req: Request) => boolean): 'operator' | 'viewer' | undefined {
  if (isOperator(req)) return 'operator';
  const id = (req as Request & { clientId?: string }).clientId;
  if (!id) return undefined;
  return opsSettings(cfg).viewers.some((g) => globToRegExp(g).test(id)) ? 'viewer' : undefined;
}

/** Replace every leaf value with `<redacted>` (keys are kept so the report shows the shape of the call). */
function redactArgs(v: unknown, depth = 0): unknown {
  if (depth > 6) return '<redacted>';
  if (Array.isArray(v)) return v.slice(0, 50).map((x) => redactArgs(x, depth + 1));
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v as Record<string, unknown>).slice(0, 100).map(([k, x]) => [k, redactArgs(x, depth + 1)]));
  return '<redacted>';
}

const str = (v: unknown, max = 200): string | undefined => (typeof v === 'string' && v.length > 0 && v.length <= max ? v : undefined);

export function createOpsConsoleRouter(deps: OpsDeps): express.Router {
  const router = express.Router();
  const reports = new Map<string, Record<string, unknown>>();
  const cfg = deps.config;

  const enabled: RequestHandler = (_req, res, next) => (opsSettings(cfg()).enabled ? next() : void res.status(404).json({ error: 'Not Found', message: 'The operations console is disabled (controlPlane.console.enabled: false)' }));
  const reader: RequestHandler = (req, res, next) =>
    consoleRole(req, cfg(), deps.isOperator) ? next() : void res.status(403).json({ error: 'Forbidden', message: 'The operations console is for operators and console viewers (controlPlane.console.viewers)' });
  const operator: RequestHandler = (req, res, next) =>
    deps.isOperator(req) ? next() : void res.status(403).json({ error: 'Forbidden', message: 'The troubleshooting wizard is for operators (unscoped keys)' });
  const noStore: RequestHandler = (_req, res, next) => (res.set('Cache-Control', 'no-store'), next());
  // The troubleshooting wizard runs the central authorizer, the policy simulation and a scan of recent calls per request,
  // and keeps a report: cap it per caller (operator key, else client IP) at TROUBLESHOOT_PER_MINUTE runs a minute.
  const troubleshootLimit = rateLimit({
    windowMs: 60_000,
    limit: TROUBLESHOOT_PER_MINUTE,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    keyGenerator: (req) => {
      const id = (req as Request & { clientId?: string }).clientId;
      return id ? `client:${id}` : `ip:${ipKeyGenerator(req.ip ?? '')}`;
    },
    validate: { xForwardedForHeader: false, trustProxy: false },
    handler: (_req, res) => void res.status(429).json({ error: 'Too Many Requests', message: `The troubleshooting wizard allows ${TROUBLESHOOT_PER_MINUTE} runs per minute per client; try again shortly` }),
  });
  const ops = express.Router();
  router.use('/admin/ops', enabled, deps.authenticate, reader, noStore, ops);

  ops.get('/cluster', async (_req, res) => {
    const c = cfg();
    const g = deps.generations();
    const regionsSrc = opsSources.get('regions');
    const dlqSrc = opsSources.get('dlq');
    const safe = async (fn: (() => unknown) | undefined) => {
      if (!fn) return null;
      try {
        return (await fn()) ?? null;
      } catch (e) {
        return { error: redactString(e instanceof Error ? e.message : String(e)) };
      }
    };
    const edges = deps.edges();
    const plugins = deps.plugins();
    const servers = deps.servers();
    res.json({
      version: VERSION,
      role: c.controlPlane?.role ?? 'all',
      generation: { current: g.current, committedAt: deps.committedAt(), alive: g.alive, committed: g.committed, rollbacks: g.rollbacks },
      dataPlanes: deps.dataPlanes(),
      ...(deps.dataPlane ? { dataPlane: deps.dataPlane() } : {}),
      regions: await safe(regionsSrc),
      edges: { total: edges.length, queued: edges.reduce((a, e) => a + (e.queuedCalls || 0), 0), nodes: edges.map((e) => ({ edgeId: e.edgeId, lastSeen: e.lastSeen, queuedCalls: e.queuedCalls, errors: e.errors })) },
      plugins: {
        total: plugins.length,
        open: plugins.filter((p) => p.circuit !== 'closed').map((p) => p.name),
        list: plugins.map((p) => ({ name: p.name, circuit: p.circuit, failures: p.failures, refusals: p.refusals, failure: p.failure, ...(p.lastError ? { lastError: redactString(p.lastError).slice(0, 300) } : {}) })),
      },
      dlq: await safe(dlqSrc),
      servers: { total: servers.length, online: servers.filter((s) => s.status === 'online').length, offline: servers.filter((s) => s.status !== 'online').map((s) => s.id) },
      modules: { failed: deps.failedModules() },
    });
  });

  ops.get('/traces', (req, res) => {
    const q = req.query;
    const limit = Math.min(500, Math.max(1, Number(q.limit) || 50));
    const client = str(q.client);
    const server = str(q.server);
    const tool = str(q.tool);
    const outcome = str(q.outcome);
    if (outcome && !['ok', 'denied', 'error'].includes(outcome)) return void res.status(400).json({ error: 'Bad Request', message: 'outcome must be ok, denied or error' });
    const list = deps.traces
      .list()
      .filter((t) => (!client || t.clientId === client) && (!server || t.serverId === server) && (!tool || t.tool === tool) && (!outcome || t.outcome === outcome))
      .slice(0, limit)
      .map(({ steps: _s, explain: _e, ...t }) => t);
    res.json({ traces: list, total: list.length });
  });

  ops.get('/traces/:id', (req, res) => {
    const t = deps.traces.get(req.params.id);
    if (!t) return void res.status(404).json({ error: 'Not Found', message: 'No trace with this request id (traces are kept in memory: controlPlane.console.traceBuffer)' });
    res.json(t);
  });

  const parseCall = (req: Request, res: Response) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const client = str(b.client);
    const server = str(b.server);
    const tool = str(b.tool);
    const args = b.arguments === undefined ? {} : b.arguments;
    if (!client || !server || !tool || typeof args !== 'object' || args === null || Array.isArray(args)) {
      res.status(400).json({ error: 'Bad Request', message: 'Body must be { "client": "<client id, e.g. key:ci>", "server": "<id>", "tool": "<name>", "arguments"?: {} }' });
      return undefined;
    }
    return { client, server, tool, args: args as Record<string, unknown> };
  };

  ops.post('/explain', (req, res) => {
    const c = parseCall(req, res);
    if (!c) return;
    const out = explainCall(cfg(), deps.principalFor(c.client), { clientId: c.client, serverId: c.server, tool: c.tool, args: c.args }, { serverExists: (id) => deps.serverInfo(id).exists, exposed: deps.exposed });
    res.json({ client: c.client, server: c.server, tool: c.tool, ...out });
  });

  ops.get('/timeline', (req, res) => {
    const q = req.query;
    const kinds = str(q.kind, 500)?.split(',').map((k) => k.trim()).filter(Boolean);
    if (kinds?.some((k) => !(TIMELINE_KINDS as readonly string[]).includes(k))) return void res.status(400).json({ error: 'Bad Request', message: `kind must be one of ${TIMELINE_KINDS.join(', ')}` });
    const since = str(q.since) ? Date.parse(String(q.since)) : undefined;
    const until = str(q.until) ? Date.parse(String(q.until)) : undefined;
    if ((since !== undefined && Number.isNaN(since)) || (until !== undefined && Number.isNaN(until))) return void res.status(400).json({ error: 'Bad Request', message: 'since / until must be ISO timestamps' });
    const subject = str(q.subject);
    const limit = Math.min(1000, Math.max(1, Number(q.limit) || 200));
    // refusals and GitOps releases come from the request / audit records; the rest from the event ring
    const fromRecords: OpsEvent[] = deps
      .recent(2000)
      .filter((m) => m.serverId === '_gitops' || (!m.success && m.decision && m.decision !== 'upstream-error'))
      .map((m) =>
        m.serverId === '_gitops'
          ? { at: m.timestamp.toISOString(), kind: 'gitops-release' as const, severity: m.success ? ('info' as const) : ('warning' as const), subject: m.clientId, detail: `${m.toolName}: ${m.decision ?? (m.success ? 'applied' : 'refused')}${m.errorMessage ? ` — ${m.errorMessage}` : ''}`, source: 'gitops' }
          : { at: m.timestamp.toISOString(), kind: 'audit' as const, severity: 'warning' as const, subject: m.clientId, detail: `${m.serverId}/${m.toolName} refused (${m.decision})${m.errorMessage ? `: ${m.errorMessage}` : ''}`, source: 'audit' },
      );
    const all = [...deps.timeline.list(), ...fromRecords]
      .filter((e) => (!kinds || kinds.includes(e.kind)) && (!subject || e.subject === subject))
      .filter((e) => {
        const t = Date.parse(e.at);
        return (since === undefined || t >= since) && (until === undefined || t < until);
      })
      .sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0))
      .slice(0, limit)
      .map((e) => ({ ...e, detail: redactString(e.detail) }));
    res.json({ events: all, total: all.length, kinds: TIMELINE_KINDS });
  });

  ops.post('/troubleshoot', troubleshootLimit, operator, (req, res) => {
    const c = parseCall(req, res);
    if (!c) return;
    const conf = cfg();
    type Check = { id: string; title: string; status: 'pass' | 'warn' | 'fail'; detail: string; configPath?: string };
    const checks: Check[] = [];
    // 1. upstream reachability
    const si = deps.serverInfo(c.server);
    if (!si.exists) checks.push({ id: 'upstream', title: 'Upstream reachability', status: 'fail', detail: `server "${c.server}" is not configured`, configPath: 'servers' });
    else if (!si.connected) checks.push({ id: 'upstream', title: 'Upstream reachability', status: 'fail', detail: `server "${c.server}" is not connected (status ${si.status ?? 'unknown'})` });
    else if (!si.tools.includes(c.tool)) checks.push({ id: 'upstream', title: 'Upstream reachability', status: 'warn', detail: `server "${c.server}" is connected but does not list tool "${c.tool}"` });
    else checks.push({ id: 'upstream', title: 'Upstream reachability', status: 'pass', detail: `server "${c.server}" is connected and lists "${c.tool}"` });
    // 2. auth / key
    const strategy = (conf.auth as { strategy?: string } | undefined)?.strategy ?? 'none';
    const known = deps.resolveClient(c.client);
    if (strategy === 'none') checks.push({ id: 'auth', title: 'Authentication / key', status: 'pass', detail: 'authentication is off (auth.strategy: none)' });
    else if (known?.known === false) checks.push({ id: 'auth', title: 'Authentication / key', status: 'fail', detail: `client "${c.client}" is unknown: no API key with this name (or it was removed / revoked)`, configPath: 'auth.apiKeys' });
    else if (!known) checks.push({ id: 'auth', title: 'Authentication / key', status: 'warn', detail: `client "${c.client}" carries its scope in its token (JWT / OAuth); its key cannot be checked here` });
    else {
      const i = keyIndex(conf, c.client);
      checks.push({ id: 'auth', title: 'Authentication / key', status: 'pass', detail: `client "${c.client}" resolves to a configured credential`, ...(i >= 0 ? { configPath: `auth.apiKeys[${i}]` } : {}) });
    }
    // 3. tenancy / scope (the central authorizer)
    const principal = deps.principalFor(c.client);
    const authz = si.exists ? authorize(principal, { serverId: c.server, name: c.tool, kind: 'tool' }, { exposed: deps.exposed }) : undefined;
    if (!si.exists) checks.push({ id: 'tenancy', title: 'Tenancy / scope', status: 'warn', detail: 'skipped: the server is not configured' });
    else if (authz) {
      const ex = explainDenial({ clientId: c.client, serverId: c.server, tool: c.tool }, typeof authz.data.decision === 'string' ? authz.data.decision : 'forbidden', authz.data, authz.message, conf);
      checks.push({ id: 'tenancy', title: 'Tenancy / scope', status: 'fail', detail: `${ex.layer}: ${ex.reason}`, ...(ex.configPath ? { configPath: ex.configPath } : {}) });
    } else checks.push({ id: 'tenancy', title: 'Tenancy / scope', status: 'pass', detail: 'the client may use this server and tool (scope, tenant role, isolation, delegation)' });
    // 4. policy — the 14.7 simulation against the running config
    const name = c.client.startsWith('key:') ? c.client.slice(4) : c.client;
    const sim = simulateDecision(deps.portable(), { clientId: c.client, serverId: c.server, tool: c.tool, args: c.args }, name);
    if (sim.effect === 'allow') checks.push({ id: 'policy', title: 'Policy simulation', status: 'pass', detail: sim.reason });
    else {
      const i = sim.rule ? ruleIndex(conf, sim.rule) : -1;
      checks.push({ id: 'policy', title: 'Policy simulation', status: sim.effect === 'deny' ? 'fail' : 'warn', detail: `${sim.layer}: ${sim.reason}`, ...(i >= 0 ? { configPath: `policy.rules[${i}]` } : sim.layer === 'scope' ? { configPath: 'auth.apiKeys' } : {}) });
    }
    // 5. rate limits / quotas — configured limits and recent refusals of this client
    const ki = keyIndex(conf, c.client);
    const keys = ((conf.auth as { apiKeys?: KeyEntry[] } | undefined)?.apiKeys ?? []) as KeyEntry[];
    const k = ki >= 0 ? keys[ki] : undefined;
    const own = k && typeof k === 'object' ? (k as { rateLimit?: { limit: number; windowSeconds: number } }).rateLimit : undefined;
    const global = conf.rateLimit as { limit?: number; windowSeconds?: number } | undefined;
    const limited = deps.recent(1000).filter((m) => m.clientId === c.client && !m.success && (m.decision === 'quota' || m.decision === 'budget' || m.errorCode === -32029)).length;
    const lim = own ?? global;
    checks.push({
      id: 'rate-limit',
      title: 'Rate limits / quotas',
      status: limited ? 'warn' : 'pass',
      detail: `${lim?.limit ? `${lim.limit} requests / ${lim.windowSeconds}s (${own ? 'key' : 'global'})` : 'no rate limit configured'}${limited ? `; ${limited} recent quota / budget refusal(s) for this client` : ''}`,
      ...(own ? { configPath: `auth.apiKeys[${ki}].scope.rateLimit` } : global ? { configPath: 'rateLimit' } : {}),
    });
    // 6. plugin health
    const pl = deps.plugins();
    const open = pl.filter((p) => p.circuit !== 'closed');
    const closedPolicy = open.filter((p) => p.failure !== 'open');
    checks.push({
      id: 'plugins',
      title: 'Plugin health',
      status: closedPolicy.length ? 'fail' : open.length ? 'warn' : 'pass',
      detail: !pl.length ? 'no plugins' : open.length ? `circuit open: ${open.map((p) => `${p.name} (failure: ${p.failure})`).join(', ')}` : `${pl.length} plugin(s), all circuits closed`,
      ...(open.length ? { configPath: 'plugins' } : {}),
    });
    const verdict = checks.some((x) => x.status === 'fail') ? 'fail' : checks.some((x) => x.status === 'warn') ? 'warn' : 'pass';
    const report = {
      id: randomUUID(),
      createdAt: new Date().toISOString(),
      gateway: VERSION,
      by: (req as Request & { clientId?: string }).clientId ?? 'operator',
      input: { client: c.client, server: c.server, tool: c.tool, arguments: redactArgs(c.args) },
      verdict,
      checks: checks.map((x) => ({ ...x, detail: redactString(x.detail) })),
      redacted: true,
    };
    reports.set(report.id, report);
    while (reports.size > MAX_REPORTS) {
      const first = reports.keys().next().value;
      if (first === undefined) break;
      reports.delete(first);
    }
    res.json(report);
  });

  ops.get('/reports/:id', (req, res) => {
    const r = reports.get(req.params.id);
    if (!r) return void res.status(404).json({ error: 'Not Found', message: 'No troubleshooting report with this id (reports are kept in memory)' });
    res.json(r);
  });

  return router;
}
