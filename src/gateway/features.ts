/**
 * Feature modules (5.1): self-contained admin capabilities mounted under `/api/v1/admin/<id>`, operators only.
 *
 * Each module is pure logic plus a small router; the gateway hands it a {@link FeatureContext} (running config,
 * tool list, a tool invoker and recent request metrics). `GET /api/v1/admin/features` lists what is mounted.
 *
 * @module gateway/features
 */

import express, { type Request, type RequestHandler, type Router } from 'express';
import type { GatewayConfig, ToolInfo, RequestMetric, ProxyResponse } from '../utils/types.js';
import { VERSION } from '../utils/version.js';
import { clientPrincipal, type Principal } from '../auth/authorizer.js';
import type { AccessScope } from '../auth/scopes.js';
export type { Principal };

export interface FeatureContext {
  config: () => GatewayConfig;
  tools: () => ToolInfo[];
  /**
   * Call a tool through the full invoker pipeline (authorization, policy, cache, costs, audit). 11.1: `principal` is
   * required — it is authorized by the gateway's single authorization point (use {@link principalOf} for the request's
   * caller, `ctx.principalFor(clientId)` for a stored client id, `systemPrincipal()` for operator-configured work);
   * `clientId` only labels the call in metrics and audit (defaults to the principal id).
   */
  invoke: (serverId: string, tool: string, args: Record<string, unknown>, principal: Principal, clientId?: string) => Promise<ProxyResponse>;
  /** Current principal of a client id (api keys; tenant confinement applied). Unknown / unresolvable ids may call nothing (11.1). */
  principalFor?: (clientId: string | undefined) => Principal;
  /** Current scope of a client id: `{known:false}` for a removed key; undefined when scopes travel with the credential (JWT/OAuth) (11.1). */
  resolveScope?: (clientId: string | undefined) => { known: boolean; scope?: AccessScope } | undefined;
  /** Most recent request metrics, newest first. */
  recent: (limit?: number) => RequestMetric[];
  /** Base URL of this gateway when listening (for self-tests). */
  baseUrl: () => string | undefined;
  /** Upstream server ids currently online on this gateway (5.2). */
  onlineServers?: () => string[];
  /** Register a cleanup run when the gateway stops (5.2): timers, sockets. */
  onStop?: (fn: () => void | Promise<void>) => void;
  /** Edge gateways seen by the edge control plane (5.3). */
  edgeNodes?: () => import('./edge-control.js').EdgeNode[];
  /** Calls captured by the replay recorder (`replay.enabled`), oldest first (5.5). */
  capturedCalls?: () => import('./replay.js').CapturedCall[];
  /** Validate a full config (schema form) and hot-apply it unless `dryRun`; throws when invalid (7.1). */
  applyConfig?: (raw: Record<string, unknown>, dryRun?: boolean) => Promise<{ changes: import('../config/diff.js').ConfigChange[] }>;
}

export interface FeatureModule {
  /** Mount point: `/api/v1/admin/<id>`. */
  id: string;
  /** Version that introduced it. */
  since: string;
  summary: string;
  mount: (router: Router, ctx: FeatureContext) => void;
  /** Routes for any authenticated client (not only operators) under `/api/v1/features/<id>` (7.7). */
  mountClient?: (router: Router, ctx: FeatureContext) => void;
}

/** Client id of an authenticated request (7.7). */
export const clientIdOf = (req: Request): string | undefined => (req as Request & { clientId?: string }).clientId;

/** Principal of an authenticated request: its client id and effective scope (11.1). */
export const principalOf = (req: Request): Principal => clientPrincipal(clientIdOf(req), (req as Request & { scope?: AccessScope }).scope);

const registry: FeatureModule[] = [];

/** Top-level config sections owned by feature modules; all hot reload (5.2+). */
export const FEATURE_CONFIG_KEYS = ['regions', 'edgeFleet', 'pluginTrust', 'marketplace', 'sessions', 'dlp', 'adaptive', 'apiUpstreams', 'genaiTelemetry', 'identity', 'policyShadow', 'anomaly', 'billing', 'console', 'sanitize', 'semanticCache', 'rollouts', 'offline', 'approvalFlows', 'complianceReports', 'agentIdentity', 'a2aFederation', 'debugSessions', 'costAdvisor', 'blueGreen', 'dataLineage', 'configAssistant', 'chaos', 'multimodal', 'edgeRuntime', 'confidential', 'toolRegistry', 'sla', 'selfHealing', 'postQuantumTls', 'ecosystem', 'policyEngine', 'timeTravel', 'realtimeBudgets', 'taskGraphs', 'edgeAutonomy', 'privacy', 'pqIdentity'] as const satisfies ReadonlyArray<keyof GatewayConfig>;

/**
 * Config section(s) that activate each feature module (10.9). In `lazy` mode (`kernel.modules`; the schema-v11
 * default since 11.0) a module listed here is mounted — routes, timers, call hooks — only while one of its sections is
 * configured; modules not listed (`kernel`, `conformance`, `k8s`, `terraform`, `policy-sim`) are always active.
 */
export const FEATURE_ACTIVATION: Readonly<Record<string, readonly (keyof GatewayConfig)[]>> = {
  'a2a-federation': ['a2aFederation'], adaptive: ['adaptive'], 'agent-identity': ['agentIdentity'], anomaly: ['anomaly'],
  'api-upstreams': ['apiUpstreams'], 'approval-flows': ['approvalFlows'], billing: ['billing'], 'blue-green': ['blueGreen'],
  chaos: ['chaos'], 'compliance-reports': ['complianceReports'], confidential: ['confidential'], 'config-assistant': ['configAssistant'],
  console: ['console'], 'cost-advisor': ['costAdvisor'], 'data-lineage': ['dataLineage'], 'debug-sessions': ['debugSessions'],
  dlp: ['dlp'], ecosystem: ['ecosystem'], 'edge-autonomy': ['edgeAutonomy'], 'edge-fleet': ['edgeFleet'], 'edge-runtime': ['edgeRuntime'],
  'genai-otel': ['genaiTelemetry'], identity: ['identity'], marketplace: ['marketplace'], multimodal: ['multimodal'], offline: ['offline'],
  'policy-engine': ['policyEngine'], 'pq-identity': ['pqIdentity'], 'pq-tls': ['postQuantumTls'], privacy: ['privacy'],
  'realtime-budgets': ['realtimeBudgets'], regions: ['regions'], rollouts: ['rollouts'], sanitize: ['sanitize'],
  'self-healing': ['selfHealing'], 'semantic-cache': ['semanticCache'], sessions: ['sessions'], sla: ['sla'],
  'task-graphs': ['taskGraphs'], 'time-travel': ['timeTravel'], 'tool-registry': ['toolRegistry'],
};

/** Effective module activation mode: `kernel.modules`, else lazy (11.0 default; 10.x was eager). */
export const moduleMode = (cfg: GatewayConfig): 'eager' | 'lazy' => cfg.kernel?.modules ?? 'lazy';

/** Whether a feature module (or a call hook with that id) is active under `cfg`. */
export function isFeatureActive(cfg: GatewayConfig, id: string): boolean {
  if (moduleMode(cfg) === 'eager') return true;
  const keys = FEATURE_ACTIVATION[id];
  return !keys || keys.some((k) => cfg[k] !== undefined);
}

/** Copy the feature-owned config sections of `next` (for hot reload). */
export function featureSections(next: GatewayConfig): Partial<GatewayConfig> {
  return Object.fromEntries(FEATURE_CONFIG_KEYS.map((k) => [k, next[k]])) as Partial<GatewayConfig>;
}

/** Register a feature module (idempotent by id; later registrations replace earlier ones). */
export function registerFeature(f: FeatureModule): void {
  const i = registry.findIndex((x) => x.id === f.id);
  if (i >= 0) registry[i] = f;
  else registry.push(f);
}

export function listFeatures(): ReadonlyArray<Pick<FeatureModule, 'id' | 'since' | 'summary'>> {
  return registry.map(({ id, since, summary }) => ({ id, since, summary }));
}

export interface FeatureRouterDeps {
  authenticate: RequestHandler;
  isOperator: (req: Request) => boolean;
  context: FeatureContext;
  features?: FeatureModule[];
}

/** Router for `/api/v1`: `GET /admin/features` and every module under `/admin/<id>`. */
export function createFeatureRouter(deps: FeatureRouterDeps): express.Router {
  const router = express.Router();
  const operator: RequestHandler = (req, res, next) =>
    deps.isOperator(req) ? next() : void res.status(403).json({ error: 'Forbidden', message: 'The admin API is for operators (unscoped keys)' });
  const mods = deps.features ?? registry;
  router.get('/admin/features', deps.authenticate, operator, (_req, res) => {
    const cfg = deps.context.config();
    res.json({ version: VERSION, modules: moduleMode(cfg), features: mods.map(({ id, since, summary }) => ({ id, since, summary, path: `/api/v1/admin/${id}`, active: isFeatureActive(cfg, id) })) });
  });
  // 10.9: modules are mounted when they become active (at start, on reload via `sync()`, or on first request);
  // inactive modules answer 404 in lazy mode.
  // Each module gets a fixed holder router in the stack (so route listings and the auth matrix see every mounted
  // route); the module's own routers are added to its holder once it is active.
  const holders = new Map<string, { admin: express.Router; client?: express.Router }>();
  const mounted = new Set<string>();
  const ensure = (m: FeatureModule) => {
    if (mounted.has(m.id)) return;
    const h = holders.get(m.id)!;
    const admin = express.Router();
    m.mount(admin, deps.context);
    h.admin.use(admin);
    if (m.mountClient && h.client) {
      const client = express.Router();
      m.mountClient(client, deps.context);
      h.client.use(client);
    }
    mounted.add(m.id);
  };
  const inactive = (m: FeatureModule, res: express.Response) =>
    void res.status(404).json({
      error: 'Not Found',
      message: `Feature module "${m.id}" is not active: kernel.modules is lazy and ${FEATURE_ACTIVATION[m.id]!.map((k) => `features.${String(k)}`).join(' / ')} is not configured`,
    });
  for (const m of mods) {
    const h = { admin: express.Router(), client: m.mountClient ? express.Router() : undefined };
    holders.set(m.id, h);
    if (isFeatureActive(deps.context.config(), m.id)) ensure(m);
    const gate: express.RequestHandler = (_req, res, next) => {
      if (!isFeatureActive(deps.context.config(), m.id)) return inactive(m, res);
      ensure(m);
      next();
    };
    router.use(`/admin/${m.id}`, deps.authenticate, operator, gate, h.admin);
    if (h.client) router.use(`/features/${m.id}`, deps.authenticate, gate, h.client);
  }
  /** Mount modules that became active (call after a config reload). */
  (router as express.Router & { sync?: () => string[] }).sync = () => {
    const added: string[] = [];
    for (const m of mods) if (!mounted.has(m.id) && isFeatureActive(deps.context.config(), m.id)) (ensure(m), added.push(m.id));
    return added;
  };
  /** Ids of mounted modules. */
  (router as express.Router & { mountedIds?: () => string[] }).mountedIds = () => [...mounted.keys()];
  return router;
}

/** Parse a JSON-object body; responds 400 and returns undefined otherwise. */
export function objectBody(req: Request, res: express.Response): Record<string, unknown> | undefined {
  const b = req.body as unknown;
  if (!b || typeof b !== 'object' || Array.isArray(b)) {
    res.status(400).json({ error: 'Bad Request', message: 'Body must be a JSON object' });
    return undefined;
  }
  return b as Record<string, unknown>;
}

export const badRequest = (res: express.Response, message: string) => void res.status(400).json({ error: 'Bad Request', message });
