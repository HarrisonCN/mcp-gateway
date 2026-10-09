// 10.8 (EXPERIMENTAL): differential-privacy aggregation / federated query, and post-quantum (ML-DSA hybrid) identity.
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { ml_dsa65 } from '@noble/post-quantum/ml-dsa.js';
import { laplace, dpAggregate, combine, QuerySchema, EpsilonLedger, epsilonLedger } from '../src/features/privacy.js';
import { pqBackend, setPqBackend, mlDsaKeygen, mlDsaSign, mlDsaVerify, hybridKeygen, hybridSign, hybridVerify, parseMlDsaKey } from '../src/security/pq.js';
import { verifyAudit, verifyDocument, DOMAIN, resetPqIdentity, canonical, type AuditRecord } from '../src/features/pq-identity.js';
import { signArtifact, verifyArtifact, generateSigningKey } from '../src/plugins/trust.js';
import { experimentalFeatureWarnings } from '../src/security/posture.js';
import { validateConfig } from '../src/config/loader.js';
import { Gateway } from '../src/gateway/index.js';
import { startFeatureGw, fakeServer, type FeatureGw } from './helpers/feature-gw.js';
import type { GatewayConfig } from '../src/utils/types.js';

let fx: FeatureGw | undefined;
let peer: Gateway | undefined;
afterEach(async () => {
  await fx?.stop();
  await peer?.stop();
  fx = undefined;
  peer = undefined;
  epsilonLedger.reset();
  resetPqIdentity();
});

const q = (o: Record<string, unknown>) => QuerySchema.parse(o);
const rows = Array.from({ length: 200 }, (_, i) => ({ salary: 1000 * (i % 10), dept: i % 2 ? 'a' : 'b' }));

describe('differential privacy (10.8)', () => {
  it('Laplace sampler: inverse CDF, symmetric, mean ~0 and variance ~2b² from the CSPRNG', () => {
    expect(laplace(1, () => 0.5)).toBeCloseTo(0, 12);
    expect(laplace(2, () => 0.75)).toBeCloseTo(-2 * Math.log(0.5), 9);
    expect(laplace(2, () => 0.25)).toBeCloseTo(2 * Math.log(0.5), 9);
    const xs = Array.from({ length: 20000 }, () => laplace(1));
    const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
    const v = xs.reduce((a, b) => a + (b - mean) ** 2, 0) / xs.length;
    expect(Math.abs(mean)).toBeLessThan(0.05);
    expect(v).toBeGreaterThan(1.8);
    expect(v).toBeLessThan(2.2);
  });

  it('query validation: bounds for sum / mean, increasing bins, field', () => {
    expect(() => q({ op: 'sum', field: 'x', epsilon: 1 })).toThrow(/bounds/);
    expect(() => q({ op: 'mean', field: 'x', bounds: [5, 1], epsilon: 1 })).toThrow(/min < max/);
    expect(() => q({ op: 'histogram', field: 'x', bins: [0, 0], epsilon: 1 })).toThrow(/increasing/);
    expect(() => q({ op: 'sum', bounds: [0, 1], epsilon: 1 })).toThrow(/field/);
    expect(q({ op: 'count', epsilon: 1 }).rows).toBe('structuredContent.rows');
  });

  it('aggregates: noise scale from sensitivity / ε, clamping, histogram bins; zero noise when u = 0.5', () => {
    const u = () => 0.5;
    expect(dpAggregate(rows, q({ op: 'count', epsilon: 0.5 }), u)).toMatchObject({ value: 200, noise: { scale: 2 } });
    expect(dpAggregate(rows, q({ op: 'sum', field: 'salary', bounds: [0, 5000], epsilon: 1 }), u)).toMatchObject({ value: 20 * (0 + 1000 + 2000 + 3000 + 4000 + 5000 * 5), noise: { scale: 5000 } });
    const m = dpAggregate(rows, q({ op: 'mean', field: 'salary', bounds: [0, 9000], epsilon: 1 }), u);
    expect(m.value).toBe(4500);
    expect(m.noise.scale).toEqual({ sum: 18000, count: 2 });
    const h = dpAggregate(rows, q({ op: 'histogram', field: 'salary', bins: [0, 3000, 6000, 9000], epsilon: 1 }), u);
    expect(h.value).toEqual([60, 60, 80]);
    // statistical: noisy counts concentrate around the truth
    const many = Array.from({ length: 400 }, () => dpAggregate(rows, q({ op: 'count', epsilon: 1 })).value as number);
    expect(Math.abs(many.reduce((a, b) => a + b, 0) / many.length - 200)).toBeLessThan(0.3);
  });

  it('combine: counts / sums add, means from noisy parts, histograms per bin', () => {
    const u = () => 0.5;
    const a = dpAggregate(rows.slice(0, 100), q({ op: 'mean', field: 'salary', bounds: [0, 9000], epsilon: 1 }), u);
    const b = dpAggregate(rows.slice(100), q({ op: 'mean', field: 'salary', bounds: [0, 9000], epsilon: 1 }), u);
    expect(combine([a, b]).value).toBe(4500);
    expect(combine([dpAggregate(rows, q({ op: 'count', epsilon: 1 }), u), dpAggregate(rows, q({ op: 'count', epsilon: 1 }), u)]).value).toBe(400);
    expect(() => combine([a, dpAggregate(rows, q({ op: 'count', epsilon: 1 }), u)])).toThrow(/different/);
  });

  it('ε ledger: sequential composition within the window', () => {
    const l = new EpsilonLedger();
    expect(l.charge('c', 0.6, 1, 1000, 0)).toBe(true);
    expect(l.charge('c', 0.6, 1, 1000, 10)).toBe(false);
    expect(l.charge('c', 0.4, 1, 1000, 10)).toBe(true);
    expect(l.charge('c', 0.5, 1, 1000, 1001)).toBe(true);
  });

  it('end to end: protected tool refuses raw calls, answers DP aggregates within budget, federates with a peer gateway', async () => {
    peer = new Gateway({ port: 0, host: '127.0.0.1', logLevel: 'error', monitor: { requestLog: false }, servers: [fakeServer('fake')], auth: { strategy: 'api-key', apiKeys: ['peer-key'] }, privacy: { protect: ['fake/*'] } } as GatewayConfig);
    await peer.start();
    fx = await startFeatureGw({
      privacy: { protect: ['fake/echo'], maxEpsilonPerQuery: 1, budget: { epsilon: 2, windowSeconds: 3600 }, peers: [{ id: 'eu', url: `http://127.0.0.1:${peer.address()!.port}`, token: 'peer-key' }] },
    } as never);
    const H = { authorization: 'Bearer scoped', 'content-type': 'application/json' };
    const raw = await fetch(`${fx.base}/api/v1/tools/call`, { method: 'POST', headers: H, body: JSON.stringify({ server: 'fake', tool: 'echo', arguments: { rows } }) });
    expect(raw.status).toBe(403);
    expect(((await raw.json()) as { message: string }).message).toMatch(/privacy-protected/);

    const agg = (body: unknown) => fetch(`${fx!.base}/api/v1/features/privacy/aggregate`, { method: 'POST', headers: H, body: JSON.stringify(body) });
    const query = { rows: 'json.rows', op: 'count', epsilon: 1 };
    const r1 = await agg({ server: 'fake', tool: 'echo', arguments: { rows }, ...query });
    expect(r1.status).toBe(200);
    const b1 = (await r1.json()) as Record<string, unknown>;
    expect(Math.abs((b1.value as number) - 200)).toBeLessThan(60);
    expect(JSON.stringify(b1)).not.toContain('salary');
    expect(b1.budget).toMatchObject({ spent: 1, epsilon: 2 });
    expect((await agg({ server: 'fake', tool: 'echo', arguments: { rows }, ...query, epsilon: 5 })).status).toBe(400);
    expect((await agg({ server: 'fake', tool: 'echo', arguments: { rows }, rows: 'json.nope', op: 'count', epsilon: 0.1 })).status).toBe(422);

    const fed = await fetch(`${fx.base}/api/v1/features/privacy/federated`, {
      method: 'POST',
      headers: H,
      body: JSON.stringify({ query: { rows: 'json.rows', op: 'sum', field: 'salary', bounds: [0, 9000], epsilon: 0.5 }, targets: [{ server: 'fake', tool: 'echo', arguments: { rows: rows.slice(0, 100) } }, { peer: 'eu', server: 'fake', tool: 'echo', arguments: { rows: rows.slice(100) } }] }),
    });
    expect(fed.status).toBe(200);
    const fb = (await fed.json()) as { value: number; domains: Array<{ target: string; status: number }> };
    expect(fb.domains.map((d) => d.status)).toEqual([200, 200]);
    expect(Math.abs(fb.value - 900_000)).toBeLessThan(200_000); // true sum 900000, noise scale 18000 per domain
    // budget: 1 + 0.1 (the 422 query is charged too: ε is spent before the tool runs) + 0.5; a 1.0 query no longer fits
    expect((await agg({ server: 'fake', tool: 'echo', arguments: { rows }, ...query })).status).toBe(429);
    const bud = await fetch(`${fx.base}/api/v1/features/privacy/budget`, { headers: H });
    const bj = (await bud.json()) as { spent: number; remaining: number };
    expect(bj.spent).toBeCloseTo(1.6, 9);
    expect(bj.remaining).toBeCloseTo(0.4, 9);
  });

  it('scoped keys cannot aggregate tools outside their scope; posture lists the feature as EXPERIMENTAL', async () => {
    fx = await startFeatureGw({ servers: [fakeServer('fake'), fakeServer('other')], privacy: { protect: ['*'] } } as never);
    const r = await fetch(`${fx.base}/api/v1/features/privacy/aggregate`, { method: 'POST', headers: { authorization: 'Bearer scoped', 'content-type': 'application/json' }, body: JSON.stringify({ server: 'other', tool: 'echo', op: 'count', epsilon: 0.1 }) });
    expect(r.status).toBe(403);
    expect(experimentalFeatureWarnings({ privacy: {} } as never).map((w) => w.id)).toContain('experimental-privacy');
  });
});

describe('post-quantum signatures (10.8)', () => {
  it('ML-DSA: backend detection, sign / verify, interop with the reference implementation, key validation', () => {
    const b = pqBackend();
    expect(['node', 'noble']).toContain(b.backend);
    expect(b.note.length).toBeGreaterThan(10);
    for (const alg of ['ml-dsa-44', 'ml-dsa-65', 'ml-dsa-87'] as const) {
      const k = mlDsaKeygen(alg);
      const s = mlDsaSign(k, 'msg');
      expect(mlDsaVerify(k, 'msg', s)).toBe(true);
      expect(mlDsaVerify(k, 'msg2', s)).toBe(false);
    }
    // FIPS 204 interop: a signature from the active backend verifies with noble and vice versa
    const k = mlDsaKeygen('ml-dsa-65');
    const seed = new Uint8Array(Buffer.from(k.seed, 'base64'));
    const pub = new Uint8Array(Buffer.from(k.pub, 'base64'));
    expect(ml_dsa65.verify(new Uint8Array(Buffer.from(mlDsaSign(k, 'x'), 'base64')), new TextEncoder().encode('x'), pub)).toBe(true);
    const nobleSig = Buffer.from(ml_dsa65.sign(new TextEncoder().encode('y'), ml_dsa65.keygen(seed).secretKey)).toString('base64');
    expect(mlDsaVerify(k, 'y', nobleSig)).toBe(true);
    expect(() => parseMlDsaKey({ ...k, pub: mlDsaKeygen('ml-dsa-65').pub }, true)).toThrow(/seed does not match/);
    expect(() => parseMlDsaKey({ kty: 'ML-DSA', alg: 'ml-dsa-65', pub: 'AAAA' }, false)).toThrow(/1952 bytes/);
    expect(mlDsaVerify(k, 'x', 'not base64 !!')).toBe(false);
  });

  it('runs on node:crypto when the runtime has ML-DSA (Node 24.7+), else reports noble', () => {
    setPqBackend(undefined);
    const b = pqBackend();
    const major = Number(process.versions.node.split('.')[0]);
    if (major < 24) expect(b.backend).toBe('noble');
    console.log(`pq backend on Node ${process.versions.node}: ${b.backend} — ${b.note}`); // eslint-disable-line no-console
  });

  it('hybrid: both must verify, algorithm binding, tampering', () => {
    const { privateKey, publicKey } = hybridKeygen();
    const s = hybridSign(privateKey, 'payload');
    expect(hybridVerify(publicKey, 'payload', s)).toEqual({ ok: true });
    expect(hybridVerify(publicKey, 'payload', { ...s, mldsa: hybridSign(privateKey, 'other').mldsa })).toMatchObject({ ok: false, reason: expect.stringMatching(/ml-dsa-65/) });
    expect(hybridVerify(publicKey, 'payload', { ...s, ed25519: hybridSign(privateKey, 'other').ed25519 })).toMatchObject({ ok: false, reason: expect.stringMatching(/Ed25519/) });
    expect(hybridVerify(publicKey, 'payload', { ...s, alg: 'ed25519+ml-dsa-44' })).toMatchObject({ ok: false, reason: expect.stringMatching(/mismatch/) });
    expect(hybridVerify(publicKey, 'payload', { ed25519: s.ed25519 })).toMatchObject({ ok: false });
  });

  it('plugin trust: a key with an ML-DSA part requires a hybrid signature; requirePostQuantum refuses classical-only keys', () => {
    const ed = generateSigningKey();
    const ml = mlDsaKeygen('ml-dsa-65');
    const art = Buffer.from('export default {}');
    const classical = signArtifact(art, ed.privateKey, 'k');
    const hybrid = signArtifact(art, ed.privateKey, 'k', ml);
    const keyH = { id: 'k', publicKey: ed.publicKey, mldsa: { kty: 'ML-DSA' as const, alg: ml.alg, pub: ml.pub } };
    expect(verifyArtifact(art, hybrid, [keyH])).toEqual({ ok: true, keyId: 'k' });
    expect(verifyArtifact(art, classical, [keyH])).toMatchObject({ ok: false, reason: expect.stringMatching(/requires a hybrid signature/) });
    expect(verifyArtifact(art, { ...hybrid, mldsa: signArtifact('other', ed.privateKey, 'k', ml).mldsa }, [keyH])).toMatchObject({ ok: false, reason: 'bad ml-dsa-65 signature' });
    expect(verifyArtifact(art, classical, [{ id: 'k', publicKey: ed.publicKey }])).toEqual({ ok: true, keyId: 'k' });
    expect(verifyArtifact(art, classical, [{ id: 'k', publicKey: ed.publicKey }], { requirePostQuantum: true })).toMatchObject({ ok: false });
    expect(validateConfig({ version: 11, servers: [], features: { pluginTrust: { requirePostQuantum: true, keys: [keyH] } } }).pluginTrust).toBeDefined();
  });

  it('gateway: signed identity document and tool manifest, hash-chained audit log with signed checkpoints, tamper detection', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pq-'));
    const keys = hybridKeygen();
    writeFileSync(join(dir, 'gw.hybrid.json'), JSON.stringify(keys.privateKey));
    fx = await startFeatureGw({ configDir: dir, pqIdentity: { keyFile: 'gw.hybrid.json', keyId: 'gw-test', gatewayId: 'gw.example', auditLog: { dir: 'audit', checkpointEvery: 2 } }, policy: { rules: [{ name: 'deny-x', effect: 'deny', tools: ['x'] }] } } as never);
    const H = { authorization: 'Bearer scoped' };
    const id = (await (await fetch(`${fx.base}/api/v1/features/pq-identity/identity`, { headers: H })).json()) as { payload: { subject: string; publicKey: unknown } };
    expect(id.payload.subject).toBe('gw.example');
    expect(verifyDocument(id, keys.publicKey, DOMAIN.identity)).toEqual({ ok: true });
    expect(verifyDocument({ ...id, payload: { ...id.payload, subject: 'evil' } }, keys.publicKey, DOMAIN.identity)).toMatchObject({ ok: false });
    expect(verifyDocument(id, keys.publicKey, DOMAIN.manifest)).toMatchObject({ ok: false }); // domain separation

    const man = (await (await fetch(`${fx.base}/api/v1/features/pq-identity/tool-manifest`, { headers: H })).json()) as { payload: { tools: Array<{ name: string; inputSchemaSha256: string }> } };
    expect(man.payload.tools.map((t) => t.name)).toContain('echo');
    expect(man.payload.tools[0]!.inputSchemaSha256).toMatch(/^[a-f0-9]{64}$/);
    expect((await fx.admin('pq-identity/verify', { domain: 'manifest', document: man })).body).toEqual({ ok: true });

    const call = (tool: string) => fetch(`${fx!.base}/api/v1/tools/call`, { method: 'POST', headers: { authorization: 'Bearer op', 'content-type': 'application/json' }, body: JSON.stringify({ server: 'fake', tool, arguments: { n: 1 } }) });
    expect((await call('echo')).status).toBe(200);
    expect((await call('x')).status).toBe(403);
    expect((await call('echo')).status).toBe(200);
    const st = await fx.admin('pq-identity');
    expect(st.body).toMatchObject({ experimental: true, keyId: 'gw-test', audit: { seq: 3, persisted: true } });
    const audit = (await fx.admin('pq-identity/audit')).body.records as AuditRecord[];
    expect(audit.filter((r) => r.type === 'call').map((r) => (r as { outcome: string }).outcome).reverse()).toEqual(['success', 'refused', 'success']);
    await fx.admin('pq-identity/audit/checkpoint', {});
    const v = await fx.admin('pq-identity/audit/verify', {});
    expect(v.body).toMatchObject({ ok: true, entries: 3, checkpoints: 2, verifiedThrough: 3, unsignedTail: 0 });

    // tamper with the persisted log: flip an outcome
    const file = join(dir, 'audit', `audit-${new Date().toISOString().slice(0, 10)}.jsonl`);
    const records = readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as AuditRecord);
    expect(records).toHaveLength(5);
    const tampered = records.map((r) => (r.type === 'call' && r.seq === 2 ? { ...r, outcome: 'success' } : r));
    const bad = verifyAudit(tampered as AuditRecord[], keys.publicKey);
    expect(bad.ok).toBe(false);
    expect(bad.problems.join(' ')).toMatch(/seq 2: entry was modified/);
    const forged = records.map((r) => (r.type === 'checkpoint' ? { ...r, signature: { ...r.signature, mldsa: hybridKeygen().privateKey && r.signature.mldsa.replace(/^./, (c) => (c === 'A' ? 'B' : 'A')) } } : r));
    expect(verifyAudit(forged as AuditRecord[], keys.publicKey).problems.join(' ')).toMatch(/ml-dsa-65 signature does not verify/);
    const dropped = records.filter((r) => !(r.type === 'call' && r.seq === 2));
    expect(verifyAudit(dropped, keys.publicKey).problems.join(' ')).toMatch(/gap after seq 1/);
    expect(canonical({ b: 1, a: [2, { d: 1, c: 2 }] })).toBe('{"a":[2,{"c":2,"d":1}],"b":1}');
    expect(experimentalFeatureWarnings({ pqIdentity: {} } as never).map((w) => w.id)).toContain('experimental-pq-identity');
  });
});
