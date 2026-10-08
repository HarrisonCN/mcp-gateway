/**
 * Admin REST API (`/api/v1/admin`), operators only (callers without key scopes / tenant restrictions).
 *
 * - `GET  /admin/config` — the running configuration, secrets `<redacted>`.
 * - `POST /admin/config/validate` — validate a config body; returns errors and deprecations.
 * - `POST /admin/config/diff` — structural diff between the running config and a body.
 * - `PUT  /admin/config[?dryRun=true]` — validate, diff and hot-apply a full config (`controlPlane.configApi: true`).
 *   `<redacted>` values keep the running value, so a GET → edit → PUT round trip works.
 * - `POST /admin/reload` — re-read the config file from disk (`controlPlane.configApi: true`; CLI-started gateways).
 * - `GET  /admin/deprecations` — deprecated config keys and runtime usages (each with its `removedIn`).
 * - `GET  /admin/store` — the shared store backend; for `eventlog` (9.0) keys, events and snapshot stats.
 * - `POST /admin/store/compact` — write a snapshot and truncate the event log (`eventlog` only).
 *
 * The config is validated with the same schema as files; `policy.files` in a body resolve against the running
 * config's directory. Changes to restart-only fields are reported with `restart: true` and not applied.
 *
 * @module gateway/admin
 */

import express, { type Request, type RequestHandler, type Response } from 'express';
import type { GatewayConfig } from '../utils/types.js';
import { loadPolicyFiles, validateConfig } from '../config/loader.js';
import { diffConfigs, redactConfig, restoreRedacted } from '../config/diff.js';
import { runtimeDeprecations } from '../utils/deprecations.js';
import { VERSION } from '../utils/version.js';

export interface AdminDeps {
  config: () => GatewayConfig;
  apply: (next: GatewayConfig) => Promise<void>;
  reloadFromDisk?: () => Promise<GatewayConfig>;
  authenticate: RequestHandler;
  isOperator: (req: Request) => boolean;
  /** The shared state store (9.0: `GET /admin/store`). */
  store?: () => { kind: string; stats?: () => unknown; compact?: () => void } | undefined;
}

/** Strip loader-set fields so a running config can be re-validated. */
export function portableConfig(cfg: GatewayConfig): Record<string, unknown> {
  const { configDir: _d, deprecations: _x, ...rest } = cfg;
  const out = JSON.parse(JSON.stringify(rest)) as Record<string, unknown>;
  // 4.0: API-key scope is nested in the schema (internals keep it flat).
  const auth = out.auth as { apiKeys?: unknown[] } | undefined;
  if (auth?.apiKeys) {
    auth.apiKeys = auth.apiKeys.map((k) => {
      if (!k || typeof k !== 'object') return k;
      const { servers, tools, rateLimit, ...key } = k as Record<string, unknown>;
      const scope = Object.fromEntries(Object.entries({ servers, tools, rateLimit }).filter(([, v]) => v !== undefined));
      return Object.keys(scope).length ? { ...key, scope } : key;
    });
  }
  // Schema v9 (9.0) names the shared store `store` (`backend`); internals keep `state` (`store`).
  if (out.state && typeof out.state === 'object') {
    const { store, ...st } = out.state as Record<string, unknown>;
    out.store = { ...(store !== undefined ? { backend: store } : {}), ...st };
    delete out.state;
  }
  // Schema v5: servers use `timeoutMs` (internally `timeout`).
  if (Array.isArray(out.servers)) {
    out.servers = (out.servers as Array<Record<string, unknown>>).map((s) => {
      if (!s || typeof s !== 'object' || !('timeout' in s)) return s;
      const { timeout, ...rest } = s;
      return { ...rest, timeoutMs: timeout };
    });
  }
  return out;
}

/** The running config with schema defaults applied (embedders may pass unvalidated objects), for diffs. */
function normalized(cfg: GatewayConfig): Record<string, unknown> {
  const p = portableConfig(cfg);
  delete p.port;
  delete p.host;
  try {
    const v = portableConfig(validateConfig(p));
    delete v.port;
    delete v.host;
    if (cfg.policy) v.policy = p.policy; // keep merged policy files as they are
    return v;
  } catch {
    return p;
  }
}

export const diffAgainst = (current: GatewayConfig, next: GatewayConfig) => diffConfigs(normalized(current), normalized(next));

/** Validate a full config in schema form for hot-apply on top of `current` (port / host / configDir kept; 7.1). */
export async function prepareConfig(raw: Record<string, unknown>, current: GatewayConfig): Promise<GatewayConfig> {
  const r: Record<string, unknown> = { ...raw };
  delete r.configDir;
  delete r.deprecations;
  delete r.port;
  delete r.host;
  const next = validateConfig(r);
  next.configDir = current.configDir;
  if (next.policy?.files?.length) next.policy = await loadPolicyFiles(next.policy, current.configDir ?? process.cwd());
  return { ...next, port: current.port, host: current.host };
}

export function createAdminRouter(deps: AdminDeps): express.Router {
  const router = express.Router();
  const operator: RequestHandler = (req, res, next) =>
    deps.isOperator(req) ? next() : void res.status(403).json({ error: 'Forbidden', message: 'The admin API is for operators (unscoped keys)' });
  const guard = [deps.authenticate, operator];
  const writable: RequestHandler = (_req, res, next) =>
    deps.config().controlPlane?.configApi === true
      ? next()
      : void res.status(403).json({ error: 'Forbidden', message: 'Config changes over the API are disabled (controlPlane.configApi: true enables them)' });

  /** Parse + validate a body against the running config; responds 400 and returns undefined on error. */
  const parse = async (req: Request, res: Response): Promise<GatewayConfig | undefined> => {
    const body = req.body;
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      res.status(400).json({ error: 'Bad Request', message: 'Body must be a configuration object' });
      return undefined;
    }
    const current = deps.config();
    const raw = restoreRedacted(body, portableConfig(current)) as Record<string, unknown>;
    delete raw.configDir;
    delete raw.deprecations;
    // port / host are restart-only and owned by the running process (CLI overrides).
    delete raw.port;
    delete raw.host;
    try {
      let next = validateConfig(raw);
      next.configDir = current.configDir;
      if (next.policy?.files?.length) next.policy = await loadPolicyFiles(next.policy, current.configDir ?? process.cwd());
      // Port / host from the running process win (CLI overrides).
      next = { ...next, port: current.port, host: current.host };
      return next;
    } catch (err) {
      res.status(400).json({ error: 'Bad Request', message: err instanceof Error ? err.message : String(err) });
      return undefined;
    }
  };

  router.get('/admin/config', ...guard, (_req, res) => {
    res.set('Cache-Control', 'no-store').json({ version: VERSION, config: redactConfig(portableConfig(deps.config())) });
  });

  router.post('/admin/config/validate', ...guard, async (req, res, next) => {
    try {
      const body = req.body;
      if (!body || typeof body !== 'object' || Array.isArray(body)) return void res.status(400).json({ error: 'Bad Request', message: 'Body must be a configuration object' });
      try {
        const cfg = validateConfig(restoreRedacted(body, portableConfig(deps.config())));
        res.json({ valid: true, deprecations: cfg.deprecations ?? [] });
      } catch (err) {
        res.json({ valid: false, errors: (err instanceof Error ? err.message : String(err)).split('\n').slice(1).map((l) => l.replace(/^\s*-\s*/, '')) });
      }
    } catch (err) {
      next(err);
    }
  });

  router.post('/admin/config/diff', ...guard, async (req, res, next) => {
    try {
      const nextCfg = await parse(req, res);
      if (!nextCfg) return;
      res.json({ changes: diffAgainst(deps.config(), nextCfg) });
    } catch (err) {
      next(err);
    }
  });

  router.put('/admin/config', ...guard, writable, async (req, res, next) => {
    try {
      const nextCfg = await parse(req, res);
      if (!nextCfg) return;
      const changes = diffAgainst(deps.config(), nextCfg);
      const dryRun = req.query.dryRun === 'true' || req.query.dryRun === '1';
      if (!dryRun && changes.length > 0) await deps.apply(nextCfg);
      res.json({ applied: !dryRun && changes.length > 0, dryRun, changes, deprecations: nextCfg.deprecations ?? [] });
    } catch (err) {
      next(err);
    }
  });

  router.post('/admin/reload', ...guard, writable, async (_req, res, next) => {
    if (!deps.reloadFromDisk) return void res.status(501).json({ error: 'Not Implemented', message: 'This gateway was not started from a config file' });
    try {
      let nextCfg: GatewayConfig;
      try {
        nextCfg = await deps.reloadFromDisk();
      } catch (err) {
        return void res.status(400).json({ error: 'Bad Request', message: err instanceof Error ? err.message : String(err) });
      }
      nextCfg = { ...nextCfg, port: deps.config().port, host: deps.config().host };
      const changes = diffAgainst(deps.config(), nextCfg);
      if (changes.length > 0) await deps.apply(nextCfg);
      res.json({ applied: changes.length > 0, changes });
    } catch (err) {
      next(err);
    }
  });

  router.get('/admin/deprecations', ...guard, (_req, res) => {
    res.json({ config: deps.config().deprecations ?? [], runtime: runtimeDeprecations() });
  });

  // 9.0: shared store status; event-sourced store stats and manual compaction.
  router.get('/admin/store', ...guard, (_req, res) => {
    const s = deps.store?.();
    const cfg = deps.config().state;
    res.json({ backend: s?.kind ?? cfg?.store ?? 'memory', failureMode: cfg?.failureMode ?? 'open', ...(s?.stats ? { eventlog: s.stats() } : {}) });
  });
  router.post('/admin/store/compact', ...guard, (_req, res) => {
    const s = deps.store?.();
    if (!s?.compact) return void res.status(409).json({ error: 'Conflict', message: 'Compaction needs `store.backend: eventlog`' });
    s.compact();
    res.json({ compacted: true, eventlog: s.stats?.() });
  });

  return router;
}
