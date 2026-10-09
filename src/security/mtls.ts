/**
 * Zero-trust upstream connections: mTLS with SPIFFE identities and certificate rotation (4.5).
 *
 * ```yaml
 * mtls:
 *   identity:                       # the gateway's own X.509-SVID (e.g. written by spiffe-helper / SPIRE agent)
 *     cert: /run/spire/svid.pem
 *     key: /run/spire/svid_key.pem
 *     bundle: /run/spire/bundle.pem # trust bundle (CA certificates) for upstream servers
 *   reloadIntervalSeconds: 60       # re-read the files; a changed certificate is rotated in without a restart
 * servers:
 *   - id: search
 *     url: https://search.internal:8443/mcp
 *     tls:
 *       spiffeId: spiffe://example.org/ns/tools/sa/search   # required peer identity (globs allowed)
 * ```
 *
 * Upstream HTTPS connections of a server with `tls` (or of every HTTPS server when `mtls.requireForAll`) present the
 * gateway's certificate and verify the peer against the trust bundle; with `spiffeId` the peer's URI SAN must match
 * (hostname checks are replaced by the workload identity). Files are re-read every `reloadIntervalSeconds`; a new
 * certificate replaces the connection pool so new connections use it, and the rotation is logged and reported.
 *
 * @module security/mtls
 */

import { createHash, createPrivateKey, X509Certificate } from 'crypto';
import { readFileSync } from 'fs';
import { isAbsolute, resolve } from 'path';
import { Agent, fetch as undiciFetch } from 'undici';
import { globToRegExp } from '../utils/tool-filter.js';
import { logger } from '../utils/logger.js';

export interface MtlsIdentityConfig {
  /** PEM certificate chain (path, or inline PEM). */
  cert: string;
  /** PEM private key (path, or inline PEM). */
  key: string;
  /** PEM CA bundle used to verify upstream servers (path, or inline PEM). */
  bundle?: string;
}

export interface MtlsConfig {
  identity?: MtlsIdentityConfig;
  /** Re-read identity files this often (default 60; 0 disables). */
  reloadIntervalSeconds?: number;
  /** Use mTLS for every HTTPS upstream, not only servers with `tls`. */
  requireForAll?: boolean;
  /** Warn when the identity certificate expires within this many hours (default 24). */
  expiryWarningHours?: number;
}

export interface ServerTlsConfig {
  /** Expected SPIFFE ID of the upstream (URI SAN); globs allowed. */
  spiffeId?: string;
  /** Override the CA bundle for this server. */
  ca?: string;
  /** SNI / hostname to verify when no `spiffeId` is set. */
  servername?: string;
  /** Present the gateway identity (default true when `mtls.identity` is set). */
  clientCert?: boolean;
}

export type FetchLike = typeof globalThis.fetch;

/** Load a PEM from inline text or a file path. */
export function loadPem(v: string, baseDir: string): string {
  if (v.includes('-----BEGIN')) return v;
  return readFileSync(isAbsolute(v) ? v : resolve(baseDir, v), 'utf8');
}

/** SPIFFE IDs (URI SANs starting with `spiffe://`) of a certificate. */
export function spiffeIdsOf(cert: X509Certificate | { subjectaltname?: string }): string[] {
  const san = cert instanceof X509Certificate ? (cert.subjectAltName ?? '') : (cert.subjectaltname ?? '');
  return san
    .split(/,\s*/)
    .filter((p) => p.startsWith('URI:spiffe://'))
    .map((p) => p.slice(4));
}

export function spiffeMatches(pattern: string, ids: string[]): boolean {
  const re = globToRegExp(pattern);
  return ids.some((id) => re.test(id));
}

export interface IdentityStatus {
  spiffeId?: string;
  subject: string;
  notAfter: string;
  fingerprint: string;
  expiresInHours: number;
  loadedAt: string;
  rotations: number;
  error?: string;
}

export class MtlsManager {
  private material?: { cert: string; key: string; bundle?: string; hash: string; x509: X509Certificate };
  private agents = new Map<string, Agent>();
  private rotations = 0;
  private loadedAt = 0;
  private error?: string;
  private timer?: NodeJS.Timeout;
  private readonly peers = new Map<string, { spiffeIds: string[]; at: string }>();

  constructor(
    private readonly config: () => MtlsConfig | undefined,
    private readonly baseDir: () => string = () => process.cwd(),
    private readonly now: () => number = Date.now,
  ) {}

  get enabled(): boolean {
    return !!this.config()?.identity;
  }

  /** (Re)load the identity; returns true when the certificate changed. */
  reload(): boolean {
    const id = this.config()?.identity;
    if (!id) {
      this.material = undefined;
      return false;
    }
    try {
      const cert = loadPem(id.cert, this.baseDir());
      const key = loadPem(id.key, this.baseDir());
      const bundle = id.bundle ? loadPem(id.bundle, this.baseDir()) : undefined;
      const hash = createHash('sha256').update(cert).update(key).update(bundle ?? '').digest('hex');
      if (this.material?.hash === hash) return false;
      const x509 = new X509Certificate(cert);
      if (!x509.checkPrivateKey(createPrivateKeyFromPem(key))) throw new Error('identity key does not match the certificate');
      const first = !this.material;
      this.material = { cert, key, bundle, hash, x509 };
      this.loadedAt = this.now();
      this.error = undefined;
      const old = this.agents;
      this.agents = new Map();
      for (const a of old.values()) void a.close().catch(() => undefined);
      if (!first) {
        this.rotations++;
        logger.info(`mTLS identity rotated (${spiffeIdsOf(x509)[0] ?? x509.subject}, valid until ${x509.validTo})`);
      }
      const hours = (Date.parse(x509.validTo) - this.now()) / 3_600_000;
      if (hours < (this.config()?.expiryWarningHours ?? 24)) logger.warn(`mTLS identity certificate expires in ${Math.max(0, Math.round(hours))}h`);
      return !first;
    } catch (err) {
      this.error = err instanceof Error ? err.message : String(err);
      logger.error(`mTLS identity not loaded: ${this.error}`);
      return false;
    }
  }

  start(): void {
    this.reload();
    const s = this.config()?.reloadIntervalSeconds ?? 60;
    if (this.timer || !this.enabled || s <= 0) return;
    this.timer = setInterval(() => this.reload(), s * 1000);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    for (const a of this.agents.values()) void a.close().catch(() => undefined);
    this.agents.clear();
  }

  /** Does this server use mTLS? */
  applies(server: { id: string; url?: string; tls?: ServerTlsConfig }): boolean {
    if (!server.url?.startsWith('https:')) return false;
    return !!server.tls || (!!this.config()?.requireForAll && this.enabled);
  }

  private agentFor(server: { id: string; url?: string; tls?: ServerTlsConfig }): Agent {
    const tls = server.tls ?? {};
    const groups = upstreamTlsGroups(server);
    const key = `${server.id}\u0000${JSON.stringify(tls)}\u0000${groups ?? ''}`;
    let agent = this.agents.get(key);
    if (agent) return agent;
    if (!this.material && this.enabled) this.reload();
    const m = this.material;
    const ca = tls.ca ? loadPem(tls.ca, this.baseDir()) : m?.bundle;
    const presentCert = tls.clientCert !== false && m;
    agent = new Agent({
      connect: {
        ...(ca ? { ca } : {}),
        ...(presentCert ? { cert: m.cert, key: m.key } : {}),
        ...(tls.servername ? { servername: tls.servername } : {}),
        ...(groups ? { ecdhCurve: groups } : {}),
        rejectUnauthorized: true,
        ...(tls.spiffeId
          ? {
              // Zero trust: the workload identity replaces the hostname check.
              checkServerIdentity: (_host: string, peer: { subjectaltname?: string }) => {
                const ids = spiffeIdsOf(peer);
                this.peers.set(server.id, { spiffeIds: ids, at: new Date(this.now()).toISOString() });
                return spiffeMatches(tls.spiffeId!, ids) ? undefined : new Error(`peer SPIFFE ID ${ids.join(', ') || '(none)'} does not match ${tls.spiffeId}`);
              },
            }
          : {}),
      },
    });
    this.agents.set(key, agent);
    return agent;
  }

  /** `fetch` for a server's upstream requests (global fetch when mTLS does not apply). */
  fetchFor(server: { id: string; url?: string; tls?: ServerTlsConfig }): FetchLike {
    if (!this.applies(server)) return globalThis.fetch;
    return ((input: string | URL, init?: RequestInit) => undiciFetch(input as string, { ...(init as object), dispatcher: this.agentFor(server) } as never)) as unknown as FetchLike;
  }

  status(): { enabled: boolean; identity?: IdentityStatus; peers: Array<{ server: string; spiffeIds: string[]; at: string }> } {
    const m = this.material;
    return {
      enabled: this.enabled,
      ...(m || this.error
        ? {
            identity: m
              ? {
                  spiffeId: spiffeIdsOf(m.x509)[0],
                  subject: m.x509.subject,
                  notAfter: new Date(m.x509.validTo).toISOString(),
                  fingerprint: m.x509.fingerprint256,
                  expiresInHours: Math.round((Date.parse(m.x509.validTo) - this.now()) / 3_600_000),
                  loadedAt: new Date(this.loadedAt).toISOString(),
                  rotations: this.rotations,
                  ...(this.error ? { error: this.error } : {}),
                }
              : ({ subject: '', notAfter: '', fingerprint: '', expiresInHours: 0, loadedAt: '', rotations: this.rotations, error: this.error } as IdentityStatus),
          }
        : {}),
      peers: [...this.peers].map(([server, p]) => ({ server, ...p })),
    };
  }
}

function createPrivateKeyFromPem(pem: string) {
  return createPrivateKey(pem);
}

/** Process-wide hook used by the HTTP transports (set by the gateway). */
let current: MtlsManager | undefined;
export function setUpstreamTls(m: MtlsManager | undefined): void {
  current = m;
}
export function upstreamFetch(server: { id: string; url?: string; tls?: ServerTlsConfig }): FetchLike {
  if (current?.applies(server)) return current.fetchFor(server);
  const groups = upstreamTlsGroups(server);
  if (!groups) return globalThis.fetch;
  let agent = groupAgents.get(groups);
  if (!agent) groupAgents.set(groups, (agent = new Agent({ connect: { ecdhCurve: groups } })));
  const dispatcher = agent;
  return ((input: string | URL, init?: RequestInit) => undiciFetch(input as string, { ...(init as object), dispatcher } as never)) as unknown as FetchLike;
}

/** TLS key-exchange groups for upstream HTTPS connections (9.7 post-quantum TLS), e.g. `X25519MLKEM768:X25519`. */
let groupsFor: ((server: { id: string; url?: string }) => string | undefined) | undefined;
const groupAgents = new Map<string, Agent>();
export function setUpstreamTlsGroups(fn: ((server: { id: string; url?: string }) => string | undefined) | undefined): void {
  groupsFor = fn;
  for (const a of groupAgents.values()) void a.close().catch(() => {});
  groupAgents.clear();
}
export function upstreamTlsGroups(server: { id: string; url?: string }): string | undefined {
  return server.url?.startsWith('https:') ? groupsFor?.(server) : undefined;
}
