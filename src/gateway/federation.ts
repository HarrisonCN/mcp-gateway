/**
 * Federated gateways (3.6): peering, catalog sync and cross-region failover.
 *
 * Gateways in different regions peer with each other over HTTPS, authenticated by an HMAC-SHA256 signature with a
 * shared secret (`x-mcp-federation: <gatewayId>:<unix ms>:<hex signature>`, ±5 min clock skew). Each gateway:
 *
 *  - **exports** the servers matching `federation.export` (default all) at `GET /api/v1/federation/catalog`:
 *    id, status, region, tool names;
 *  - **syncs** every peer's catalog every `sync.intervalSeconds` (default 30) and keeps the last good copy;
 *  - **fails over**: a call to a local server matching `failover.servers` that is not connected (or every replica is
 *    down) is forwarded to the healthy peer exporting that server with the lowest `priority`, then latency —
 *    `POST /api/v1/federation/call`, run by the peer under the client id `peer:<gatewayId>`, through its own policy,
 *    quotas and audit;
 *  - **imports** remote-only servers: `POST /api/v1/tools/call` with `server: "<id>@<peer>"` is forwarded explicitly.
 *
 * @module gateway/federation
 */

import { createHash, createHmac, timingSafeEqual } from 'crypto';
import type { FederationConfig, ProxyResponse } from '../utils/types.js';
import { globToRegExp } from '../utils/tool-filter.js';
import { logger } from '../utils/logger.js';
import { ERR_NOT_CONNECTED, markTransportFailure } from '../proxy/index.js';

export const FEDERATION_HEADER = 'x-mcp-federation';
export const MAX_SKEW_MS = 5 * 60_000;

export interface ExportedServer {
  id: string;
  name?: string;
  status: string;
  tools: string[];
}

export interface PeerCatalog {
  gatewayId: string;
  region?: string;
  version?: string;
  servers: ExportedServer[];
}

export interface PeerState {
  id: string;
  url: string;
  region?: string;
  priority: number;
  healthy: boolean;
  lastSync?: string;
  lastError?: string;
  latencyMs?: number;
  servers: ExportedServer[];
  forwarded: number;
}

const bodyHash = (body: string) => createHash('sha256').update(body).digest('hex');

/** Signature header value for a request. */
export function signFederation(gatewayId: string, secret: string, method: string, path: string, body: string, now = Date.now()): string {
  const sig = createHmac('sha256', secret).update(`${gatewayId}.${now}.${method.toUpperCase()} ${path}.${bodyHash(body)}`).digest('hex');
  return `${gatewayId}:${now}:${sig}`;
}

/** Verify a signature header; returns the peer's gateway id, or an error message. */
export function verifyFederation(
  header: string | undefined,
  secret: string,
  method: string,
  path: string,
  body: string,
  now = Date.now(),
): { peer: string } | { error: string } {
  if (!header) return { error: 'missing federation signature' };
  const m = /^([A-Za-z0-9_.-]+):(\d+):([0-9a-f]{64})$/.exec(header);
  if (!m) return { error: 'malformed federation signature' };
  const ts = Number(m[2]);
  if (Math.abs(now - ts) > MAX_SKEW_MS) return { error: 'federation signature expired' };
  const expected = createHmac('sha256', secret).update(`${m[1]}.${ts}.${method.toUpperCase()} ${path}.${bodyHash(body)}`).digest();
  const got = Buffer.from(m[3]!, 'hex');
  if (got.length !== expected.length || !timingSafeEqual(got, expected)) return { error: 'bad federation signature' };
  return { peer: m[1]! };
}

export interface FederationDeps {
  config: () => FederationConfig | undefined;
  /** Local servers to export (already filtered to enabled, non-replica servers). */
  localServers: () => ExportedServer[];
  version: string;
  fetch?: typeof fetch;
  now?: () => number;
}

export class Federation {
  private readonly peers = new Map<string, PeerState>();
  private timer?: NodeJS.Timeout;

  constructor(private readonly deps: FederationDeps) {
    this.refreshPeers();
  }

  get enabled(): boolean {
    const c = this.deps.config();
    return !!c && c.enabled !== false;
  }

  get gatewayId(): string {
    return this.deps.config()?.gatewayId ?? 'gateway';
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  private secret(): string {
    return this.deps.config()?.sharedSecret ?? '';
  }

  /** Re-read the peer list (hot reload), keeping the state of peers that stay. */
  refreshPeers(): void {
    const cfg = this.deps.config();
    const next = new Map<string, PeerState>();
    for (const p of cfg?.peers ?? []) {
      const prev = this.peers.get(p.id);
      next.set(p.id, prev ? { ...prev, url: p.url, region: p.region, priority: p.priority ?? 100 } : { id: p.id, url: p.url, region: p.region, priority: p.priority ?? 100, healthy: false, servers: [], forwarded: 0 });
    }
    this.peers.clear();
    for (const [k, v] of next) this.peers.set(k, v);
  }

  /** What this gateway exports to its peers. */
  catalog(): PeerCatalog {
    const exp = this.deps.config()?.export ?? ['*'];
    const res = exp.map((g) => globToRegExp(g));
    return {
      gatewayId: this.gatewayId,
      region: this.deps.config()?.region,
      version: this.deps.version,
      servers: this.deps.localServers().filter((s) => res.some((r) => r.test(s.id))),
    };
  }

  private async signedFetch(peer: PeerState, method: 'GET' | 'POST', path: string, body = '', timeoutMs = 10_000): Promise<Response> {
    const url = `${peer.url.replace(/\/+$/, '')}${path}`;
    const f = this.deps.fetch ?? fetch;
    return f(url, {
      method,
      headers: { [FEDERATION_HEADER]: signFederation(this.gatewayId, this.secret(), method, path, body, this.now()), ...(body ? { 'content-type': 'application/json' } : {}) },
      ...(body ? { body } : {}),
      signal: AbortSignal.timeout(timeoutMs),
    });
  }

  /** Pull every peer's catalog once. */
  async sync(): Promise<void> {
    await Promise.all(
      [...this.peers.values()].map(async (peer) => {
        const t0 = this.now();
        try {
          const r = await this.signedFetch(peer, 'GET', '/api/v1/federation/catalog');
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          const cat = (await r.json()) as PeerCatalog;
          if (!Array.isArray(cat.servers)) throw new Error('malformed catalog');
          const imp = (this.deps.config()?.import ?? ['*']).map((g) => globToRegExp(g));
          peer.servers = cat.servers.filter((s) => imp.some((re) => re.test(s.id)));
          peer.region = peer.region ?? cat.region;
          peer.healthy = true;
          peer.lastError = undefined;
          peer.lastSync = new Date(this.now()).toISOString();
          const ms = Math.max(0, this.now() - t0);
          peer.latencyMs = peer.latencyMs === undefined ? ms : Math.round(peer.latencyMs * 0.7 + ms * 0.3);
        } catch (err) {
          if (peer.healthy) logger.warn(`Federation peer "${peer.id}" is unreachable: ${err instanceof Error ? err.message : String(err)}`);
          peer.healthy = false;
          peer.lastError = err instanceof Error ? err.message : String(err);
        }
      }),
    );
  }

  start(): void {
    this.stop();
    if (!this.enabled || this.peers.size === 0) return;
    void this.sync();
    const sec = this.deps.config()?.sync?.intervalSeconds ?? 30;
    this.timer = setInterval(() => void this.sync(), sec * 1000);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** Whether a local server is exported to peers. */
  exports(serverId: string): boolean {
    return (this.deps.config()?.export ?? ['*']).some((g) => globToRegExp(g).test(serverId));
  }

  /** Whether calls to a local server may fail over to peers. */
  failsOver(serverId: string): boolean {
    if (!this.enabled) return false;
    const f = this.deps.config()?.failover;
    if (!f || f.enabled === false) return false;
    return (f.servers ?? ['*']).some((g) => globToRegExp(g).test(serverId));
  }

  /** Healthy peers exporting an online server, best first. */
  candidates(serverId: string, tool?: string): PeerState[] {
    return [...this.peers.values()]
      .filter((p) => p.healthy && p.servers.some((s) => s.id === serverId && s.status === 'online' && (!tool || s.tools.includes(tool))))
      .sort((a, b) => a.priority - b.priority || (a.latencyMs ?? 1e9) - (b.latencyMs ?? 1e9));
  }

  peer(id: string): PeerState | undefined {
    return this.peers.get(id);
  }

  /** Forward a tool call to a peer. */
  async forward(peer: PeerState, req: { server: string; tool: string; arguments: Record<string, unknown>; clientId?: string; tenant?: string }, timeoutMs = 30_000): Promise<ProxyResponse & { peer: string }> {
    const t0 = this.now();
    const body = JSON.stringify({ server: req.server, tool: req.tool, arguments: req.arguments, origin: { clientId: req.clientId, tenant: req.tenant } });
    peer.forwarded++;
    try {
      const r = await this.signedFetch(peer, 'POST', '/api/v1/federation/call', body, timeoutMs);
      const out = (await r.json().catch(() => ({}))) as { result?: unknown; error?: { code?: number; message?: string } | string; message?: string; code?: number };
      const durationMs = Math.max(0, this.now() - t0);
      if (r.ok) return { success: true, result: out.result, durationMs, peer: peer.id };
      const err = typeof out.error === 'object' && out.error ? out.error : { code: out.code, message: out.message ?? (typeof out.error === 'string' ? out.error : `HTTP ${r.status}`) };
      return { success: false, error: { code: err.code ?? -32603, message: `[${peer.id}] ${err.message}` }, durationMs, peer: peer.id };
    } catch (err) {
      peer.healthy = false;
      peer.lastError = err instanceof Error ? err.message : String(err);
      return markTransportFailure({ success: false, error: { code: ERR_NOT_CONNECTED, message: `[${peer.id}] unreachable: ${peer.lastError}` }, durationMs: Math.max(0, this.now() - t0), peer: peer.id }, 'not-connected');
    }
  }

  snapshot(): { enabled: boolean; gatewayId: string; region?: string; peers: PeerState[] } {
    return { enabled: this.enabled, gatewayId: this.gatewayId, region: this.deps.config()?.region, peers: [...this.peers.values()].map((p) => ({ ...p, servers: [...p.servers] })) };
  }
}
