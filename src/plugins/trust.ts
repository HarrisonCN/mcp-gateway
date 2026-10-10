/**
 * Plugin supply-chain verification (5.4): Ed25519-signed plugin artifacts.
 *
 * A signature file (`<plugin>.sig`, JSON `{ keyId, sha256, signature }`) signs the message
 * `mcp-gateway-plugin:v1:<sha256 of the file>`. With `pluginTrust.keys` configured, a plugin that ships a `.sig`
 * must verify against one of the keys; with `requireSigned: true` unsigned plugins (and package-name modules) are
 * refused.
 *
 * ```yaml
 * pluginTrust:
 *   requireSigned: true
 *   keys:
 *     - { id: acme-2026, publicKey: "-----BEGIN PUBLIC KEY-----\n…" }
 * ```
 *
 * @module plugins/trust
 */

import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from 'node:crypto';
import { mlDsaSign, mlDsaVerify, type MlDsaKey, type MlDsaPublicKey } from '../security/pq.js';

// 13.3.0: the schema lives in trust-schema.ts so config validation never loads the ML-DSA backend (@noble/*).
export { PluginTrustSchema, type PluginTrustConfig } from './trust-schema.js';

export interface PluginSignature {
  keyId: string;
  sha256: string;
  /** base64 Ed25519 signature. */
  signature: string;
  /** 10.8: base64 ML-DSA signature over the same message (hybrid). */
  mldsa?: string;
}

export const sha256Hex = (bytes: Uint8Array | string): string => createHash('sha256').update(bytes).digest('hex');
const message = (digest: string) => Buffer.from(`mcp-gateway-plugin:v1:${digest}`);

/** New Ed25519 key pair (PEM). */
export function generateSigningKey(): { publicKey: string; privateKey: string } {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return { publicKey: publicKey.export({ type: 'spki', format: 'pem' }).toString(), privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString() };
}

/** Sign an artifact's bytes. */
export function signArtifact(bytes: Uint8Array | string, privateKeyPem: string, keyId: string, mldsaKey?: MlDsaKey): PluginSignature {
  const digest = sha256Hex(bytes);
  return {
    keyId,
    sha256: digest,
    signature: sign(null, message(digest), createPrivateKey(privateKeyPem)).toString('base64'),
    ...(mldsaKey ? { mldsa: mlDsaSign(mldsaKey, message(digest)) } : {}),
  };
}

export type VerifyResult = { ok: true; keyId: string } | { ok: false; reason: string };

/** Verify bytes against a signature and a set of trusted keys. */
export function verifyArtifact(bytes: Uint8Array | string, sig: unknown, keys: ReadonlyArray<{ id: string; publicKey: string; mldsa?: MlDsaPublicKey }>, opts: { requirePostQuantum?: boolean } = {}): VerifyResult {
  const s = sig as Partial<PluginSignature> | null;
  if (!s || typeof s.keyId !== 'string' || typeof s.signature !== 'string' || typeof s.sha256 !== 'string') return { ok: false, reason: 'malformed signature file' };
  const digest = sha256Hex(bytes);
  if (digest !== s.sha256) return { ok: false, reason: `sha256 mismatch (file ${digest.slice(0, 12)}…, signed ${s.sha256.slice(0, 12)}…)` };
  const key = keys.find((k) => k.id === s.keyId);
  if (!key) return { ok: false, reason: `untrusted key "${s.keyId}"` };
  try {
    if (!verify(null, message(digest), createPublicKey(key.publicKey), Buffer.from(s.signature, 'base64'))) return { ok: false, reason: 'bad signature' };
    // 10.8 hybrid: a key with an ML-DSA part only accepts signatures carrying a valid ML-DSA signature too.
    if (key.mldsa || opts.requirePostQuantum) {
      if (!key.mldsa) return { ok: false, reason: `key "${key.id}" has no ML-DSA public key and pluginTrust.requirePostQuantum is on` };
      if (typeof s.mldsa !== 'string') return { ok: false, reason: `key "${key.id}" requires a hybrid signature (no "mldsa" in the signature file)` };
      if (!mlDsaVerify(key.mldsa, message(digest), s.mldsa)) return { ok: false, reason: `bad ${key.mldsa.alg} signature` };
    }
    return { ok: true, keyId: key.id };
  } catch (e) {
    return { ok: false, reason: `invalid key "${key.id}": ${(e as Error).message}` };
  }
}
