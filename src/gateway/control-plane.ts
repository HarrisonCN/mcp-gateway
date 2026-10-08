/**
 * Control plane / data plane split (7.0).
 *
 * A gateway runs in one of three roles (`controlPlane.role`):
 *
 * - `all` (default) — one process does everything, as in 6.x.
 * - `control` — admin API, dashboard and **config distribution**: data planes pull the running config from
 *   `GET /api/v1/admin/data-planes/config` (`ETag` / `If-None-Match` → 304) and report in with
 *   `POST /api/v1/admin/data-planes/heartbeat`; `GET /api/v1/admin/data-planes` lists them.
 * - `data` — serves tool traffic only. It pulls its config from `controlPlane.url` every `pullIntervalMs`
 *   (authenticating with `controlPlane.token`, an operator API key of the control plane), hot-applies it and sends a
 *   heartbeat. `/api/v1/admin/*` answers 403 (the admin API lives on the control plane) and every other route answers
 *   503 until the first config has been applied (fail closed). `GET /api/v1/data-plane` shows the sync state.
 *
 * The distributed config is the control plane's running config without `controlPlane`, `port` and `host` (each data
 * plane keeps its own); it includes secrets, so it is only served to operators of a `control` gateway.
 *
 * @module gateway/control-plane
 */

import { createHash, randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import express, { type Request, type RequestHandler } from 'express';
import { z } from 'zod';
import type { GatewayConfig } from '../utils/types.js';
import { VERSION } from '../utils/version.js';
import { logger } from '../utils/logger.js';

export const ControlPlaneSchema = z
  .object({
    role: z.enum(['all', 'control', 'data']).default('all'),
    configApi: z.boolean().optional(),
    dashboard: z.boolean().optional(),
    url: z.string().url().optional(),
    token: z.string().min(1).optional(),
    pullIntervalMs: z.number().int().min(1000).max(3_600_000).default(10_000),
    nodeId: z.string().min(1).max(128).optional(),
  })
  .strict()
  .superRefine((c, ctx) => {
    if (c.role === 'data') {
      if (!c.url) ctx.addIssue({ code: 'custom', path: ['url'], message: 'a data plane needs `controlPlane.url` (the control plane base URL)' });
      if (!c.token) ctx.addIssue({ code: 'custom', path: ['token'], message: 'a data plane needs `controlPlane.token` (an operator API key of the control plane)' });
    } else {
      if (c.url !== undefined) ctx.addIssue({ code: 'custom', path: ['url'], message: '`url` is a data-plane setting (role: data)' });
      if (c.token !== undefined) ctx.addIssue({ code: 'custom', path: ['token'], message: '`token` is a data-plane setting (role: data)' });
      if (c.nodeId !== undefined) ctx.addIssue({ code: 'custom', path: ['nodeId'], message: '`nodeId` is a data-plane setting (role: data)' });
    }
  });

/** `controlPlane:` — the gateway's role and control-plane settings (schema v8). Restart required. */
export interface ControlPlaneConfig {
  /** `all` (default), `control` or `data`. */
  role?: 'all' | 'control' | 'data';
  /** Allow `PUT /api/v1/admin/config` and `POST /api/v1/admin/reload` (default false). Was `admin.configApi` in 6.x. */
  configApi?: boolean;
  /** Serve the web dashboard (default true). Was `dashboard.enabled` in 6.x. */
  dashboard?: boolean;
  /** Data plane: control plane base URL (e.g. `https://cp.internal:4000`). */
  url?: string;
  /** Data plane: operator API key of the control plane. */
  token?: string;
  /** Data plane: config pull + heartbeat interval (ms, default 10000, min 1000). */
  pullIntervalMs?: number;
  /** Data plane: id reported in heartbeats (default `<hostname>-<random>`). */
  nodeId?: string;
}

export const roleOf = (cfg: GatewayConfig): 'all' | 'control' | 'data' => cfg.controlPlane?.role ?? 'all';

const stable = (v: unknown): string =>
  Array.isArray(v)
    ? `[${v.map(stable).join(',')}]`
    : v && typeof v === 'object'
      ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stable((v as Record<string, unknown>)[k])}`).join(',')}}`
      : JSON.stringify(v) ?? 'null';

/** Strong ETag of a config object (order independent). */
export const configEtag = (config: unknown) => `"${createHash('sha256').update(stable(config)).digest('hex').slice(0, 32)}"`;

/** The config a control plane distributes: `portable` minus `controlPlane`, `port` and `host` (schema version kept: 8 or 9, 8.9). */
export function distributedConfig(portable: Record<string, unknown>): Record<string, unknown> {
  const { controlPlane: _c, port: _p, host: _h, configDir: _d, deprecations: _x, ...rest } = portable;
  return { ...rest, version: rest.version === 9 ? 9 : 8 };
}

export interface DataPlaneNode {
  nodeId: string;
  firstSeen: string;
  lastSeen: string;
  /** Config ETag the data plane runs. */
  configEtag?: string;
  inSync: boolean;
  status: 'online' | 'stale';
  version?: string;
  pullIntervalMs?: number;
  servers?: { online: number; total: number };
  lastError?: string;
  address?: string;
}

const MAX_NODES = 1000;

export interface ControlPlaneDeps {
  config: () => GatewayConfig;
  /** Running config in schema form (secrets included). */
  portable: () => Record<string, unknown>;
  authenticate: RequestHandler;
  isOperator: (req: Request) => boolean;
  now?: () => number;
}

/** Control-plane routes under `/api/v1/admin/data-planes` (operators only). */
export function createControlPlaneRouter(deps: ControlPlaneDeps): express.Router & { nodes: Map<string, Omit<DataPlaneNode, 'inSync' | 'status'>> } {
  const router = express.Router() as express.Router & { nodes: Map<string, Omit<DataPlaneNode, 'inSync' | 'status'>> };
  const nodes = new Map<string, Omit<DataPlaneNode, 'inSync' | 'status'>>();
  router.nodes = nodes;
  const now = deps.now ?? Date.now;
  const operator: RequestHandler = (req, res, next) =>
    deps.isOperator(req) ? next() : void res.status(403).json({ error: 'Forbidden', message: 'The admin API is for operators (unscoped keys)' });
  const controlOnly: RequestHandler = (_req, res, next) =>
    roleOf(deps.config()) === 'control'
      ? next()
      : void res.status(409).json({ error: 'Conflict', message: 'Not a control plane: set `controlPlane.role: control` to serve data planes' });
  const guard = [deps.authenticate, operator];
  const current = () => {
    const config = distributedConfig(deps.portable());
    return { config, etag: configEtag(config) };
  };
  const view = (n: Omit<DataPlaneNode, 'inSync' | 'status'>, etag: string | undefined): DataPlaneNode => {
    const ttl = 3 * (n.pullIntervalMs ?? 10_000);
    return { ...n, inSync: !!etag && n.configEtag === etag, status: now() - Date.parse(n.lastSeen) <= ttl ? 'online' : 'stale' };
  };

  router.get('/admin/data-planes', ...guard, (_req, res) => {
    const role = roleOf(deps.config());
    const etag = role === 'control' ? current().etag : undefined;
    const list = [...nodes.values()].map((n) => view(n, etag)).sort((a, b) => a.nodeId.localeCompare(b.nodeId));
    res.set('Cache-Control', 'no-store').json({
      role,
      ...(etag ? { configEtag: etag } : {}),
      dataPlanes: list,
      summary: { total: list.length, online: list.filter((n) => n.status === 'online').length, inSync: list.filter((n) => n.inSync).length },
    });
  });

  router.get('/admin/data-planes/config', ...guard, controlOnly, (req, res) => {
    const { config, etag } = current();
    res.set('ETag', etag).set('Cache-Control', 'no-store');
    const inm = req.get('if-none-match');
    if (inm && inm.split(',').map((s) => s.trim()).includes(etag)) return void res.status(304).end();
    res.json({ version: VERSION, etag, config });
  });

  router.post('/admin/data-planes/heartbeat', ...guard, controlOnly, (req, res) => {
    const b = req.body as Record<string, unknown> | undefined;
    if (!b || typeof b !== 'object' || Array.isArray(b) || typeof b.nodeId !== 'string' || !b.nodeId || b.nodeId.length > 128) {
      return void res.status(400).json({ error: 'Bad Request', message: 'Body must be { "nodeId": "<id>", "configEtag"?, "version"?, "pullIntervalMs"?, "servers"? }' });
    }
    const id = b.nodeId;
    if (!nodes.has(id) && nodes.size >= MAX_NODES) return void res.status(429).json({ error: 'Too Many Requests', message: `At most ${MAX_NODES} data planes are tracked` });
    const at = new Date(now()).toISOString();
    const prev = nodes.get(id);
    const servers = b.servers as { online?: unknown; total?: unknown } | undefined;
    nodes.set(id, {
      nodeId: id,
      firstSeen: prev?.firstSeen ?? at,
      lastSeen: at,
      ...(typeof b.configEtag === 'string' ? { configEtag: b.configEtag } : {}),
      ...(typeof b.version === 'string' ? { version: b.version.slice(0, 64) } : {}),
      ...(typeof b.pullIntervalMs === 'number' && b.pullIntervalMs > 0 ? { pullIntervalMs: b.pullIntervalMs } : {}),
      ...(servers && typeof servers.online === 'number' && typeof servers.total === 'number' ? { servers: { online: servers.online, total: servers.total } } : {}),
      ...(typeof b.lastError === 'string' ? { lastError: b.lastError.slice(0, 500) } : {}),
      ...(req.ip ? { address: req.ip } : {}),
    });
    const etag = current().etag;
    res.json({ ok: true, configEtag: etag, inSync: b.configEtag === etag });
  });

  router.delete('/admin/data-planes/:nodeId', ...guard, (req, res) => {
    const nodeId = String(req.params.nodeId);
    if (!nodes.delete(nodeId)) return void res.status(404).json({ error: 'Not Found', message: `Unknown data plane "${nodeId}"` });
    res.json({ removed: nodeId });
  });

  return router;
}

export interface DataPlaneStatus {
  role: 'data';
  nodeId: string;
  controlPlane: string;
  ready: boolean;
  configEtag?: string;
  lastPullAt?: string;
  lastAppliedAt?: string;
  lastHeartbeatAt?: string;
  lastError?: string;
  pulls: number;
  applied: number;
  failures: number;
}

export interface DataPlaneSyncOptions {
  config: ControlPlaneConfig;
  /** Validate + hot-apply a pulled config (throws when invalid; the running config is kept). */
  apply: (config: Record<string, unknown>) => Promise<void>;
  servers?: () => { online: number; total: number };
  fetch?: typeof fetch;
}

/** Data-plane side: pulls config from the control plane and sends heartbeats. */
export class DataPlaneSync {
  readonly nodeId: string;
  private etag?: string;
  private timer?: NodeJS.Timeout;
  private running?: Promise<void>;
  private stopped = false;
  private state: Omit<DataPlaneStatus, 'role' | 'nodeId' | 'controlPlane' | 'ready' | 'configEtag'> = { pulls: 0, applied: 0, failures: 0 };

  constructor(private readonly opts: DataPlaneSyncOptions) {
    this.nodeId = opts.config.nodeId ?? `${hostname()}-${randomUUID().slice(0, 8)}`;
  }

  private get base(): string {
    return this.opts.config.url!.replace(/\/+$/, '');
  }

  get ready(): boolean {
    return this.etag !== undefined;
  }

  status(): DataPlaneStatus {
    return { role: 'data', nodeId: this.nodeId, controlPlane: this.base, ready: this.ready, ...(this.etag ? { configEtag: this.etag } : {}), ...this.state };
  }

  start(): void {
    this.stopped = false;
    const tick = () => {
      if (this.stopped) return;
      void this.sync().finally(() => {
        if (!this.stopped) this.timer = setTimeout(tick, this.opts.config.pullIntervalMs ?? 10_000);
        this.timer?.unref?.();
      });
    };
    tick();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    await this.running?.catch(() => undefined);
  }

  /** One pull (+ apply when changed) and one heartbeat. Concurrent calls share the run. */
  sync(): Promise<void> {
    if (this.running) return this.running;
    this.running = this.run().finally(() => (this.running = undefined));
    return this.running;
  }

  private async run(): Promise<void> {
    const f = this.opts.fetch ?? fetch;
    const headers = { authorization: `Bearer ${this.opts.config.token}`, 'content-type': 'application/json' };
    try {
      this.state.pulls++;
      const res = await f(`${this.base}/api/v1/admin/data-planes/config`, { headers: { ...headers, ...(this.etag ? { 'if-none-match': this.etag } : {}) }, signal: AbortSignal.timeout(10_000) });
      this.state.lastPullAt = new Date().toISOString();
      if (res.status === 200) {
        const body = (await res.json()) as { etag?: string; config?: Record<string, unknown> };
        if (!body.config || typeof body.config !== 'object') throw new Error('control plane sent no config');
        await this.opts.apply(body.config);
        this.etag = body.etag ?? res.headers.get('etag') ?? undefined;
        this.state.applied++;
        this.state.lastAppliedAt = new Date().toISOString();
        logger.info(`Data plane ${this.nodeId}: applied config ${this.etag} from ${this.base}`);
      } else if (res.status !== 304) {
        const text = await res.text().catch(() => '');
        throw new Error(`config pull failed: HTTP ${res.status}${text ? ` ${text.slice(0, 200)}` : ''}`);
      }
      delete this.state.lastError;
    } catch (err) {
      this.state.failures++;
      this.state.lastError = err instanceof Error ? err.message : String(err);
      logger.warn(`Data plane ${this.nodeId}: ${this.state.lastError} (keeping the current config)`);
    }
    try {
      const res = await f(`${this.base}/api/v1/admin/data-planes/heartbeat`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          nodeId: this.nodeId,
          ...(this.etag ? { configEtag: this.etag } : {}),
          version: VERSION,
          pullIntervalMs: this.opts.config.pullIntervalMs ?? 10_000,
          ...(this.opts.servers ? { servers: this.opts.servers() } : {}),
          ...(this.state.lastError ? { lastError: this.state.lastError } : {}),
        }),
        signal: AbortSignal.timeout(10_000),
      });
      await res.text().catch(() => '');
      if (res.ok) this.state.lastHeartbeatAt = new Date().toISOString();
    } catch {
      /* the next tick retries */
    }
  }
}
