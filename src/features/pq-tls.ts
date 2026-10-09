/**
 * Post-quantum TLS (9.7): hybrid post-quantum key exchange (X25519MLKEM768, ML-KEM / FIPS 203) for upstream HTTPS
 * connections, upstream probes and a certificate policy.
 *
 * ```yaml
 * postQuantumTls:
 *   mode: prefer                  # prefer: offer PQ hybrid first, fall back to classical; require: PQ only; off
 *   groups: [X25519MLKEM768]      # post-quantum (hybrid) groups, most preferred first
 *   classicalGroups: [X25519, P-256]
 *   servers: ["*"]                # HTTPS upstreams the setting applies to
 *   certificatePolicy:
 *     minRsaBits: 3072
 *     allowedKeyTypes: [ec, ed25519, ed448, rsa, ml-dsa]
 *     maxValidityDays: 398
 *     rejectSha1: true
 * ```
 *
 * Needs a Node.js build with OpenSSL 3.5+ for ML-KEM (Node 22.20+ / 24); `GET /admin/pq-tls` reports `supported`.
 * When the groups are not available the gateway logs it and — in `prefer` mode — keeps classical key exchange; in
 * `require` mode upstream connections fail instead of silently downgrading.
 *
 * - `GET  /admin/pq-tls` — mode, support, effective groups, OpenSSL version, last probe per upstream.
 * - `POST /admin/pq-tls/probe` `{ server? }` — handshake every matching HTTPS upstream (or one) with PQ groups only
 *   (→ `pq: true|false`) and classically, and check its certificate against the policy.
 *
 * @module features/pq-tls
 */

import { connect, createSecureContext, type PeerCertificate } from 'node:tls';
import { X509Certificate } from 'node:crypto';
import { z } from 'zod';
import { registerFeature, badRequest } from '../gateway/features.js';
import { setUpstreamTlsGroups } from '../security/mtls.js';
import { globToRegExp } from '../utils/tool-filter.js';
import { logger } from '../utils/logger.js';
import type { GatewayConfig } from '../utils/types.js';

const GROUP = /^[A-Za-z0-9_-]+$/;
export const PqTlsSchema = z
  .object({
    mode: z.enum(['off', 'prefer', 'require']).default('prefer'),
    groups: z.array(z.string().regex(GROUP)).min(1).default(['X25519MLKEM768']),
    classicalGroups: z.array(z.string().regex(GROUP)).default(['X25519', 'P-256']),
    servers: z.array(z.string().min(1)).default(['*']),
    certificatePolicy: z
      .object({
        minRsaBits: z.number().int().min(1024).default(3072),
        allowedKeyTypes: z.array(z.enum(['ec', 'ed25519', 'ed448', 'rsa', 'rsa-pss', 'ml-dsa'])).default(['ec', 'ed25519', 'ed448', 'rsa', 'rsa-pss', 'ml-dsa']),
        maxValidityDays: z.number().int().min(1).optional(),
        rejectSha1: z.boolean().default(true),
      })
      .strict()
      .default({}),
  })
  .strict();
export type PqTlsConfig = z.input<typeof PqTlsSchema>;
type P = z.output<typeof PqTlsSchema>;

/** Can this Node / OpenSSL negotiate the groups? */
export function groupsSupported(groups: string[]): boolean {
  try {
    createSecureContext({ ecdhCurve: groups.join(':') });
    return true;
  } catch {
    return false;
  }
}

/** Effective `ecdhCurve` list for upstream connections, or undefined (OpenSSL defaults). */
export function effectiveGroups(p: P): string | undefined {
  if (p.mode === 'off') return undefined;
  const pq = p.groups.filter((g) => groupsSupported([g]));
  if (p.mode === 'require') return (pq.length ? pq : p.groups).join(':'); // unsupported → handshakes fail (no downgrade)
  const list = [...pq, ...p.classicalGroups.filter((g) => groupsSupported([g]))];
  return list.length ? list.join(':') : undefined;
}

export interface ProbeResult {
  server: string;
  host: string;
  port: number;
  pq: boolean;
  pqError: string | null;
  protocol: string | null;
  classicalGroup: string | null;
  certificate: { subject: string; keyType: string; bits: number | null; signature: string | null; validTo: string; validityDays: number } | null;
  violations: string[];
  at: string;
}

/** Runtime state; exported for tests. */
export const pqTlsState = {
  probes: new Map<string, ProbeResult>(),
  reset() {
    this.probes.clear();
  },
};

const settings = (cfg: GatewayConfig) => (cfg.postQuantumTls ? PqTlsSchema.parse(cfg.postQuantumTls) : undefined);

function handshake(host: string, port: number, servername: string, ecdhCurve: string, timeoutMs = 5000) {
  return new Promise<{ protocol: string | null; group: string | null; cert: PeerCertificate | null }>((resolve, reject) => {
    const s = connect({ host, port, servername: /^[\d.]+$|:/.test(servername) ? undefined : servername, ecdhCurve, rejectUnauthorized: false, minVersion: 'TLSv1.3' }, () => {
      const info = s.getEphemeralKeyInfo() as { name?: string };
      const out = { protocol: s.getProtocol(), group: info?.name ?? null, cert: s.getPeerCertificate(true) ?? null };
      s.end();
      resolve(out);
    });
    s.setTimeout(timeoutMs, () => s.destroy(new Error(`timeout after ${timeoutMs}ms`)));
    s.on('error', reject);
  });
}

/** Check a peer certificate against the policy. */
export function certificateViolations(raw: Buffer | undefined, p: P['certificatePolicy'], now = Date.now()) {
  if (!raw?.length) return { info: null, violations: ['no peer certificate'] };
  const x = new X509Certificate(raw);
  const k = x.publicKey;
  const keyType = String(k.asymmetricKeyType ?? 'unknown');
  const details = k.asymmetricKeyDetails as { modulusLength?: number; namedCurve?: string } | undefined;
  const bits = details?.modulusLength ?? null;
  const signature = (x as unknown as { signatureAlgorithm?: string }).signatureAlgorithm ?? null;
  const from = Date.parse(x.validFrom);
  const to = Date.parse(x.validTo);
  const validityDays = Math.round((to - from) / 86_400_000);
  const v: string[] = [];
  const type = keyType.startsWith('ml-dsa') ? 'ml-dsa' : keyType;
  if (!p.allowedKeyTypes.includes(type as never)) v.push(`key type ${keyType} is not allowed`);
  if ((keyType === 'rsa' || keyType === 'rsa-pss') && bits !== null && bits < p.minRsaBits) v.push(`RSA key of ${bits} bits < ${p.minRsaBits}`);
  if (p.maxValidityDays !== undefined && validityDays > p.maxValidityDays) v.push(`validity ${validityDays} days > ${p.maxValidityDays}`);
  if (p.rejectSha1 && signature && /sha1/i.test(signature)) v.push(`SHA-1 signature (${signature})`);
  if (to < now) v.push('certificate expired');
  return { info: { subject: x.subject.replace(/\n/g, ', '), keyType, bits, signature, validTo: new Date(to).toISOString(), validityDays }, violations: v };
}

/** Probe one HTTPS upstream. */
export async function probe(cfg: GatewayConfig, server: { id: string; url: string }): Promise<ProbeResult> {
  const p = settings(cfg) ?? PqTlsSchema.parse({});
  const u = new URL(server.url);
  const host = u.hostname.replace(/^\[|\]$/g, '');
  const port = Number(u.port || 443);
  const r: ProbeResult = { server: server.id, host, port, pq: false, pqError: null, protocol: null, classicalGroup: null, certificate: null, violations: [], at: new Date().toISOString() };
  try {
    const pqGroups = p.groups.filter((g) => groupsSupported([g]));
    if (!pqGroups.length) throw new Error(`this Node.js / OpenSSL (${process.versions.openssl}) does not support ${p.groups.join(', ')}`);
    await handshake(host, port, host, pqGroups.join(':'));
    r.pq = true;
  } catch (e) {
    r.pqError = (e as Error).message;
  }
  try {
    const c = await handshake(host, port, host, p.classicalGroups.join(':') || 'X25519');
    r.protocol = c.protocol;
    r.classicalGroup = c.group;
    const cv = certificateViolations((c.cert as { raw?: Buffer } | null)?.raw, p.certificatePolicy);
    r.certificate = cv.info;
    r.violations = cv.violations;
  } catch (e) {
    r.violations = [`classical handshake failed: ${(e as Error).message}`];
  }
  if (p.mode === 'require' && !r.pq) r.violations.unshift('upstream does not negotiate post-quantum key exchange (mode: require)');
  pqTlsState.probes.set(server.id, r);
  return r;
}

const matchedHttps = (cfg: GatewayConfig, p: P) =>
  cfg.servers.filter((s) => typeof s.url === 'string' && s.url.startsWith('https:') && p.servers.some((g) => globToRegExp(g).test(s.id))) as Array<{ id: string; url: string }>;

registerFeature({
  id: 'pq-tls',
  since: '9.7.0',
  summary: 'Post-quantum TLS: hybrid X25519MLKEM768 key exchange for upstream HTTPS, PQ handshake probes and a certificate policy',
  mount(router, ctx) {
    let warned = '';
    setUpstreamTlsGroups((server) => {
      const p = settings(ctx.config());
      if (!p || p.mode === 'off' || !p.servers.some((g) => globToRegExp(g).test(server.id))) return undefined;
      const g = effectiveGroups(p);
      const msg = `${p.mode}:${g}`;
      if (msg !== warned) {
        warned = msg;
        if (!p.groups.some((x) => groupsSupported([x]))) logger.warn(`post-quantum TLS: ${p.groups.join(', ')} not supported by OpenSSL ${process.versions.openssl}${p.mode === 'require' ? ' — upstream HTTPS connections will fail (mode: require)' : ' — using classical key exchange'}`);
      }
      return g;
    });
    ctx.onStop?.(() => setUpstreamTlsGroups(undefined));
    router.get('/', (_req, res) => {
      const p = settings(ctx.config());
      res.json({
        configured: !!p,
        mode: p?.mode ?? 'off',
        supported: groupsSupported(p?.groups ?? ['X25519MLKEM768']),
        openssl: process.versions.openssl,
        groups: p ? (effectiveGroups(p) ?? null) : null,
        certificatePolicy: p?.certificatePolicy ?? null,
        servers: p ? matchedHttps(ctx.config(), p).map((s) => ({ id: s.id, url: s.url, lastProbe: pqTlsState.probes.get(s.id) ?? null })) : [],
      });
    });
    router.post('/probe', async (req, res) => {
      const p = settings(ctx.config());
      if (!p) return badRequest(res, 'postQuantumTls is not configured');
      const want = req.body && typeof req.body === 'object' && typeof (req.body as { server?: unknown }).server === 'string' ? (req.body as { server: string }).server : undefined;
      const list = matchedHttps(ctx.config(), p).filter((s) => !want || s.id === want);
      if (want && !list.length) return void res.status(404).json({ error: 'Not Found', message: `no HTTPS upstream "${want}" covered by postQuantumTls.servers` });
      const results = [];
      for (const s of list) results.push(await probe(ctx.config(), s));
      res.json({ probed: results.length, pq: results.filter((r) => r.pq).length, results });
    });
  },
});
