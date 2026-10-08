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
import { z } from 'zod';

export const PluginTrustSchema = z
  .object({
    requireSigned: z.boolean().default(false),
    keys: z.array(z.object({ id: z.string().min(1), publicKey: z.string().min(1) }).strict()).default([]),
  })
  .strict();
export type PluginTrustConfig = z.input<typeof PluginTrustSchema>;

export interface PluginSignature {
  keyId: string;
  sha256: string;
  /** base64 Ed25519 signature. */
  signature: string;
}

export const sha256Hex = (bytes: Uint8Array | string): string => createHash('sha256').update(bytes).digest('hex');
const message = (digest: string) => Buffer.from(`mcp-gateway-plugin:v1:${digest}`);

/** New Ed25519 key pair (PEM). */
export function generateSigningKey(): { publicKey: string; privateKey: string } {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return { publicKey: publicKey.export({ type: 'spki', format: 'pem' }).toString(), privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString() };
}

/** Sign an artifact's bytes. */
export function signArtifact(bytes: Uint8Array | string, privateKeyPem: string, keyId: string): PluginSignature {
  const digest = sha256Hex(bytes);
  return { keyId, sha256: digest, signature: sign(null, message(digest), createPrivateKey(privateKeyPem)).toString('base64') };
}

export type VerifyResult = { ok: true; keyId: string } | { ok: false; reason: string };

/** Verify bytes against a signature and a set of trusted keys. */
export function verifyArtifact(bytes: Uint8Array | string, sig: unknown, keys: ReadonlyArray<{ id: string; publicKey: string }>): VerifyResult {
  const s = sig as Partial<PluginSignature> | null;
  if (!s || typeof s.keyId !== 'string' || typeof s.signature !== 'string' || typeof s.sha256 !== 'string') return { ok: false, reason: 'malformed signature file' };
  const digest = sha256Hex(bytes);
  if (digest !== s.sha256) return { ok: false, reason: `sha256 mismatch (file ${digest.slice(0, 12)}…, signed ${s.sha256.slice(0, 12)}…)` };
  const key = keys.find((k) => k.id === s.keyId);
  if (!key) return { ok: false, reason: `untrusted key "${s.keyId}"` };
  try {
    return verify(null, message(digest), createPublicKey(key.publicKey), Buffer.from(s.signature, 'base64')) ? { ok: true, keyId: key.id } : { ok: false, reason: 'bad signature' };
  } catch (e) {
    return { ok: false, reason: `invalid key "${key.id}": ${(e as Error).message}` };
  }
}
