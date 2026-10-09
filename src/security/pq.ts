/**
 * Post-quantum signatures: ML-DSA (FIPS 204) and Ed25519 + ML-DSA hybrid signatures (10.8, EXPERIMENTAL).
 *
 * Backend: Node's own `crypto` when the runtime implements ML-DSA (Node 24.7+ with OpenSSL 3.5) — detected once by a
 * self-test that imports a key, signs with Node and verifies with the reference implementation, and the reverse —
 * otherwise [`@noble/post-quantum`](https://github.com/paulmillr/noble-post-quantum) (pure JS; widely used, but not
 * independently audited). `pqBackend()` reports which one is active. Both produce standard FIPS 204 signatures, so
 * keys and signatures are interchangeable.
 *
 * Key format (JSON, one file): `{ "kty": "ML-DSA", "alg": "ml-dsa-65", "pub": <base64>, "seed": <base64> }` — the
 * 32-byte FIPS 204 key-generation seed is the private key; the public file omits `seed`.
 *
 * A **hybrid** signature is an Ed25519 signature and an ML-DSA signature over the same message; it verifies only if
 * both do (AND composition), so it stays secure while either algorithm holds.
 *
 * @module security/pq
 */

import { createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, sign as nodeSign, verify as nodeVerify, type KeyObject } from 'node:crypto';
import { ml_dsa44, ml_dsa65, ml_dsa87 } from '@noble/post-quantum/ml-dsa.js';

export type MlDsaLevel = 'ml-dsa-44' | 'ml-dsa-65' | 'ml-dsa-87';
export const ML_DSA_LEVELS: readonly MlDsaLevel[] = ['ml-dsa-44', 'ml-dsa-65', 'ml-dsa-87'];
const NOBLE = { 'ml-dsa-44': ml_dsa44, 'ml-dsa-65': ml_dsa65, 'ml-dsa-87': ml_dsa87 } as const;

export interface MlDsaPublicKey {
  kty: 'ML-DSA';
  alg: MlDsaLevel;
  /** base64 FIPS 204 public key. */
  pub: string;
}
export interface MlDsaKey extends MlDsaPublicKey {
  /** base64 32-byte key-generation seed (the private key). */
  seed: string;
}

const b64 = (u: Uint8Array) => Buffer.from(u).toString('base64');
const b64url = (u: Uint8Array) => Buffer.from(u).toString('base64url');
const unb64 = (s: string) => new Uint8Array(Buffer.from(s, 'base64'));
const bytes = (m: Uint8Array | string) => (typeof m === 'string' ? new TextEncoder().encode(m) : m);

function nodeKeys(level: MlDsaLevel, pub: Uint8Array, seed?: Uint8Array): KeyObject {
  const jwk = { kty: 'AKP', alg: level.toUpperCase(), pub: b64url(pub), ...(seed ? { priv: b64url(seed) } : {}) };
  return seed ? createPrivateKey({ key: jwk as never, format: 'jwk' }) : createPublicKey({ key: jwk as never, format: 'jwk' });
}

let backend: 'node' | 'noble' | undefined;
let backendNote = '';

/** Which implementation signs and verifies: Node's crypto (self-tested) or @noble/post-quantum. */
export function pqBackend(): { backend: 'node' | 'noble'; note: string } {
  if (!backend) {
    backend = 'noble';
    try {
      generateKeyPairSync('ml-dsa-65' as never);
      const seed = randomBytes(32);
      const { publicKey } = ml_dsa65.keygen(seed);
      const msg = new TextEncoder().encode('mcp-gateway pq self-test');
      const sigNode = nodeSign(null, msg, nodeKeys('ml-dsa-65', publicKey, seed));
      const sigNoble = ml_dsa65.sign(msg, ml_dsa65.keygen(seed).secretKey);
      if (ml_dsa65.verify(new Uint8Array(sigNode), msg, publicKey) && nodeVerify(null, msg, nodeKeys('ml-dsa-65', publicKey), sigNoble)) {
        backend = 'node';
        backendNote = `node:crypto (Node ${process.versions.node}, OpenSSL ${process.versions.openssl}); cross-checked against @noble/post-quantum`;
      } else backendNote = 'node:crypto ML-DSA failed the interoperability self-test; using @noble/post-quantum';
    } catch (e) {
      backendNote = `node:crypto has no usable ML-DSA in Node ${process.versions.node} (${(e as Error).message.slice(0, 80)}); using @noble/post-quantum (pure JS, not independently audited)`;
    }
  }
  return { backend, note: backendNote };
}

/** Test helper: force a backend (or re-detect with `undefined`). */
export function setPqBackend(b: 'node' | 'noble' | undefined): void {
  backend = b;
  backendNote = b ? `forced ${b}` : '';
}

export function mlDsaKeygen(level: MlDsaLevel = 'ml-dsa-65', seed: Uint8Array = randomBytes(32)): MlDsaKey {
  if (seed.length !== 32) throw new Error('ML-DSA seed must be 32 bytes');
  const { publicKey } = NOBLE[level].keygen(seed);
  return { kty: 'ML-DSA', alg: level, pub: b64(publicKey), seed: b64(seed) };
}

export function publicPart(k: MlDsaKey | MlDsaPublicKey): MlDsaPublicKey {
  return { kty: 'ML-DSA', alg: k.alg, pub: k.pub };
}

export function parseMlDsaKey(json: unknown, needPrivate: boolean): MlDsaKey | MlDsaPublicKey {
  const k = json as Partial<MlDsaKey> | null;
  if (!k || k.kty !== 'ML-DSA' || !ML_DSA_LEVELS.includes(k.alg as MlDsaLevel) || typeof k.pub !== 'string') throw new Error('not an ML-DSA key ({ kty: "ML-DSA", alg, pub[, seed] })');
  if (needPrivate && typeof k.seed !== 'string') throw new Error('ML-DSA private key has no "seed"');
  const pub = unb64(k.pub);
  const expected = NOBLE[k.alg as MlDsaLevel].lengths.publicKey;
  if (pub.length !== expected) throw new Error(`${k.alg} public key must be ${expected} bytes, got ${pub.length}`);
  if (typeof k.seed === 'string') {
    const derived = NOBLE[k.alg as MlDsaLevel].keygen(unb64(k.seed)).publicKey;
    if (b64(derived) !== k.pub) throw new Error('ML-DSA key: seed does not match pub');
  }
  return k as MlDsaKey;
}

export function mlDsaSign(key: MlDsaKey, message: Uint8Array | string): string {
  const m = bytes(message);
  if (pqBackend().backend === 'node') return b64(nodeSign(null, m, nodeKeys(key.alg, unb64(key.pub), unb64(key.seed))));
  const { secretKey } = NOBLE[key.alg].keygen(unb64(key.seed));
  return b64(NOBLE[key.alg].sign(m, secretKey));
}

export function mlDsaVerify(key: MlDsaPublicKey, message: Uint8Array | string, signature: string): boolean {
  try {
    const m = bytes(message);
    const sig = unb64(signature);
    if (pqBackend().backend === 'node') return nodeVerify(null, m, nodeKeys(key.alg, unb64(key.pub)), sig);
    return NOBLE[key.alg].verify(sig, m, unb64(key.pub));
  } catch {
    return false;
  }
}

// ─── hybrid (Ed25519 + ML-DSA) ──────────────────────────────────────────────

export interface HybridPrivateKey {
  /** Ed25519 PKCS#8 PEM. */
  ed25519: string;
  mldsa: MlDsaKey;
}
export interface HybridPublicKey {
  /** Ed25519 SPKI PEM. */
  ed25519: string;
  mldsa: MlDsaPublicKey;
}
export interface HybridSignature {
  alg: `ed25519+${MlDsaLevel}`;
  ed25519: string;
  mldsa: string;
}

export function hybridKeygen(level: MlDsaLevel = 'ml-dsa-65'): { privateKey: HybridPrivateKey; publicKey: HybridPublicKey } {
  const ed = generateKeyPairSync('ed25519');
  const ml = mlDsaKeygen(level);
  return {
    privateKey: { ed25519: ed.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), mldsa: ml },
    publicKey: { ed25519: ed.publicKey.export({ type: 'spki', format: 'pem' }).toString(), mldsa: publicPart(ml) },
  };
}

export function hybridSign(key: HybridPrivateKey, message: Uint8Array | string): HybridSignature {
  const m = bytes(message);
  return { alg: `ed25519+${key.mldsa.alg}`, ed25519: nodeSign(null, m, createPrivateKey(key.ed25519)).toString('base64'), mldsa: mlDsaSign(key.mldsa, m) };
}

export type HybridVerify = { ok: true } | { ok: false; reason: string };

/** Both signatures must verify. */
export function hybridVerify(key: HybridPublicKey, message: Uint8Array | string, sig: unknown): HybridVerify {
  const s = sig as Partial<HybridSignature> | null;
  if (!s || typeof s.ed25519 !== 'string' || typeof s.mldsa !== 'string') return { ok: false, reason: 'malformed hybrid signature (needs ed25519 and mldsa)' };
  if (s.alg !== `ed25519+${key.mldsa.alg}`) return { ok: false, reason: `algorithm mismatch: signature ${String(s.alg)}, key ed25519+${key.mldsa.alg}` };
  const m = bytes(message);
  let edOk = false;
  try {
    edOk = nodeVerify(null, m, createPublicKey(key.ed25519), Buffer.from(s.ed25519, 'base64'));
  } catch {
    edOk = false;
  }
  if (!edOk) return { ok: false, reason: 'Ed25519 signature does not verify' };
  if (!mlDsaVerify(key.mldsa, m, s.mldsa)) return { ok: false, reason: `${key.mldsa.alg} signature does not verify` };
  return { ok: true };
}
