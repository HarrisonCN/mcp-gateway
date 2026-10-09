/** 9.3: confidential computing / TEE attestation. */
import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { generateKeyPairSync, sign } from 'node:crypto';
import { startFeatureGw, type FeatureGw } from './helpers/feature-gw.js';
import { validateConfig } from '../src/config/loader.js';
import { canonicalJson, confidentialState, ERR_ATTESTATION_REQUIRED } from '../src/features/confidential.js';

let h: FeatureGw | undefined;
beforeEach(() => confidentialState.reset());
afterEach(async () => {
  await h?.stop();
  h = undefined;
});
const vendor = generateKeyPairSync('ed25519');
const rogue = generateKeyPairSync('ed25519');
const ecdsa = generateKeyPairSync('ec', { namedCurve: 'P-256' });
const pem = (k: { publicKey: import('node:crypto').KeyObject }) => k.publicKey.export({ type: 'spki', format: 'pem' }).toString();
const M = 'ab'.repeat(24);
const evidence = (report: Record<string, unknown>, key = vendor.privateKey, alg: string | null = null) => ({ report, signature: sign(alg, Buffer.from(canonicalJson(report)), key).toString('base64') });
const call = async () => {
  const r = await fetch(`${h!.base}/api/v1/tools/call`, { method: 'POST', headers: { authorization: 'Bearer op', 'content-type': 'application/json' }, body: JSON.stringify({ server: 'fake', tool: 'echo', arguments: {} }) });
  return JSON.stringify(await r.json());
};

describe('confidential computing / TEE (9.3)', () => {
  it('validates rules and canonicalises JSON', () => {
    expect(() => validateConfig({ version: 10, servers: [], features: { confidential: { servers: [{ match: '*', measurements: [M], trustedKeys: ['nope'] }] } } })).toThrow(/not a PEM public key/);
    expect(() => validateConfig({ version: 10, servers: [], features: { confidential: { servers: [{ match: '*', measurements: ['XYZ'], trustedKeys: [pem(vendor)] }] } } })).toThrow(/lower-case hex/);
    expect(validateConfig({ version: 10, servers: [], features: { confidential: { servers: [{ match: 'pay-*', platforms: ['tdx'], measurements: [M], trustedKeys: [pem(vendor)] }] } } }).confidential).toBeDefined();
    expect(canonicalJson({ b: 1, a: [{ d: 2, c: 'x' }] })).toBe('{"a":[{"c":"x","d":2}],"b":1}');
    expect(ERR_ATTESTATION_REQUIRED).toBe(-32024);
  });

  it('refuses calls until the upstream is attested; verifies signature, measurement, nonce, debug', async () => {
    h = await startFeatureGw({ confidential: { servers: [{ match: 'fake', platforms: ['sev-snp', 'tdx'], measurements: [M], trustedKeys: [pem(vendor), pem(ecdsa)] }] } } as never);
    expect(await call()).toContain(String(ERR_ATTESTATION_REQUIRED));
    const nonce = async () => (await h!.admin('confidential/fake/nonce', {})).body.nonce as string;
    const base = { platform: 'sev-snp', measurement: M, issuedAt: new Date().toISOString(), debug: false };
    let n = await nonce();
    expect((await h.admin('confidential/fake/attest', evidence({ ...base, nonce: n }, rogue.privateKey))).body.message).toContain('signature does not verify');
    expect((await h.admin('confidential/fake/attest', evidence({ ...base, nonce: n, measurement: 'cd'.repeat(24) }))).body.message).toContain('measurement');
    expect((await h.admin('confidential/fake/attest', evidence({ ...base, nonce: n, platform: 'sgx' }))).body.message).toContain('platform sgx');
    expect((await h.admin('confidential/fake/attest', evidence({ ...base, nonce: n, debug: true }))).body.message).toContain('debug');
    expect((await h.admin('confidential/fake/attest', evidence({ ...base, nonce: 'made-up' }))).body.message).toContain('nonce');
    const ok = await h.admin('confidential/fake/attest', evidence({ ...base, nonce: n }));
    expect(ok.status).toBe(200);
    expect(ok.body.attested).toBe(true);
    expect((await h.admin('confidential/fake/attest', evidence({ ...base, nonce: n }))).body.message).toContain('nonce'); // single use
    expect(await call()).not.toContain(String(ERR_ATTESTATION_REQUIRED));
    const st = await h.admin('confidential');
    expect(st.body.servers[0]).toMatchObject({ id: 'fake', attested: true, platform: 'sev-snp', measurement: M });
    expect((await h.admin('confidential/fake', undefined, 'DELETE')).body.revoked).toBe(true);
    expect(await call()).toContain(String(ERR_ATTESTATION_REQUIRED));
    n = await nonce();
    expect((await h.admin('confidential/fake/attest', evidence({ ...base, platform: 'tdx', nonce: n }, ecdsa.privateKey, 'sha256'))).body.attested).toBe(true);
    expect((await h.admin('confidential/other/nonce', {})).status).toBe(404);
  });
});
