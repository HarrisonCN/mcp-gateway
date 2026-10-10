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
import { logger } from '../utils/logger.js';
import { clientPrincipal, type Principal } from '../auth/authorizer.js';
import type { AccessScope } from '../auth/scopes.js';
import { FEATURE_MANIFEST, failurePolicyOf, manifestEntry } from '../features/manifest.js';
import { loadFeature, loadRecord, dependencyOrder, dependentsOf, failureOf as moduleFailureOf, ModuleFailures } from './kernel-runtime.js';
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
  /** Shared state store (`store.backend`: memory | redis | eventlog | sqlite) (11.2). */
  store?: () => import('../state/store.js').StateStore | undefined;
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
  /** Module states of this gateway's kernel (13.0; set by {@link createFeatureRouter}). */
  kernel?: () => KernelModuleView[];
  /** 13.2.0: hot reload state — committed config generation, generations kept alive by in-flight calls, rollbacks. */
  reloadState?: () => { generation: number; committedAt: string; alive: number; pinned: Record<string, number>; committed: number; rollbacks: number };
}

/** Health a module reports (13.0 lifecycle). */
export interface ModuleHealth {
  status: 'ok' | 'degraded' | 'failed';
  detail?: string;
  [k: string]: unknown;
}

/** One module as `GET /admin/kernel` shows it (13.0). */
export interface KernelModuleView {
  id: string;
  since: string;
  summary: string;
  /** inactive: not configured (lazy) · available: may be used, not evaluated yet · active · disabled: was active, section removed · failed. */
  state: 'inactive' | 'available' | 'active' | 'disabled' | 'failed';
  evaluated: boolean;
  dependsOn: readonly string[];
  /** What tool calls get while the module is failed (13.1). */
  failurePolicy: import('../features/manifest.js').FailurePolicy;
  loadMs?: number;
  error?: string;
  health?: ModuleHealth;
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
  /**
   * Lifecycle (13.0, all optional). The kernel calls them in dependency order — `init` once when the module becomes
   * active (before its routes are mounted), `reconfigure` on every config reload while it stays active, `disable`
   * when its section is removed (lazy mode), `dispose` when the gateway stops (reverse dependency order) — and
   * `health` for `GET /admin/kernel`. A throw marks the module (and the modules depending on it) failed: its routes
   * answer 503, its call hooks are skipped, the rest of the gateway keeps running.
   */
  init?: (ctx: FeatureContext) => void | Promise<void>;
  reconfigure?: (next: GatewayConfig, prev: GatewayConfig, ctx: FeatureContext) => void | Promise<void>;
  disable?: (ctx: FeatureContext) => void | Promise<void>;
  dispose?: () => void | Promise<void>;
  health?: () => ModuleHealth;
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
export const FEATURE_ACTIVATION: Readonly<Record<string, readonly (keyof GatewayConfig)[]>> = Object.fromEntries(
  FEATURE_MANIFEST.filter((e) => e.activation?.length).map((e) => [e.id, e.activation!]),
);

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

/** Every known module: the manifest (evaluated or not, 13.0) then modules registered at runtime. */
export function listFeatures(): ReadonlyArray<Pick<FeatureModule, 'id' | 'since' | 'summary'>> {
  const out = FEATURE_MANIFEST.map(({ id, since, summary }) => ({ id, since, summary }));
  for (const m of registry) if (!manifestEntry(m.id)) out.push({ id: m.id, since: m.since, summary: m.summary });
  return out;
}

/** Registered (evaluated) module by id. */
export const registeredFeature = (id: string): FeatureModule | undefined => registry.find((m) => m.id === id);

export interface FeatureRouterDeps {
  authenticate: RequestHandler;
  isOperator: (req: Request) => boolean;
  context: FeatureContext;
  features?: FeatureModule[];
  /** Runtime failure registry of this gateway's kernel (13.1); a new one when absent. */
  failures?: ModuleFailures;
}

/** The `/api/v1` feature router plus this gateway's kernel (13.0). */
export type FeatureRouter = express.Router & {
  /** Load → init → mount every module that runs from the start under the current config (dependency order). */
  activate: () => Promise<string[]>;
  /**
   * After a config reload (`prev` = the config before it): reconfigure, disable and activate modules. Returns the
   * newly activated ids. With a transaction (13.2.0) a failing init / reconfigure / disable throws instead of marking
   * the module failed, and every step already taken is recorded so {@link KernelTxn.rollback} can compensate it.
   */
  reconcile: (prev: GatewayConfig, txn?: KernelTxn) => Promise<string[]>;
  /** 13.2.0: start a module transaction for one hot reload. */
  begin: () => KernelTxn;
  /** 10.9 name of {@link activate}. */
  sync: () => Promise<string[]>;
  /** Dispose every module that was activated (reverse dependency order). */
  dispose: () => Promise<void>;
  /** Kernel view of every module. */
  modules: () => KernelModuleView[];
  /** Ids of mounted modules. */
  mountedIds: () => string[];
  /** Runtime or load failure of a module in this gateway (13.1). */
  failureOf: (id: string) => string | undefined;
};

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * 13.2.0: the module steps of one hot reload and their compensations. `rollback()` undoes them in reverse order (a
 * reconfigure is undone by reconfiguring back, a disable by initialising again, an activation by disposing); a
 * compensation that fails marks that module failed (logged) — the only state that cannot be restored automatically.
 */
export interface KernelTxn {
  readonly steps: readonly string[];
  rollback(): Promise<void>;
  commit(): void;
}

/**
 * Router for `/api/v1`: `GET /admin/features` and every module under `/admin/<id>` (client routes under
 * `/features/<id>`).
 *
 * 13.0: modules are evaluated on demand. A module whose activation section is configured (or that registers a call
 * hook that has work to do) is loaded, initialised and mounted by {@link FeatureRouter.activate} at start; modules
 * without an activation section (kernel, conformance, k8s, terraform, policy-sim) are loaded on their first request;
 * modules that are not configured are never evaluated (lazy mode). `kernel.modules: eager` loads everything at start.
 */
export function createFeatureRouter(deps: FeatureRouterDeps): FeatureRouter {
  const router = express.Router() as FeatureRouter;
  const operator: RequestHandler = (req, res, next) =>
    deps.isOperator(req) ? next() : void res.status(403).json({ error: 'Forbidden', message: 'The admin API is for operators (unscoped keys)' });
  const explicit = deps.features;
  const cfg = () => deps.context.config();
  const ids = (): string[] => (explicit ? explicit.map((m) => m.id) : listFeatures().map((f) => f.id));
  const moduleOf = (id: string): FeatureModule | undefined => (explicit ? explicit.find((m) => m.id === id) : registeredFeature(id));
  const states = new Map<string, { state: 'active' | 'disabled' | 'failed'; error?: string }>();
  const activating = new Map<string, Promise<boolean>>();
  const activatedOrder: string[] = [];
  const ctx: FeatureContext = { ...deps.context, kernel: () => views() };
  const failures = deps.failures ?? new ModuleFailures();
  const failureOf = (id: string) => moduleFailureOf(id, failures);
  const markRuntimeFailed = (id: string, error: string) => failures.mark(id, error);
  const clearRuntimeFailed = (id?: string) => failures.clear(id);

  // Each module gets a fixed holder router in the stack (so route listings and the auth matrix see every mounted
  // route); the module's own routers are added to its holder once it is active.
  const holders = new Map<string, { admin: express.Router; client: express.Router }>();
  const mounted = new Set<string>();
  const holder = (id: string) => {
    let h = holders.get(id);
    if (!h) holders.set(id, (h = { admin: express.Router(), client: express.Router() }));
    return h;
  };
  const mount = (m: FeatureModule) => {
    if (mounted.has(m.id)) return;
    const h = holder(m.id);
    const admin = express.Router();
    m.mount(admin, ctx);
    h.admin.use(admin);
    if (m.mountClient) {
      const client = express.Router();
      m.mountClient(client, ctx);
      h.client.use(client);
    }
    mounted.add(m.id);
  };

  const fail = (id: string, error: string) => {
    states.set(id, { state: 'failed', error });
    markRuntimeFailed(id, error);
    for (const d of explicit ? [] : dependentsOf(id)) {
      if (states.get(d)?.state === 'active') {
        states.set(d, { state: 'failed', error: `dependency "${id}" failed` });
        markRuntimeFailed(d, `dependency "${id}" failed`);
      }
    }
  };

  type Txn = KernelTxn & { undo: Array<{ id: string; step: string; fn: () => Promise<void> }> };
  const activateOne = (id: string, txn?: Txn): Promise<boolean> => {
    const st = states.get(id);
    if (st?.state === 'active') return Promise.resolve(true);
    if (st?.state === 'failed') return Promise.resolve(false);
    let p = activating.get(id);
    if (p && !txn) return p;
    // 13.2.0: inside a reload transaction a failure throws (the reload rolls back) instead of marking the module failed.
    const refuse = (error: string): false => {
      if (txn) throw new Error(`feature module "${id}" ${error}`);
      fail(id, error);
      return false;
    };
    p = (async () => {
      const entry = explicit ? undefined : manifestEntry(id);
      // dependencies first: evaluated always, initialised when they are active themselves
      for (const d of entry?.dependsOn ?? []) {
        if (isFeatureActive(cfg(), d) && !(await activateOne(d, txn))) {
          return refuse(`dependency "${d}" failed: ${states.get(d)?.error ?? failureOf(d) ?? 'unknown error'}`);
        }
      }
      if (!explicit && !(await loadFeature(id))) return refuse(loadRecord(id)?.error ?? 'failed to load');
      const m = moduleOf(id);
      if (!m) return refuse('the module did not register itself');
      try {
        await m.init?.(ctx);
        mount(m);
      } catch (e) {
        if (txn) {
          // compensation of a partial init: give the module the chance to release what it acquired
          await Promise.resolve(m.dispose?.()).catch((err) => logger.warn(`feature module "${id}" dispose after failed init: ${errText(err)}`));
          states.delete(id);
          clearRuntimeFailed(id);
        }
        return refuse(`init: ${errText(e)}`);
      }
      states.set(id, { state: 'active' });
      clearRuntimeFailed(id);
      if (!activatedOrder.includes(id)) activatedOrder.push(id);
      txn?.undo.push({
        id,
        step: 'activate',
        fn: async () => {
          await m.dispose?.();
          states.delete(id);
          const i = activatedOrder.indexOf(id);
          if (i >= 0) activatedOrder.splice(i, 1);
        },
      });
      return true;
    })();
    activating.set(id, p);
    void p.finally(() => activating.delete(id)).catch(() => undefined);
    return p;
  };

  /** Modules that run from the start (rather than on first request) under `c`. */
  const startIds = (c: GatewayConfig): string[] =>
    ids().filter((id) => {
      if (!isFeatureActive(c, id)) return false;
      if (explicit || moduleMode(c) === 'eager') return true;
      const e = manifestEntry(id);
      if (!e) return true;
      if (e.activation?.length) return true;
      return !!e.hook && (!e.hookWhen || c[e.hookWhen] !== undefined);
    });

  const order = (list: string[]) => {
    if (explicit) return list;
    const known = list.filter((id) => manifestEntry(id));
    return [...dependencyOrder(known).filter((id) => list.includes(id) || isFeatureActive(cfg(), id)), ...list.filter((id) => !manifestEntry(id))];
  };

  router.activate = async () => {
    const added: string[] = [];
    for (const id of order(startIds(cfg()))) {
      const before = states.get(id)?.state;
      if ((await activateOne(id)) && before !== 'active') added.push(id);
    }
    return added;
  };
  router.sync = router.activate;

  router.begin = () => {
    const txn: Txn = {
      undo: [],
      get steps() {
        return txn.undo.map((u) => `${u.step}:${u.id}`);
      },
      rollback: async () => {
        for (const u of txn.undo.splice(0).reverse()) {
          try {
            await u.fn();
          } catch (e) {
            logger.error(`Module rollback of ${u.step} "${u.id}" failed — module marked failed: ${errText(e)}`);
            fail(u.id, `rollback of ${u.step}: ${errText(e)}`);
          }
        }
      },
      commit: () => {
        txn.undo.length = 0;
      },
    };
    return txn;
  };

  router.reconcile = async (prev: GatewayConfig, txnIn?: KernelTxn) => {
    const txn = txnIn as Txn | undefined;
    const next = cfg();
    for (const id of order([...states.keys()])) {
      const st = states.get(id);
      if (st?.state !== 'active') continue;
      const m = moduleOf(id);
      if (!isFeatureActive(next, id)) {
        try {
          await m?.disable?.(ctx);
          states.set(id, { state: 'disabled' });
          txn?.undo.push({
            id,
            step: 'disable',
            fn: async () => {
              await m?.init?.(ctx);
              states.set(id, { state: 'active' });
            },
          });
        } catch (e) {
          if (txn) throw new Error(`feature module "${id}" disable: ${errText(e)}`);
          fail(id, `disable: ${errText(e)}`);
        }
        continue;
      }
      try {
        await m?.reconfigure?.(next, prev, ctx);
        if (m?.reconfigure) txn?.undo.push({ id, step: 'reconfigure', fn: async () => void (await m.reconfigure!(prev, next, ctx)) });
      } catch (e) {
        if (txn) {
          // the module may have applied part of the new config: reconfigure it back first
          if (m?.reconfigure) txn.undo.push({ id, step: 'reconfigure', fn: async () => void (await m.reconfigure!(prev, next, ctx)) });
          throw new Error(`feature module "${id}" reconfigure: ${errText(e)}`);
        }
        fail(id, `reconfigure: ${errText(e)}`);
      }
    }
    for (const [id, st] of states) if (st.state === 'disabled' && isFeatureActive(next, id)) states.delete(id);
    if (!txn) return router.activate();
    const added: string[] = [];
    for (const id of order(startIds(next))) {
      const before = states.get(id)?.state;
      if (before === 'disabled' || before === 'failed') continue;
      if ((await activateOne(id, txn)) && before !== 'active') added.push(id);
    }
    return added;
  };

  router.dispose = async () => {
    for (const id of [...activatedOrder].reverse()) {
      const m = moduleOf(id);
      await Promise.resolve(m?.dispose?.()).catch(() => {});
      clearRuntimeFailed(id);
    }
    for (const [id, st] of states) if (st.state === 'failed') clearRuntimeFailed(id);
    states.clear();
    activatedOrder.length = 0;
  };

  const views = (): KernelModuleView[] =>
    ids().map((id) => {
      const e = manifestEntry(id);
      const m = moduleOf(id);
      const st = states.get(id);
      const rec = loadRecord(id);
      const state: KernelModuleView['state'] = st?.state ?? (failureOf(id) ? 'failed' : isFeatureActive(cfg(), id) ? 'available' : 'inactive');
      let health: ModuleHealth | undefined;
      if (st?.state === 'active' && m?.health) {
        try {
          health = m.health();
        } catch (err) {
          health = { status: 'failed', detail: errText(err) };
        }
      }
      return {
        id,
        since: e?.since ?? m?.since ?? '',
        summary: e?.summary ?? m?.summary ?? '',
        state,
        evaluated: explicit ? true : e ? rec?.status === 'loaded' : true,
        dependsOn: e?.dependsOn ?? [],
        failurePolicy: failurePolicyOf(id, cfg(), !!e?.hook),
        ...(rec?.loadMs !== undefined ? { loadMs: rec.loadMs } : {}),
        ...(st?.error ?? failureOf(id) ? { error: st?.error ?? failureOf(id) } : {}),
        ...(health ? { health } : {}),
      };
    });
  router.modules = views;
  router.mountedIds = () => [...mounted.keys()];
  router.failureOf = failureOf;

  router.get('/admin/features', deps.authenticate, operator, (_req, res) => {
    const c = cfg();
    const list = explicit ? explicit.map(({ id, since, summary }) => ({ id, since, summary })) : listFeatures();
    res.json({ version: VERSION, modules: moduleMode(c), features: list.map(({ id, since, summary }) => ({ id, since, summary, path: `/api/v1/admin/${id}`, active: isFeatureActive(c, id) && states.get(id)?.state !== 'failed' })) });
  });

  const inactive = (id: string, res: express.Response) =>
    void res.status(404).json({
      error: 'Not Found',
      message: `Feature module "${id}" is not active: kernel.modules is lazy and ${(FEATURE_ACTIVATION[id] ?? []).map((k) => `features.${String(k)}`).join(' / ')} is not configured`,
    });
  const failed = (id: string, res: express.Response) =>
    void res.status(503).json({ error: 'Service Unavailable', message: `Feature module "${id}" failed: ${states.get(id)?.error ?? failureOf(id) ?? 'unknown error'}` });

  const gateFor = (id: string): RequestHandler => (_req, res, next) => {
    if (!isFeatureActive(cfg(), id) || states.get(id)?.state === 'disabled') return inactive(id, res);
    if (states.get(id)?.state === 'active') return next();
    activateOne(id).then((ok) => (ok ? next() : failed(id, res)), next);
  };
  // Holders for every known module (manifest + registered) at creation; modules registered later are reached through
  // the catch-all below.
  const known = new Set<string>();
  const route = (id: string) => {
    if (known.has(id)) return;
    known.add(id);
    const h = holder(id);
    router.use(`/admin/${id}`, deps.authenticate, operator, gateFor(id), h.admin);
    router.use(`/features/${id}`, deps.authenticate, gateFor(id), h.client);
  };
  for (const id of ids()) route(id);
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
