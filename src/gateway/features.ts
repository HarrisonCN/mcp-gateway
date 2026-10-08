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

export interface FeatureContext {
  config: () => GatewayConfig;
  tools: () => ToolInfo[];
  /** Call a tool through the full invoker pipeline (policy, cache, costs, audit). */
  invoke: (serverId: string, tool: string, args: Record<string, unknown>, clientId?: string) => Promise<ProxyResponse>;
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

const registry: FeatureModule[] = [];

/** Top-level config sections owned by feature modules; all hot reload (5.2+). */
export const FEATURE_CONFIG_KEYS = ['regions', 'edgeFleet', 'pluginTrust', 'marketplace', 'sessions', 'dlp', 'adaptive', 'apiUpstreams', 'workflows', 'genaiTelemetry', 'identity', 'policyShadow', 'anomaly', 'billing', 'console', 'sanitize', 'semanticCache', 'rollouts', 'offline', 'approvalFlows', 'complianceReports', 'agentIdentity', 'a2aFederation', 'debugSessions'] as const satisfies ReadonlyArray<keyof GatewayConfig>;

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
    res.json({ version: VERSION, features: mods.map(({ id, since, summary }) => ({ id, since, summary, path: `/api/v1/admin/${id}` })) });
  });
  for (const m of mods) {
    const sub = express.Router();
    m.mount(sub, deps.context);
    router.use(`/admin/${m.id}`, deps.authenticate, operator, sub);
    if (m.mountClient) {
      const pub = express.Router();
      m.mountClient(pub, deps.context);
      router.use(`/features/${m.id}`, deps.authenticate, pub);
    }
  }
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
