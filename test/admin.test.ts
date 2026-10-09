import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { fileURLToPath } from 'url';
import { spawnSync, spawn } from 'child_process';
import { createRequire } from 'module';
import { Gateway } from '../src/gateway/index.js';
import { loadConfig, validateConfig } from '../src/config/loader.js';
import { diffConfigs, formatDiff, redactConfig, restoreRedacted, REDACTED } from '../src/config/diff.js';
import { configDeprecations, deprecate, removedConfigKeys, resetDeprecations } from '../src/utils/deprecations.js';
import type { GatewayConfig } from '../src/utils/types.js';
import { logger } from '../src/utils/logger.js';

logger.setLevel('error');
const fixture = fileURLToPath(new URL('./fixtures/fake-mcp-server.mjs', import.meta.url));
const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'mcpgw-admin-'));
  dirs.push(d);
  return d;
};
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

const server = (id: string) => ({ id, name: id, transport: 'stdio' as const, command: process.execPath, args: [fixture], timeout: 5000 });
/** The same server in the config-file schema (v5: `timeoutMs`). */
const fileServer = (id: string) => {
  const { timeout, ...s } = server(id);
  return { ...s, timeoutMs: timeout };
};

describe('config diff and redaction', () => {
  it('redacts secrets and restores them on round trip', () => {
    const cfg = { auth: { strategy: 'api-key', apiKeys: ['k1', { key: 'k2', name: 'ci' }] }, servers: [{ id: 'a', env: { TOKEN: 'x' }, headers: { Authorization: 'y' } }] };
    const red = redactConfig(cfg);
    expect(red.auth.apiKeys).toEqual([REDACTED, { key: REDACTED, name: 'ci' }]);
    expect(red.servers[0]).toMatchObject({ env: { TOKEN: REDACTED }, headers: { Authorization: REDACTED } });
    expect(restoreRedacted(red, cfg)).toEqual(cfg);
    // servers matched by id even when reordered
    const two = { servers: [{ id: 'a', env: { T: '1' } }, { id: 'b', env: { T: '2' } }] };
    expect(restoreRedacted({ servers: [{ id: 'b', env: { T: REDACTED } }, { id: 'a', env: { T: REDACTED } }] }, two)).toEqual({ servers: [{ id: 'b', env: { T: '2' } }, { id: 'a', env: { T: '1' } }] });
  });

  it('diffs sections and servers, flags restart-only fields', () => {
    const a = { port: 1, servers: [server('a'), server('b')], rateLimit: { windowSeconds: 60, limit: 10 } } as unknown as GatewayConfig;
    const b = { port: 2, servers: [{ ...server('a'), timeout: 9 }, server('c')], logLevel: 'debug' } as unknown as GatewayConfig;
    const d = diffConfigs(a, b);
    expect(d.map((c) => `${c.change} ${c.path}`)).toEqual(['added logLevel', 'changed port', 'removed rateLimit', 'changed servers.a.timeout', 'added servers.c', 'removed servers.b']);
    expect(d.find((c) => c.path === 'port')?.restart).toBe(true);
    expect(formatDiff(d)).toContain('~ port (restart): 1 → 2');
    expect(formatDiff([])).toBe('No changes.');
  });
});

describe('3.0 removals', () => {
  beforeEach(() => resetDeprecations());

  it('rejects removed keys and foreign config versions with the replacement', () => {
    expect(removedConfigKeys({ corsOrigins: [], healthCheckIntervalMs: 5000 })).toHaveLength(2);
    expect(configDeprecations({ corsOrigins: [] }).map((d) => d.id)).toEqual([]);
    const cfg = validateConfig({ version: 11, servers: [], cors: { origins: ['https://a.example'] }, health: { intervalMs: 5000 } });
    expect(cfg.cors?.origins).toEqual(['https://a.example']);
    expect(cfg.health?.intervalMs).toBe(5000);
    expect(() => validateConfig({ servers: [], corsOrigins: ['*'] })).toThrow(/corsOrigins: removed in 3.0 — use `cors: \{ origins/);
    expect(() => validateConfig({ servers: [], healthCheckIntervalMs: 2000 })).toThrow(/health: \{ intervalMs/);
    expect(() => validateConfig({ version: 2, servers: [] })).toThrow(/config version 2 is not supported/);
  });

  it('`validate` explains removed keys', () => {
    const require = createRequire(import.meta.url);
    const TSX = join(require.resolve('tsx/package.json'), '..', 'dist', 'cli.mjs');
    const CLI = resolve(__dirname, '..', 'src', 'cli.ts');
    const d = tmp();
    writeFileSync(join(d, 'c.yml'), 'servers: []\ncorsOrigins: ["https://x.example"]\n');
    const r = spawnSync(process.execPath, [TSX, CLI, 'validate', '-c', join(d, 'c.yml')], { encoding: 'utf-8', timeout: 30_000 });
    expect(r.status).toBe(1);
    expect(r.stdout + r.stderr).toContain('migrating-to-v3');
  }, 60_000);
});

describe('admin REST API', () => {
  let gw: Gateway | undefined;
  afterEach(async () => {
    await gw?.stop();
    gw = undefined;
  });

  const start = async (extra: Partial<GatewayConfig> = {}, reloadFromDisk?: () => Promise<GatewayConfig>) => {
    gw = new Gateway(
      { port: 0, host: '127.0.0.1', logLevel: 'error', monitor: { requestLog: false }, servers: [server('fake')], auth: { strategy: 'api-key', apiKeys: ['op', { key: 'scoped', servers: ['fake'] }] }, ...extra } as GatewayConfig,
      { reloadFromDisk },
    );
    await gw.start();
    return `http://127.0.0.1:${gw.address()!.port}/api/v1/admin`;
  };
  const op = { authorization: 'Bearer op', 'content-type': 'application/json' };

  it('serves the redacted config to operators only', async () => {
    const url = await start();
    expect((await fetch(`${url}/config`)).status).toBe(401);
    expect((await fetch(`${url}/config`, { headers: { authorization: 'Bearer scoped' } })).status).toBe(403);
    const body = (await (await fetch(`${url}/config`, { headers: op })).json()) as { config: { auth: { apiKeys: unknown[] }; servers: Array<{ id: string }> } };
    expect(body.config.auth.apiKeys[0]).toBe(REDACTED);
    expect(body.config.servers.map((s) => s.id)).toEqual(['fake']);
  });

  it('validates and diffs a body; PUT needs controlPlane.configApi', async () => {
    const url = await start();
    const { config } = (await (await fetch(`${url}/config`, { headers: op })).json()) as { config: Record<string, unknown> };
    const v = (await (await fetch(`${url}/config/validate`, { method: 'POST', headers: op, body: JSON.stringify({ servers: [], rateLimit: { limit: -1 } }) })).json()) as { valid: boolean; errors: string[] };
    expect(v.valid).toBe(false);
    expect(v.errors.length).toBeGreaterThan(0);
    const desired = { ...config, logLevel: 'warn', rateLimit: { windowSeconds: 60, limit: 5 } };
    const diff = (await (await fetch(`${url}/config/diff`, { method: 'POST', headers: op, body: JSON.stringify(desired) })).json()) as { changes: Array<{ path: string }> };
    expect(diff.changes.map((c) => c.path).sort()).toEqual(['logLevel', 'rateLimit']);
    expect((await fetch(`${url}/config`, { method: 'PUT', headers: op, body: JSON.stringify(desired) })).status).toBe(403);
    expect((await fetch(`${url}/config/diff`, { method: 'POST', headers: op, body: '[]' })).status).toBe(400);
    expect((await fetch(`${url}/config/diff`, { method: 'POST', headers: op, body: JSON.stringify({ servers: 'nope' }) })).status).toBe(400);
  });

  it('applies a config (dry run first), keeping redacted secrets', async () => {
    const url = await start({ controlPlane: { configApi: true } });
    const { config } = (await (await fetch(`${url}/config`, { headers: op })).json()) as { config: Record<string, unknown> };
    const desired = { ...config, rateLimit: { windowSeconds: 60, limit: 1 } };
    const dry = (await (await fetch(`${url}/config?dryRun=true`, { method: 'PUT', headers: op, body: JSON.stringify(desired) })).json()) as { applied: boolean; changes: unknown[] };
    expect(dry).toMatchObject({ applied: false, changes: [{ path: 'rateLimit', change: 'added' }] });
    const done = (await (await fetch(`${url}/config`, { method: 'PUT', headers: op, body: JSON.stringify(desired) })).json()) as { applied: boolean };
    expect(done.applied).toBe(true);
    // The redacted key still works: the operator key was restored, not replaced by "<redacted>".
    const after = await fetch(`${url}/config`, { headers: op });
    expect(after.status).toBe(200);
    const again = (await (await fetch(`${url}/config`, { method: 'PUT', headers: op, body: JSON.stringify(desired) })).json()) as { applied: boolean; changes: unknown[] };
    expect(again).toMatchObject({ applied: false, changes: [] });
  });

  it('reloads from disk and lists deprecations', async () => {
    resetDeprecations();
    let calls = 0;
    deprecate({ id: 'test-dep', removedIn: '7.0.0', replacement: 'x', message: 'test deprecation' }, 'plugin "old"');
    const url = await start({ controlPlane: { configApi: true } }, async () => {
      calls++;
      return validateConfig({ servers: [fileServer('fake')], auth: { strategy: 'api-key', apiKeys: ['op'] }, controlPlane: { configApi: true }, logLevel: 'error', monitor: { requestLog: false } });
    });
    const r = (await (await fetch(`${url}/reload`, { method: 'POST', headers: op })).json()) as { applied: boolean; changes: Array<{ path: string }> };
    expect(calls).toBe(1);
    expect(r.applied).toBe(true);
    expect(r.changes.map((c) => c.path)).toContain('auth');
    const d = (await (await fetch(`${url}/deprecations`, { headers: op })).json()) as { config: unknown[]; runtime: Array<{ id: string }> };
    expect(d.config).toEqual([]);
    expect(d.runtime.map((x) => x.id)).toEqual(['test-dep']);
  });

  it('reload without a config source is 501', async () => {
    const url = await start({ controlPlane: { configApi: true } });
    expect((await fetch(`${url}/reload`, { method: 'POST', headers: op })).status).toBe(501);
  });
});

describe('mcp-gateway diff / apply', () => {
  const require = createRequire(import.meta.url);
  const TSX = join(require.resolve('tsx/package.json'), '..', 'dist', 'cli.mjs');
  const CLI = resolve(__dirname, '..', 'src', 'cli.ts');
  const runAsync = (args: string[]) =>
    new Promise<{ code: number | null; out: string; err: string }>((res) => {
      const p = spawn(process.execPath, [TSX, CLI, ...args], { env: { ...process.env, MCP_GATEWAY_PORT: '', MCP_GATEWAY_API_KEYS: '' } });
      let out = '';
      let err = '';
      p.stdout.on('data', (c) => (out += c));
      p.stderr.on('data', (c) => (err += c));
      p.on('close', (code) => res({ code, out, err }));
    });

  it('diffs two files locally', async () => {
    const d = tmp();
    writeFileSync(join(d, 'a.yml'), 'servers: []\nlogLevel: info\n');
    writeFileSync(join(d, 'b.yml'), 'servers: []\nlogLevel: debug\n');
    const r = await runAsync(['diff', '-c', join(d, 'b.yml'), '--against', join(d, 'a.yml')]);
    expect(r.code).toBe(3);
    expect(r.out).toContain('~ logLevel: "info" → "debug"');
    const same = await runAsync(['diff', '-c', join(d, 'a.yml'), '--against', join(d, 'a.yml'), '--json']);
    expect(same.code).toBe(0);
    expect(JSON.parse(same.out)).toEqual({ changes: [] });
  }, 60_000);

  it('diffs and applies against a running gateway', async () => {
    const gw = new Gateway({ port: 0, host: '127.0.0.1', logLevel: 'error', monitor: { requestLog: false }, servers: [], auth: { strategy: 'api-key', apiKeys: ['op'] }, controlPlane: { configApi: true } } as GatewayConfig);
    await gw.start();
    try {
      const d = tmp();
      writeFileSync(join(d, 'want.yml'), 'servers: []\nauth: { strategy: api-key, apiKeys: [op] }\ncontrolPlane: { configApi: true }\nlogLevel: error\nmonitor: { requestLog: false }\nrateLimit: { windowSeconds: 60, limit: 50 }\n');
      const url = `http://127.0.0.1:${gw.address()!.port}`;
      const diff = await runAsync(['diff', '-c', join(d, 'want.yml'), '--url', url, '--key', 'op']);
      expect(diff.out).toContain('+ rateLimit');
      const dry = await runAsync(['apply', '-c', join(d, 'want.yml'), '--url', url, '--key', 'op', '--dry-run']);
      expect(dry.code).toBe(0);
      expect(dry.out).toContain('dry run');
      const apply = await runAsync(['apply', '-c', join(d, 'want.yml'), '--url', url, '--key', 'op']);
      expect(apply.code).toBe(0);
      expect(apply.out).toContain('✓ Applied');
      const bad = await runAsync(['apply', '-c', join(d, 'want.yml'), '--url', url, '--key', 'wrong']);
      expect(bad.code).toBe(1);
    } finally {
      await gw.stop();
    }
  }, 90_000);
});

void loadConfig;
