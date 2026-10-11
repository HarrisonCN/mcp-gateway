// 14.9.0 "v15 release candidate": upgrade and rollback against REAL state stores (sqlite and a real redis-server).
//
// A published release (13.9.x LTS and 14.8.0, installed from npm by scripts/upgrade-test.sh) writes state, is stopped,
// and this checkout starts on the very same store / directories and must carry on without loss or repetition:
//   U1 13.9.x → current   rate-limit windows written by 13.9 are honoured (sqlite, redis)
//   U2 14.8.0 → current   durable tasks: a finished run's idempotency key is still claimed (no second execution), a run
//                         paused for approval resumes and executes exactly once (sqlite, redis)
//   U3 14.8.0 → current   regions: a revocation stored by 14.8 in the region store is enforced by current (sqlite, redis)
//   U4 14.8.0 → current   edge autonomy: a call queued offline by 14.8 (sealed outbox) is replayed once by current, and a
//                         second restart does not replay it again
//   U5 14.8.0 → current   gitops: the release record (replay protection) written by 14.8 is honoured by current
//   R1 current → 14.8.0   rollback: a durable run created by current and paused for approval is resumed by 14.8
//
// Skipped unless MGW_UPGRADE_V13 / MGW_UPGRADE_V14 point at installed packages (directory containing
// node_modules/@winstonsayno/mcp-gateway). The redis variants also need a `redis-server` binary.
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Gateway as CurrentGateway } from '../src/gateway/index.js';
import { ERR_REGION_REVOKED } from '../src/features/regions.js';
import { generateSigningKey, createReleaseManifest, approveRelease, configHash } from '../src/config/gitops.js';
import { logger } from '../src/utils/logger.js';
import { redisServerAvailable, startRealRedis } from './fixtures/real-redis.js';

logger.setLevel('error');
/* eslint-disable @typescript-eslint/no-explicit-any */
type GatewayCtor = new (cfg: any) => { start(): Promise<void>; stop(): Promise<void>; address(): { port: number } | null };

const V13 = process.env.MGW_UPGRADE_V13;
const V14 = process.env.MGW_UPGRADE_V14;
const pkgOf = (dir: string) => join(dir, 'node_modules', '@winstonsayno', 'mcp-gateway');
const versionOf = (dir: string) => JSON.parse(readFileSync(join(pkgOf(dir), 'package.json'), 'utf8')).version as string;
const load = async (dir: string): Promise<GatewayCtor> => (await import(pathToFileURL(join(pkgOf(dir), 'dist', 'index.js')).href)).Gateway;

const LEDGER_FIXTURE = resolve(__dirname, 'fixtures', 'ledger-mcp-server.mjs');
const EDGE_FIXTURE = resolve(__dirname, 'fixtures', 'edge-ledger-mcp-server.mjs');
const FAKE_FIXTURE = resolve(__dirname, 'fixtures', 'fake-mcp-server.mjs');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let cleanup: Array<() => Promise<unknown> | unknown> = [];
afterEach(async () => {
  for (const f of cleanup.reverse()) await Promise.resolve(f()).catch(() => undefined);
  cleanup = [];
});
async function until<T>(f: () => Promise<T> | T, ok: (v: T) => boolean, ms = 10_000): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    const v = await f();
    if (ok(v)) return v;
    if (Date.now() - t0 > ms) throw new Error(`timed out; last ${JSON.stringify(v)}`);
    await sleep(50);
  }
}

type Backend = 'sqlite' | 'redis';
interface Env { dir: string; ledger: string; state: any }
async function env(backend: Backend, prefix: string): Promise<Env> {
  const dir = mkdtempSync(join(tmpdir(), `upgrade-${prefix}-`));
  if (backend === 'sqlite') return { dir, ledger: join(dir, 'ledger.jsonl'), state: { store: 'sqlite', sqlite: { path: join(dir, 'state.db') } } };
  const r = await startRealRedis();
  cleanup.push(() => r.close());
  return { dir, ledger: join(dir, 'ledger.jsonl'), state: { store: 'redis', redis: { url: r.url, connectTimeoutMs: 500, commandTimeoutMs: 1000, keyPrefix: `mgw-up-${prefix}:` } } };
}
const ledgerOf = (e: Env): Array<{ tool: string; args: Record<string, any> }> =>
  existsSync(e.ledger) ? readFileSync(e.ledger, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
const count = (e: Env, tool: string, pred: (a: Record<string, any>) => boolean = () => true) => ledgerOf(e).filter((l) => l.tool === tool && pred(l.args)).length;

/** Start a gateway of either version; `stop()` is idempotent and registered for cleanup. */
async function boot(G: GatewayCtor, cfg: Record<string, unknown>) {
  const gw = new G({ port: 0, host: '127.0.0.1', logLevel: 'error', monitor: { requestLog: false }, ...cfg });
  await gw.start();
  let stopped = false;
  const stop = async () => { if (!stopped) { stopped = true; await gw.stop(); } };
  cleanup.push(stop);
  const base = `http://127.0.0.1:${gw.address()!.port}`;
  const req = async (path: string, body?: unknown, key = 'op', headers: Record<string, string> = {}) => {
    const r = await fetch(`${base}/api/v1/${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json', ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const t = await r.text();
    let b: any = t;
    try { b = JSON.parse(t); } catch { /* text */ }
    return { status: r.status, body: b, text: t };
  };
  return { gw, stop, req };
}

const KEYS = [{ key: 'op', name: 'ops' }, { key: 'k-alice', name: 'alice' }, { key: 'k-lead', name: 'lead-1' }, { key: 'k-other', name: 'other' }];
const ledgerServer = (e: Env, fixture = LEDGER_FIXTURE) => ({ id: 'ledger', name: 'ledger', transport: 'stdio', command: process.execPath, args: [fixture], env: { LEDGER: e.ledger }, timeout: 10_000 });
const BACKENDS: Backend[] = redisServerAvailable ? ['sqlite', 'redis'] : ['sqlite'];

describe.runIf(!!V13)('U1 13.9.x → current (rate-limit state)', () => {
  for (const backend of BACKENDS) {
    it(`a per-key rate-limit window written by ${V13 ? versionOf(V13) : '13.9'} is honoured after the upgrade (${backend})`, async () => {
      const Old = await load(V13!);
      const e = await env(backend, `u1-${backend}`);
      const cfg = {
        servers: [ledgerServer(e)],
        auth: { strategy: 'api-key', apiKeys: ['op', { key: 'k-limited', name: 'limited', servers: ['ledger'], rateLimit: { limit: 3, windowSeconds: 120 } }] },
        state: e.state,
      };
      const call = (g: Awaited<ReturnType<typeof boot>>) => g.req('tools/call', { server: 'ledger', tool: 'upsert', arguments: { key: `k${Math.random()}` } }, 'k-limited');
      const a = await boot(Old, cfg);
      expect((await call(a)).status).toBe(200);
      expect((await call(a)).status).toBe(200);
      await a.stop();
      const b = await boot(CurrentGateway as unknown as GatewayCtor, cfg);
      expect((await call(b)).status).toBe(200); // third in the window
      expect((await call(b)).status).toBe(429); // fourth: the 13.9 counter was carried over
      expect(count(e, 'upsert')).toBe(3);
    }, 30_000);
  }
});

describe.runIf(!!V14)('14.8.0 → current (14.x state)', () => {
  const DURABLE = { leaseMs: 1000, sweepIntervalMs: 100 };
  const graphs = [
    { id: 'pay', clients: true, nodes: [{ id: 'a', tool: 'ledger/charge', args: { id: '{{input.id}}' } }] },
    { id: 'wire', clients: true, nodes: [{ id: 'pay', tool: 'ledger/charge', args: { id: '{{input.id}}' }, approval: { approvers: ['key:lead-*'], timeoutSeconds: 3600 } }] },
  ];
  const durableCfg = (e: Env) => ({ servers: [ledgerServer(e)], auth: { strategy: 'api-key', apiKeys: KEYS }, state: e.state, taskGraphs: { durable: DURABLE, graphs } });
  const runOf = (g: Awaited<ReturnType<typeof boot>>, id: string) => g.req(`admin/task-graphs/runs/${id}`).then((r) => r.body);

  for (const backend of BACKENDS) {
    it(`U2 durable tasks survive the upgrade: idempotency key still claimed, approval resumes exactly once (${backend})`, async () => {
      const Old = await load(V14!);
      const e = await env(backend, `u2-${backend}`);
      const a = await boot(Old, durableCfg(e));
      const r1 = (await a.req('features/task-graphs/run', { graph: 'pay', input: { id: 'P1' } }, 'k-alice', { 'idempotency-key': 'up-1' })).body.runId;
      await until(() => runOf(a, r1).then((r) => r.status), (s) => s === 'succeeded');
      const r2 = (await a.req('features/task-graphs/run', { graph: 'wire', input: { id: 'W1' } }, 'k-alice')).body.runId;
      await until(() => runOf(a, r2).then((r) => r.status), (s) => s === 'awaiting_approval');
      await a.stop();

      const b = await boot(CurrentGateway as unknown as GatewayCtor, durableCfg(e));
      expect((await runOf(b, r1)).status).toBe('succeeded');
      const dup = await b.req('features/task-graphs/run', { graph: 'pay', input: { id: 'P1' } }, 'k-alice', { 'idempotency-key': 'up-1' });
      expect(dup.body).toMatchObject({ runId: r1, duplicate: true });
      await sleep(300);
      expect(count(e, 'charge', (x) => x.id === 'P1')).toBe(1);
      expect((await runOf(b, r2)).status).toBe('awaiting_approval');
      expect(count(e, 'charge', (x) => x.id === 'W1')).toBe(0);
      expect((await b.req(`features/task-graphs/runs/${r2}/approve`, { node: 'pay', reason: 'post-upgrade' }, 'k-lead')).status).toBe(200);
      await until(() => runOf(b, r2).then((r) => r.status), (s) => s === 'succeeded');
      expect(count(e, 'charge', (x) => x.id === 'W1')).toBe(1);
    }, 45_000);

    it(`U3 a region revocation stored by 14.8.0 is enforced after the upgrade (${backend})`, async () => {
      const Old = await load(V14!);
      const e = await env(backend, `u3-${backend}`);
      const cfg = {
        servers: [{ id: 'fake', name: 'fake', transport: 'stdio', command: process.execPath, args: [FAKE_FIXTURE], timeout: 5000 }],
        auth: { strategy: 'api-key', apiKeys: ['op', { key: 'k-other', name: 'other', servers: ['fake'] }, { key: 'k-alice', name: 'alice', servers: ['fake'] }] },
        state: e.state,
        regions: { self: 'a', syncIntervalMs: 250, consistency: { maxStalenessMs: 1500 }, peers: [] },
      };
      const call = (g: Awaited<ReturnType<typeof boot>>, key: string) => g.req('tools/call', { server: 'fake', tool: 'echo', arguments: { q: 'x' } }, key);
      const a = await boot(Old, cfg);
      const first = await call(a, 'k-other');
      expect(first.status, first.text).toBe(200);
      expect((await a.req('admin/regions/revocations', { clientId: 'key:other', reason: 'compromised' })).status).toBeLessThan(300);
      await until(() => call(a, 'k-other'), (x) => x.text.includes(String(ERR_REGION_REVOKED)));
      await sleep(500); // let the store push happen
      await a.stop();
      const b = await boot(CurrentGateway as unknown as GatewayCtor, cfg);
      await until(() => call(b, 'k-other'), (x) => x.text.includes(String(ERR_REGION_REVOKED)), 5000);
      expect((await call(b, 'k-alice')).status).toBe(200);
    }, 30_000);
  }

  it('U4 a call queued offline by 14.8.0 (sealed outbox) is replayed exactly once by current', async () => {
    const Old = await load(V14!);
    const e = await env('sqlite', 'u4');
    const cfg = {
      servers: [ledgerServer(e, EDGE_FIXTURE)], auth: { strategy: 'api-key', apiKeys: KEYS },
      edgeAutonomy: { dir: join(e.dir, 'edge'), rules: [{ match: 'ledger/*', action: 'queue' }], policies: [{ match: 'ledger/rename', offline: 'allow' }], reconcile: { intervalMs: 3_600_000, leaseMs: 1000, idempotencyArg: 'idem' } },
    };
    const a = await boot(Old, cfg);
    await sleep(250);
    expect((await a.req('admin/edge-autonomy/connectivity', { disconnected: true })).status).toBe(200);
    const q = await a.req('tools/call', { server: 'ledger', tool: 'rename', arguments: { id: 1, name: 'A', idem: 'up-k1' } }, 'k-alice');
    expect(q.body?.result?.structuredContent).toMatchObject({ queued: true });
    expect(ledgerOf(e).filter((l) => l.tool === 'rename')).toHaveLength(0);
    await a.stop();

    let b = await boot(CurrentGateway as unknown as GatewayCtor, cfg);
    await sleep(300);
    await b.req('admin/edge-autonomy/connectivity', { disconnected: false });
    await b.req('admin/edge-autonomy/reconcile', {});
    await until(() => ledgerOf(e).filter((l) => l.tool === 'rename').length, (n) => n === 1);
    expect(ledgerOf(e).find((l) => l.tool === 'rename')!.args).toMatchObject({ id: 1, name: 'A', idem: 'up-k1' });
    await b.stop();
    b = await boot(CurrentGateway as unknown as GatewayCtor, cfg);
    await sleep(300);
    await b.req('admin/edge-autonomy/reconcile', {});
    await sleep(300);
    expect(ledgerOf(e).filter((l) => l.tool === 'rename')).toHaveLength(1); // committed: never sent twice
  }, 45_000);

  it('U5 the gitops release record written by 14.8.0 keeps replay protection after the upgrade', async () => {
    const Old = await load(V14!);
    const e = await env('sqlite', 'u5');
    const author = generateSigningKey();
    const alice = generateSigningKey();
    process.env.UPGRADE_OP_KEY = 'op';
    const gitops = { environment: 'prod', enforce: true, recordFile: join(e.dir, 'gitops-release.json'), requiredApprovals: { prod: 1 }, trustedKeys: [{ id: 'ci', name: 'release-bot', publicKey: author.publicKey, roles: ['author'] }, { id: 'alice', name: 'alice', publicKey: alice.publicKey, roles: ['approver'] }] };
    const server = { id: 'fake', name: 'fake', transport: 'stdio', command: process.execPath, args: [FAKE_FIXTURE], timeoutMs: 5000 };
    const base = { servers: [server], auth: { strategy: 'api-key', apiKeys: ['op'] }, controlPlane: { configApi: true, gitops } };
    const bundleCfg = { version: 12, servers: [server], auth: { strategy: 'api-key', apiKeys: ['${UPGRADE_OP_KEY}'] }, controlPlane: { configApi: true, gitops }, rateLimit: { windowSeconds: 60, limit: 123 } };
    const bundle = { schema: 'mcp-gateway/gitops-bundle@1', env: 'prod', config: bundleCfg, configHash: configHash(bundleCfg), files: ['base.yml'] };
    let m = createReleaseManifest({ bundle: bundle as never, gitSha: 'a'.repeat(40), author: 'release-bot', keyId: 'ci', privateKeyPem: author.privateKeyPem });
    m = approveRelease(m, { keyId: 'alice', privateKeyPem: alice.privateKeyPem, by: 'alice' });
    const a = await boot(Old, base);
    const ap = await a.req('admin/gitops/apply', { bundle, manifest: m });
    expect(ap.status, JSON.stringify(ap.body)).toBe(200);
    expect(existsSync(gitops.recordFile)).toBe(true);
    await a.stop();
    const b = await boot(CurrentGateway as unknown as GatewayCtor, base);
    const st = (await b.req('admin/gitops/status')).body;
    expect(st).toMatchObject({ managed: true, release: { gitSha: 'a'.repeat(40), configHash: bundle.configHash } });
    const again = await b.req('admin/gitops/apply', { bundle, manifest: m });
    expect(again.status).toBe(403);
    expect(JSON.stringify(again.body)).toMatch(/replay|not newer/);
  }, 30_000);

  for (const backend of BACKENDS) {
    it(`R1 rollback: a run created by current and paused for approval is resumed by 14.8.0 (${backend})`, async () => {
      const Old = await load(V14!);
      const e = await env(backend, `r1-${backend}`);
      const a = await boot(CurrentGateway as unknown as GatewayCtor, durableCfg(e));
      const r = (await a.req('features/task-graphs/run', { graph: 'wire', input: { id: 'RB' } }, 'k-alice')).body.runId;
      await until(() => runOf(a, r).then((x) => x.status), (s) => s === 'awaiting_approval');
      await a.stop();
      const b = await boot(Old, durableCfg(e));
      expect((await runOf(b, r)).status).toBe('awaiting_approval');
      expect((await b.req(`features/task-graphs/runs/${r}/approve`, { node: 'pay' }, 'k-lead')).status).toBe(200);
      await until(() => runOf(b, r).then((x) => x.status), (s) => s === 'succeeded');
      expect(count(e, 'charge', (x) => x.id === 'RB')).toBe(1);
    }, 45_000);
  }
});
