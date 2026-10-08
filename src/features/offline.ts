/**
 * Offline desktop gateway (7.6): run mcp-gateway on a laptop in front of local MCP servers, with policies enforced
 * locally and a clean failure mode when the network is gone.
 *
 * - **Import** the MCP servers of Claude Desktop, Cursor, VS Code or Windsurf ({@link importDesktopServers}):
 *   `{ mcpServers: { name: { command, args, env } | { url } } }` (VS Code: `servers`, `type`).
 * - **Desktop profile** ({@link desktopConfig} / `mcp-gateway desktop`): `127.0.0.1`, a generated API key, schema v8,
 *   the imported servers and `offline` on.
 * - **Offline mode** (`offline`): the gateway probes `probeUrl` every `probeIntervalMs` (or is switched by hand). While
 *   offline, calls to **remote** upstreams (`streamable-http`, `sse`, `websocket`) fail fast with JSON-RPC error
 *   **-32018** instead of hanging until the timeout; local `stdio` servers, policies, approvals, DLP and the audit log
 *   keep working. `allowRemote` lists remote server globs that are still tried (e.g. a LAN server).
 *
 * ```yaml
 * offline:
 *   mode: auto                  # auto (probe) | online | offline
 *   probeUrl: https://1.1.1.1/
 *   probeIntervalMs: 15000
 *   allowRemote: ["nas-*"]
 * ```
 *
 * - `GET  /admin/offline` — state (`offline`, `mode`, last probe), local / remote servers.
 * - `POST /admin/offline` — `{ mode: "auto" | "online" | "offline" }` (runtime override).
 * - `POST /admin/offline/import` — `{ config: <desktop client JSON> }` → gateway `servers` (no change applied).
 *
 * @module features/offline
 */

import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { registerFeature, objectBody, badRequest } from '../gateway/features.js';
import { registerCallHook } from '../gateway/hooks.js';
import { globToRegExp } from '../utils/tool-filter.js';
import type { GatewayConfig, McpServerConfig } from '../utils/types.js';

export const ERR_OFFLINE = -32018;

export const OfflineSchema = z
  .object({
    enabled: z.boolean().default(true),
    mode: z.enum(['auto', 'online', 'offline']).default('auto'),
    probeUrl: z.string().url().default('https://1.1.1.1/'),
    probeIntervalMs: z.number().int().min(1000).max(3_600_000).default(15_000),
    probeTimeoutMs: z.number().int().min(100).max(60_000).default(3000),
    allowRemote: z.array(z.string().min(1)).default([]),
  })
  .strict();
export type OfflineConfig = z.input<typeof OfflineSchema>;
type Cfg = z.output<typeof OfflineSchema>;

const settings = (cfg: GatewayConfig): Cfg | undefined => {
  if (!cfg.offline) return undefined;
  const c = OfflineSchema.parse(cfg.offline);
  return c.enabled ? c : undefined;
};

export const isRemote = (s: Pick<McpServerConfig, 'transport'>) => s.transport !== 'stdio';

/** Connectivity state shared by the hook and the admin API. */
export const offlineState = {
  /** Last probe result (`undefined` before the first probe). */
  reachable: undefined as boolean | undefined,
  lastProbeAt: undefined as string | undefined,
  lastError: undefined as string | undefined,
  override: undefined as Cfg['mode'] | undefined,
  refused: 0,
};

/** Whether the gateway currently treats the network as gone. */
export function isOffline(c: Cfg): boolean {
  const mode = offlineState.override ?? c.mode;
  if (mode === 'offline') return true;
  if (mode === 'online') return false;
  return offlineState.reachable === false;
}

/** One probe: any HTTP answer means online. */
export async function probe(c: Cfg, fetchImpl: typeof fetch = fetch): Promise<boolean> {
  try {
    const res = await fetchImpl(c.probeUrl, { method: 'HEAD', signal: AbortSignal.timeout(c.probeTimeoutMs), redirect: 'manual' });
    await res.arrayBuffer().catch(() => undefined);
    offlineState.lastError = undefined;
    offlineState.reachable = true;
  } catch (err) {
    offlineState.lastError = err instanceof Error ? err.message : String(err);
    offlineState.reachable = false;
  }
  offlineState.lastProbeAt = new Date().toISOString();
  return offlineState.reachable;
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'server';

/** Desktop-client MCP config (Claude Desktop, Cursor, Windsurf: `mcpServers`; VS Code: `servers`) → gateway servers. */
export function importDesktopServers(json: unknown): { servers: McpServerConfig[]; skipped: string[] } {
  const root = (json && typeof json === 'object' ? json : {}) as Record<string, unknown>;
  const src = (root.mcpServers ?? root.servers ?? (root.mcp as Record<string, unknown> | undefined)?.servers ?? {}) as Record<string, Record<string, unknown>>;
  const servers: McpServerConfig[] = [];
  const skipped: string[] = [];
  const ids = new Set<string>();
  for (const [name, s] of Object.entries(src)) {
    if (!s || typeof s !== 'object' || s.disabled === true) {
      skipped.push(name);
      continue;
    }
    let id = slug(name);
    for (let i = 2; ids.has(id); i++) id = `${slug(name)}-${i}`;
    ids.add(id);
    if (typeof s.command === 'string') {
      servers.push({
        id,
        name,
        transport: 'stdio',
        command: s.command,
        ...(Array.isArray(s.args) ? { args: s.args.map(String) } : {}),
        ...(s.env && typeof s.env === 'object' ? { env: Object.fromEntries(Object.entries(s.env as Record<string, unknown>).map(([k, v]) => [k, String(v)])) } : {}),
      } as McpServerConfig);
    } else if (typeof s.url === 'string' || typeof s.serverUrl === 'string') {
      const url = String(s.url ?? s.serverUrl);
      const transport = s.type === 'sse' || s.transport === 'sse' || /\/sse\/?$/.test(url) ? 'sse' : 'streamable-http';
      servers.push({ id, name, transport, url, ...(s.headers && typeof s.headers === 'object' ? { headers: s.headers as Record<string, string> } : {}) } as McpServerConfig);
    } else skipped.push(name);
  }
  return { servers, skipped };
}

/** A desktop profile: loopback only, generated operator key, imported servers, offline mode on. */
export function desktopConfig(opts: { servers?: McpServerConfig[]; apiKey?: string; port?: number } = {}): { config: Record<string, unknown>; apiKey: string } {
  const apiKey = opts.apiKey ?? `mgw_${randomBytes(24).toString('base64url')}`;
  const servers = (opts.servers ?? []).map((s) => {
    const { timeout, ...rest } = s as McpServerConfig & { timeout?: number };
    return timeout ? { ...rest, timeoutMs: timeout } : rest;
  });
  return {
    apiKey,
    config: {
      version: 8,
      host: '127.0.0.1',
      port: opts.port ?? 4000,
      auth: { strategy: 'api-key', apiKeys: [apiKey] },
      controlPlane: { dashboard: true },
      offline: { mode: 'auto' },
      servers,
    },
  };
}

registerCallHook({
  id: 'offline',
  before: (call, cfg) => {
    const c = settings(cfg);
    if (!c || !isOffline(c)) return;
    const s = cfg.servers.find((x) => x.id === call.serverId);
    if (!s || !isRemote(s) || c.allowRemote.some((p) => globToRegExp(p).test(s.id))) return;
    offlineState.refused++;
    return { refuse: { code: ERR_OFFLINE, message: `Offline: remote server "${s.id}" is not reachable without a network (local servers keep working)`, data: { server: s.id, mode: offlineState.override ?? c.mode } } };
  },
});

registerFeature({
  id: 'offline',
  since: '7.6.0',
  summary: 'Offline desktop gateway: connectivity probe, fail-fast for remote upstreams when offline, desktop-client config import',
  mount: (router, ctx) => {
    let timer: NodeJS.Timeout | undefined;
    let stopped = false;
    const loop = async () => {
      const c = settings(ctx.config());
      if (c && c.mode === 'auto') await probe(c);
      if (!stopped) timer = setTimeout(() => void loop(), c?.probeIntervalMs ?? 15_000);
      timer?.unref?.();
    };
    if (settings(ctx.config())) void loop();
    ctx.onStop?.(() => {
      stopped = true;
      if (timer) clearTimeout(timer);
    });
    const status = () => {
      const c = settings(ctx.config());
      const servers = ctx.config().servers;
      return {
        enabled: !!c,
        mode: offlineState.override ?? c?.mode ?? null,
        configuredMode: c?.mode ?? null,
        offline: c ? isOffline(c) : false,
        lastProbeAt: offlineState.lastProbeAt ?? null,
        reachable: offlineState.reachable ?? null,
        ...(offlineState.lastError ? { lastError: offlineState.lastError } : {}),
        refused: offlineState.refused,
        servers: { local: servers.filter((s) => !isRemote(s)).map((s) => s.id), remote: servers.filter(isRemote).map((s) => s.id), allowRemote: c?.allowRemote ?? [] },
      };
    };
    router.get('/', (_req, res) => void res.json(status()));
    router.post('/', async (req, res) => {
      const b = objectBody(req, res);
      if (!b) return;
      if (!['auto', 'online', 'offline'].includes(String(b.mode))) return badRequest(res, 'Body must be { "mode": "auto" | "online" | "offline" }');
      const c = settings(ctx.config());
      if (!c) return void res.status(404).json({ error: 'Not Found', message: 'Offline mode is off (configure `offline`)' });
      offlineState.override = b.mode === c.mode ? undefined : (b.mode as Cfg['mode']);
      if (b.mode === 'auto') await probe(c);
      res.json(status());
    });
    router.post('/import', (req, res) => {
      const b = objectBody(req, res);
      if (!b) return;
      if (!b.config || typeof b.config !== 'object') return badRequest(res, 'Body must be { "config": <desktop client MCP config> }');
      res.json(importDesktopServers(b.config));
    });
  },
});
