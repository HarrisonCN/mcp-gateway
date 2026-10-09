/**
 * Confidential computing / TEE (9.3): route sensitive tools only to upstreams running inside a trusted execution
 * environment, and only after remote attestation.
 *
 * ```yaml
 * confidential:
 *   servers:
 *     - match: "payroll-*"              # server id glob
 *       platforms: [sev-snp, tdx]       # accepted TEE platforms (sev-snp | tdx | nitro | sgx)
 *       measurements: ["5f1c…"]         # allowed launch measurements (hex, lower case)
 *       trustedKeys: ["-----BEGIN PUBLIC KEY-----…"]   # attestation-service / vendor verification keys (Ed25519, ECDSA, RSA)
 *       validitySeconds: 3600           # how long one attestation is honoured
 *   nonceTtlSeconds: 120
 * ```
 *
 * Flow: the workload (or its sidecar) asks for a nonce — `POST /api/v1/admin/confidential/:server/nonce` — gets a
 * signed attestation report that binds the nonce (the verifier / attestation service of its platform), and posts it
 * as evidence to `POST /api/v1/admin/confidential/:server/attest`:
 *
 * ```json
 * { "report": { "platform": "sev-snp", "measurement": "5f1c…", "nonce": "…", "issuedAt": "2026-…", "debug": false },
 *   "signature": "<base64 over the canonical JSON of report>" }
 * ```
 *
 * The gateway checks the signature against `trustedKeys`, the platform, the measurement allowlist, the nonce (single
 * use, unexpired), the issue time and that the TEE is not in debug mode. Until a server has a valid attestation, every
 * call to it is refused with JSON-RPC **-32024** (`ERR_ATTESTATION_REQUIRED`). `GET /admin/confidential` shows each
 * protected server's state; `DELETE /admin/confidential/:server` revokes an attestation.
 *
 * @module features/confidential
 */

import { createPublicKey, randomBytes, verify } from 'node:crypto';
import { z } from 'zod';
import { registerFeature, objectBody, badRequest } from '../gateway/features.js';
import { registerCallHook } from '../gateway/hooks.js';
import { globToRegExp } from '../utils/tool-filter.js';
import { logger } from '../utils/logger.js';
import { canonicalJson } from '../gateway/cache.js';
import type { GatewayConfig } from '../utils/types.js';
import { type ConfidentialConfig, ConfidentialSchema, ERR_ATTESTATION_REQUIRED, Rule, TEE_PLATFORMS } from './schemas/confidential.js';
export { type ConfidentialConfig, ConfidentialSchema, ERR_ATTESTATION_REQUIRED, TEE_PLATFORMS } from './schemas/confidential.js';
type R = z.output<typeof Rule>;

interface Attestation {
  platform: string;
  measurement: string;
  at: number;
  until: number;
}

/** Runtime state; exported for tests. */
export const confidentialState = {
  nonces: new Map<string, { serverId: string; expires: number }>(),
  attested: new Map<string, Attestation>(),
  failures: new Map<string, { at: number; reason: string }>(),
  reset() {
    this.nonces.clear();
    this.attested.clear();
    this.failures.clear();
  },
};

const settings = (cfg: GatewayConfig) => {
  if (!cfg.confidential) return undefined;
  const c = ConfidentialSchema.parse(cfg.confidential);
  return c.enabled ? c : undefined;
};
const ruleFor = (cfg: GatewayConfig, serverId: string): R | undefined => settings(cfg)?.servers.find((r) => globToRegExp(r.match).test(serverId));

/** Canonical JSON (sorted keys, the 2.2 cache-key form) — what the attestation signature covers. */
export { canonicalJson };

export function issueNonce(serverId: string, ttlSeconds: number, now = Date.now()): string {
  for (const [n, v] of confidentialState.nonces) if (v.expires <= now) confidentialState.nonces.delete(n);
  const n = randomBytes(24).toString('base64url');
  confidentialState.nonces.set(n, { serverId, expires: now + ttlSeconds * 1000 });
  return n;
}

/** Verify attestation evidence for a server; records the attestation on success. */
export function verifyEvidence(cfg: GatewayConfig, serverId: string, evidence: Record<string, unknown>, now = Date.now()): { ok: true; until: number } | { ok: false; reason: string } {
  const rule = ruleFor(cfg, serverId);
  const fail = (reason: string) => {
    confidentialState.failures.set(serverId, { at: now, reason });
    logger.warn(`confidential: attestation of "${serverId}" rejected: ${reason}`);
    return { ok: false as const, reason };
  };
  if (!rule) return fail('server is not protected by confidential.servers');
  const report = evidence.report as Record<string, unknown> | undefined;
  const sig = evidence.signature;
  if (!report || typeof report !== 'object' || typeof sig !== 'string') return fail('evidence needs "report" (object) and "signature" (base64)');
  const data = Buffer.from(canonicalJson(report));
  const signature = Buffer.from(sig, 'base64');
  const signed = rule.trustedKeys.some((k) => {
    try {
      const key = createPublicKey(k);
      return verify(key.asymmetricKeyType === 'ed25519' || key.asymmetricKeyType === 'ed448' ? null : 'sha256', data, key, signature);
    } catch {
      return false;
    }
  });
  if (!signed) return fail('signature does not verify against trustedKeys');
  if (!rule.platforms.includes(report.platform as never)) return fail(`platform ${String(report.platform)} is not accepted`);
  if (!rule.measurements.includes(String(report.measurement))) return fail('measurement is not in the allowlist');
  if (report.debug === true && !rule.allowDebug) return fail('TEE runs in debug mode');
  const n = confidentialState.nonces.get(String(report.nonce));
  if (!n || n.serverId !== serverId || n.expires <= now) return fail('nonce unknown, expired or for another server');
  confidentialState.nonces.delete(String(report.nonce));
  const issued = Date.parse(String(report.issuedAt));
  if (!Number.isFinite(issued) || issued > now + 60_000 || now - issued > rule.validitySeconds * 1000) return fail('issuedAt missing, in the future or too old');
  const until = Math.min(issued + rule.validitySeconds * 1000, now + rule.validitySeconds * 1000);
  confidentialState.attested.set(serverId, { platform: String(report.platform), measurement: String(report.measurement), at: now, until });
  confidentialState.failures.delete(serverId);
  logger.info(`confidential: "${serverId}" attested (${String(report.platform)})`);
  return { ok: true, until };
}

export const isAttested = (serverId: string, now = Date.now()) => {
  const a = confidentialState.attested.get(serverId);
  return !!a && a.until > now;
};

registerCallHook({
  id: 'confidential',
  before(call, cfg) {
    const rule = ruleFor(cfg, call.serverId);
    if (!rule || isAttested(call.serverId)) return;
    return { refuse: { code: ERR_ATTESTATION_REQUIRED, message: `server "${call.serverId}" must run in an attested TEE (${rule.platforms.join(' / ')}) before it gets calls`, data: { serverId: call.serverId, platforms: rule.platforms } } };
  },
});

registerFeature({
  id: 'confidential',
  since: '9.3.0',
  summary: 'Confidential computing: sensitive servers get calls only from inside a remotely attested TEE (SEV-SNP, TDX, Nitro, SGX)',
  mount(router, ctx) {
    router.get('/', (_req, res) => {
      const s = settings(ctx.config());
      const now = Date.now();
      const ids = new Set([...ctx.config().servers.map((x) => x.id), ...confidentialState.attested.keys()]);
      res.json({
        enabled: !!s,
        servers: [...ids]
          .map((id) => ({ id, rule: ruleFor(ctx.config(), id) }))
          .filter((x) => x.rule)
          .map(({ id, rule }) => {
            const a = confidentialState.attested.get(id);
            const f = confidentialState.failures.get(id);
            return { id, match: rule!.match, platforms: rule!.platforms, attested: isAttested(id, now), platform: a?.platform ?? null, measurement: a?.measurement ?? null, attestedAt: a ? new Date(a.at).toISOString() : null, expiresAt: a ? new Date(a.until).toISOString() : null, lastFailure: f ? { at: new Date(f.at).toISOString(), reason: f.reason } : null };
          }),
      });
    });
    router.post('/:server/nonce', (req, res) => {
      const s = settings(ctx.config());
      const id = String(req.params.server);
      if (!s || !ruleFor(ctx.config(), id)) return void res.status(404).json({ error: 'Not Found', message: `server "${id}" is not protected by confidential.servers` });
      res.json({ nonce: issueNonce(id, s.nonceTtlSeconds), expiresInSeconds: s.nonceTtlSeconds });
    });
    router.post('/:server/attest', (req, res) => {
      const b = objectBody(req, res);
      if (!b) return;
      const r = verifyEvidence(ctx.config(), String(req.params.server), b);
      if (!r.ok) return badRequest(res, `attestation rejected: ${r.reason}`);
      res.json({ attested: true, expiresAt: new Date(r.until).toISOString() });
    });
    router.delete('/:server', (req, res) => {
      res.json({ revoked: confidentialState.attested.delete(String(req.params.server)) });
    });
  },
});
