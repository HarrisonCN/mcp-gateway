/**
 * 14.9.0 consolidated security regression suite — one place that proves every published advisory stays fixed.
 *
 *  S0  registry: every MGW-2026-0xx advisory in SECURITY.md (001–019) maps to a regression test that still exists, and
 *      every advisory in the registry is in SECURITY.md (an advisory never loses its test silently).
 *  S12–S19 a compact end-to-end reproduction of each 2026 advisory from 012 on, written against the attack as published
 *      (the dedicated tests named in the registry go deeper). 016 (plugin TOCTOU) needs a module-level fs mock and is
 *      covered by its registry test only. The Redis cases (012, 014) run against a real redis-server when available.
 *
 * `npm run test:security` runs this file plus every registry test.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync, existsSync, statSync, mkdtempSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Gateway } from '../src/gateway/index.js';
import { loadConfig } from '../src/config/loader.js';
import { globToRegExp } from '../src/utils/tool-filter.js';
import { RedisStateStore } from '../src/state/index.js';
import { taskRuns } from '../src/features/task-graphs.js';
import type { GatewayConfig } from '../src/utils/types.js';
import { logger } from '../src/utils/logger.js';
import { redisServerAvailable, startRealRedis, startFaultProxy } from './fixtures/real-redis.js';

logger.setLevel('error');
/* eslint-disable @typescript-eslint/no-explicit-any */
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const LEDGER = resolve(__dirname, 'fixtures', 'ledger-mcp-server.mjs');
const FAKE = resolve(__dirname, 'fixtures', 'fake-mcp-server.mjs');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let cleanup: Array<() => Promise<unknown> | unknown> = [];
afterEach(async () => {
  for (const f of cleanup.reverse()) await Promise.resolve(f()).catch(() => undefined);
  cleanup = [];
  taskRuns.reset();
});

/** Advisory → the regression test that reproduces it (file, test-name fragment). Keep in sync with SECURITY.md. */
export const ADVISORIES: Record<string, { file: string; test: string }> = {
  'MGW-2026-001': { file: 'test/security-13-1.test.ts', test: 'client allowed on stable, denied on canary' },
  'MGW-2026-002': { file: 'test/security-13-1.test.ts', test: 'closed: a failed DLP module refuses the calls' },
  'MGW-2026-003': { file: 'test/security-13-1.test.ts', test: 'a module failure in kernel A does not affect kernel B' },
  'MGW-2026-004': { file: 'test/security-13-1.test.ts', test: 'a catalog failure after a server was removed leaves the old server connected' },
  'MGW-2026-005': { file: 'test/security-13-1-1.test.ts', test: 'tool cache: split targets never share entries' },
  'MGW-2026-006': { file: 'test/security-13-1-1.test.ts', test: 'a new server is connected but not listed or callable mid-reload' },
  'MGW-2026-007': { file: 'test/identity-13-1-2.test.ts', test: 'policy rule naming the delegator also applies to its delegated calls' },
  'MGW-2026-008': { file: 'test/identity-13-1-2.test.ts', test: 'the same `sub` from two issuers is two different clients' },
  'MGW-2026-009': { file: 'test/final-call-13-1-3.test.ts', test: 'B receives B\\\'s credential, never A\\\'s' },
  'MGW-2026-010': { file: 'test/final-call-13-1-3.test.ts', test: 'a hook rewriting the arguments (no reroute) cannot bypass an argument deny rule' },
  'MGW-2026-011': { file: 'test/reload-13-2-0.test.ts', test: 'an approval hold that spans a reload never runs with the new generation' },
  'MGW-2026-012': { file: 'test/multi-instance-13-7-0.test.ts', test: 'MGW-2026-012 regression' },
  'MGW-2026-013': { file: 'test/security-13-5-0.test.ts', test: 'glob matching is linear (MGW-2026-013)' },
  'MGW-2026-014': { file: 'test/multi-instance-13-7-0.test.ts', test: 'no command runs before AUTH + SELECT' },
  'MGW-2026-015': { file: 'test/tenancy-14-2-0.test.ts', test: 'MGW-2026-015' },
  'MGW-2026-016': { file: 'test/plugin-runtime-14-3-0.test.ts', test: 'R9 TOCTOU: a file changed after its signature was verified' },
  'MGW-2026-017': { file: 'test/task-graphs-mgw-2026-017.test.ts', test: 'a key removed while its run is in flight' },
  'MGW-2026-018': { file: 'test/edge-mgw-2026-018.test.ts', test: 'a key removed while the edge was offline' },
  'MGW-2026-019': { file: 'test/apikeys-env-mgw-2026-019.test.ts', test: 'does not accept the literal' },
};

describe('S0 advisory registry', () => {
  const security = readFileSync(join(ROOT, 'SECURITY.md'), 'utf8');
  const published = [...security.matchAll(/^\| (MGW-2026-\d{3}) \|/gm)].map((m) => m[1]!);
  it('every advisory in SECURITY.md has a registry entry and vice versa; ids are contiguous', () => {
    expect(published.length).toBeGreaterThanOrEqual(19);
    expect([...published].sort()).toEqual(Object.keys(ADVISORIES).sort());
    published.forEach((id, i) => expect(id).toBe(`MGW-2026-${String(i + 1).padStart(3, '0')}`));
  });
  it('each advisory\'s regression test file exists and still mentions the advisory or contains the named test', () => {
    for (const [id, { file, test }] of Object.entries(ADVISORIES)) {
      const p = join(ROOT, file);
      expect(existsSync(p), `${id}: ${file}`).toBe(true);
      const src = readFileSync(p, 'utf8');
      expect(test.length, id).toBeGreaterThan(10);
      expect(src.includes(test), `${id}: "${test}" in ${file}`).toBe(true);
    }
    // the dedicated advisory files (test/*mgw-2026-*.test.ts) are all registered
    const dedicated = readdirSync(join(ROOT, 'test')).filter((n) => /mgw-2026-\d{3}/i.test(n));
    for (const n of dedicated) expect(Object.values(ADVISORIES).some((a) => a.file === `test/${n}`), n).toBe(true);
  });
});

async function gateway(cfg: Record<string, unknown>) {
  const gw = new Gateway({ port: 0, host: '127.0.0.1', logLevel: 'error', monitor: { requestLog: false }, ...cfg } as unknown as GatewayConfig);
  await gw.start();
  cleanup.push(() => gw.stop());
  const base = `http://127.0.0.1:${gw.address()!.port}`;
  const req = async (path: string, body?: unknown, key = 'op') => {
    const r = await fetch(`${base}/api/v1/${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const t = await r.text();
    let b: any = t;
    try { b = JSON.parse(t); } catch { /* text */ }
    return { status: r.status, body: b };
  };
  return { gw, base, req };
}
const ledgerEnv = () => {
  const dir = mkdtempSync(join(tmpdir(), 'sec149-'));
  const ledger = join(dir, 'ledger.jsonl');
  const count = (tool: string) => (existsSync(ledger) ? readFileSync(ledger, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((l) => l.tool === tool).length : 0);
  return { dir, ledger, count, server: { id: 'ledger', name: 'ledger', transport: 'stdio', command: process.execPath, args: [LEDGER], env: { LEDGER: ledger }, timeout: 10_000 } };
};

describe.runIf(redisServerAvailable)('S12 / S14 Redis client (real redis-server)', () => {
  it('MGW-2026-012: after timeouts and a reconnect, a revocation check reads its own key, never another reply', async () => {
    const r = await startRealRedis();
    cleanup.push(() => r.close());
    const p = await startFaultProxy(r.port);
    cleanup.push(() => p.close());
    const s = new RedisStateStore({ url: `redis://127.0.0.1:${p.port}`, commandTimeoutMs: 150, connectTimeoutMs: 1000 });
    cleanup.push(() => s.close());
    await s.set('agent-identity:revoked:jti-1', '1');
    for (let i = 0; i < 20; i++) await s.set(`rl:${i}`, String(i));
    p.latency(300);
    await Promise.allSettled(Array.from({ length: 20 }, (_, i) => s.get(`rl:${i}`)));
    p.heal();
    await sleep(400);
    expect(await s.get('agent-identity:revoked:jti-1')).toBe('1'); // revoked stays revoked
    expect(await s.get('agent-identity:revoked:jti-2')).toBeUndefined();
    expect(await Promise.all(Array.from({ length: 20 }, (_, i) => s.get(`rl:${i}`)))).toEqual(Array.from({ length: 20 }, (_, i) => String(i)));
  });

  it('MGW-2026-014: commands right after (re)connect go to the configured database, after AUTH', async () => {
    const r = await startRealRedis({ password: 'pw-149' });
    cleanup.push(() => r.close());
    const p = await startFaultProxy(r.port);
    cleanup.push(() => p.close());
    await r.cmd('SET', 'agent-identity:revoked:jti-x', 'db0-decoy');
    p.latency(25);
    const s = new RedisStateStore({ url: `redis://:pw-149@127.0.0.1:${p.port}/3`, commandTimeoutMs: 1000, connectTimeoutMs: 1000 });
    cleanup.push(() => s.close());
    const first = await Promise.all(Array.from({ length: 10 }, () => s.get('agent-identity:revoked:jti-x')));
    expect(new Set(first)).toEqual(new Set([undefined])); // never the db 0 decoy
    await s.set('agent-identity:revoked:jti-y', 'db3');
    expect(await r.cmd('GET', 'agent-identity:revoked:jti-y')).toBeNull(); // nothing leaked into db 0
  });
});

describe('S13 MGW-2026-013 glob ReDoS', () => {
  it('a client-supplied hostile pattern finishes in linear time with unchanged semantics', () => {
    const t0 = Date.now();
    for (let n = 10; n <= 40; n += 10) expect(globToRegExp('*a'.repeat(n) + 'zz').test('a'.repeat(400))).toBe(false);
    expect(Date.now() - t0).toBeLessThan(500);
    expect(globToRegExp('github/search_*').test('github/search_code')).toBe(true);
  });
});

describe('S15 MGW-2026-015 cross-tenant credential use', () => {
  it('a member of two tenants calling tenant B\'s server sends B\'s secret, never its first tenant\'s', async () => {
    process.env.MGW_S15_KEY_acme = 'acme-secret';
    process.env.MGW_S15_KEY_labs = 'labs-secret';
    const inject = [{ ref: 'secret://env/MGW_S15_KEY_{tenant}', argument: 'api_key' }];
    const srv = (id: string) => ({ id, name: id, transport: 'stdio', command: process.execPath, args: [FAKE], timeout: 5000, inject });
    const g = await gateway({
      auth: { strategy: 'api-key', apiKeys: [{ key: 'op', name: 'ops' }, { key: 'k-dual', name: 'dual' }] },
      secrets: { providers: [{ id: 'env', type: 'env' }] },
      servers: [srv('acme-db'), srv('labs-db')],
      tenants: [{ id: 'acme', servers: ['acme-*'], members: [{ client: 'key:dual', role: 'admin' }] }, { id: 'labs', servers: ['labs-*'], members: [{ client: 'key:dual', role: 'admin' }] }],
    });
    const echoed = async (server: string) => JSON.parse((await g.req('tools/call', { server, tool: 'echo', arguments: {} }, 'k-dual')).body.result.content[0].text);
    expect((await echoed('labs-db')).api_key).toBe('labs-secret');
    expect((await echoed('acme-db')).api_key).toBe('acme-secret');
  });
});

describe('S17 MGW-2026-017 task-graph runs with a removed key', () => {
  it('a key removed while its run waits cannot act through the run; checkpoints are 0600 in a 0700 dir', async () => {
    const e = ledgerEnv();
    const runs = join(e.dir, 'runs');
    const keys = [{ key: 'op', name: 'ops' }, { key: 'k-temp', name: 'temp' }];
    const cfg = { servers: [e.server], auth: { strategy: 'api-key', apiKeys: keys }, taskGraphs: { dir: runs, graphs: [{ id: 'pay', nodes: [{ id: 'w', tool: 'ledger/slow', args: { ms: 700 } }, { id: 'c', tool: 'ledger/charge', needs: ['w'], args: { id: 'X' } }] }] } };
    const g = await gateway(cfg);
    const id = (await g.req('admin/task-graphs/run', { graph: 'pay', input: {} }, 'k-temp')).body.runId;
    await sleep(150);
    await g.gw.reload({ ...(g.gw as any).config, auth: { strategy: 'api-key', apiKeys: [keys[0]] } } as GatewayConfig);
    const t0 = Date.now();
    let run: any;
    do { run = (await g.req(`admin/task-graphs/runs/${id}`)).body; await sleep(50); } while (['running', 'compensating'].includes(run?.status) && Date.now() - t0 < 10_000);
    expect(run.status).not.toBe('succeeded');
    expect(e.count('charge')).toBe(0);
    expect(statSync(runs).mode & 0o777).toBe(0o700);
    for (const f of readdirSync(runs)) expect(statSync(join(runs, f)).mode & 0o777, f).toBe(0o600);
  });
});

describe('S18 MGW-2026-018 edge-autonomy replay with a removed key', () => {
  it('a key removed while offline never has its queued call executed; state files are 0600 in a 0700 dir', async () => {
    const e = ledgerEnv();
    const state = join(e.dir, 'edge');
    const keys = [{ key: 'op', name: 'ops' }, { key: 'k-temp', name: 'temp' }];
    const cfg = { servers: [e.server], auth: { strategy: 'api-key', apiKeys: keys }, edgeAutonomy: { dir: state, rules: [{ match: 'ledger/*', action: 'queue' }], policies: [{ match: 'ledger/upsert', offline: 'allow' }], reconcile: { intervalMs: 3_600_000 } } };
    const g = await gateway(cfg);
    await sleep(250);
    await g.req('admin/edge-autonomy/connectivity', { disconnected: true });
    const q = await g.req('tools/call', { server: 'ledger', tool: 'upsert', arguments: { key: 'u1' } }, 'k-temp');
    expect(q.body?.result?.structuredContent?.queued).toBe(true);
    await g.gw.reload({ ...(g.gw as any).config, auth: { strategy: 'api-key', apiKeys: [keys[0]] } } as GatewayConfig);
    await g.req('admin/edge-autonomy/connectivity', { disconnected: false });
    await g.req('admin/edge-autonomy/reconcile', {});
    await sleep(300);
    expect(e.count('upsert')).toBe(0);
    expect(statSync(state).mode & 0o777).toBe(0o700);
    for (const f of readdirSync(state).filter((n) => statSync(join(state, n)).isFile())) expect(statSync(join(state, f)).mode & 0o777, f).toBe(0o600);
  });
});

describe('S19 MGW-2026-019 literal ${VAR} API keys', () => {
  it('a file written like the control-plane guide never accepts the literal reference as a key', async () => {
    process.env.MGW_S19_OPERATOR_KEY = 'op-s19-0123456789abcdef0123456789abcdef';
    const dir = mkdtempSync(join(tmpdir(), 'sec149-019-'));
    const file = join(dir, 'mcp-gateway.yml');
    writeFileSync(file, 'version: 13\nhost: 127.0.0.1\ncontrolPlane:\n  role: control\nauth:\n  strategy: api-key\n  apiKeys:\n    - ${MGW_S19_OPERATOR_KEY}\nservers: []\n');
    const cfg = await loadConfig(file);
    const g = await gateway({ ...cfg });
    expect((await fetch(`${g.base}/api/v1/admin/config`, { headers: { authorization: 'Bearer ${MGW_S19_OPERATOR_KEY}' } })).status).toBe(401);
    expect((await fetch(`${g.base}/api/v1/admin/config`, { headers: { authorization: `Bearer ${process.env.MGW_S19_OPERATOR_KEY}` } })).status).toBe(200);
    writeFileSync(file, 'version: 13\nauth:\n  strategy: api-key\n  apiKeys:\n    - ${MGW_S19_UNSET_VAR}\nservers: []\n');
    await expect(loadConfig(file)).rejects.toThrow(/MGW_S19_UNSET_VAR/);
  });
});
