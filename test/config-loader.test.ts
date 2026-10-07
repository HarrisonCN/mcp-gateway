import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { parse as parseYaml } from 'yaml';
import { loadConfig, resolveConfigPath, generateDefaultConfig } from '../src/config/loader.js';

const ENV_KEYS = ['MCP_GATEWAY_PORT', 'MCP_GATEWAY_HOST', 'MCP_GATEWAY_LOG_LEVEL', 'MCP_GATEWAY_API_KEYS'];
const cwd = process.cwd();

const dirs: string[] = [];

function tmp() {
  const d = mkdtempSync(join(tmpdir(), 'mcpgw-loader-'));
  dirs.push(d);
  return d;
}

afterEach(() => {
  for (const k of ENV_KEYS) delete process.env[k];
  dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true }));
});

describe('config loader', () => {
  it('reads JSON files', async () => {
    const p = join(tmp(), 'gw.json');
    writeFileSync(p, JSON.stringify({ port: 5001, servers: [{ id: 'a', name: 'A', transport: 'stdio', command: 'node' }] }));
    const c = await loadConfig(p);
    expect(c.port).toBe(5001);
    expect(c.servers[0]!.maxConcurrency).toBe(10);
  });

  it('rejects malformed JSON', async () => {
    const p = join(tmp(), 'gw.json');
    writeFileSync(p, '{ nope');
    await expect(loadConfig(p)).rejects.toThrow(SyntaxError);
  });

  it('rejects a non-mapping top level', async () => {
    const d = tmp();
    const list = join(d, 'list.yml');
    writeFileSync(list, '- a\n- b\n');
    await expect(loadConfig(list)).rejects.toThrow(/mapping\/object at the top level/);
    const scalar = join(d, 'scalar.yml');
    writeFileSync(scalar, '42\n');
    await expect(loadConfig(scalar)).rejects.toThrow(/mapping\/object/);
  });

  it('fails clearly when an explicit path does not exist', async () => {
    await expect(loadConfig(join(tmp(), 'missing.yml'))).rejects.toThrow(/ENOENT/);
  });

  it('applies MCP_GATEWAY_* env overrides over the file', async () => {
    const p = join(tmp(), 'gw.yml');
    writeFileSync(p, 'port: 4000\nhost: 127.0.0.1\nlogLevel: info\n');
    process.env.MCP_GATEWAY_PORT = '8123';
    process.env.MCP_GATEWAY_HOST = '::1';
    process.env.MCP_GATEWAY_LOG_LEVEL = 'debug';
    process.env.MCP_GATEWAY_API_KEYS = ' k1 , ,k2 ';
    const c = await loadConfig(p);
    expect(c.port).toBe(8123);
    expect(c.host).toBe('::1');
    expect(c.logLevel).toBe('debug');
    expect(c.auth).toMatchObject({ strategy: 'api-key', apiKeys: ['k1', 'k2'] });
  });

  it('validates env overrides like file values', async () => {
    process.env.MCP_GATEWAY_PORT = '99999';
    const p = join(tmp(), 'gw.yml');
    writeFileSync(p, '{}\n');
    await expect(loadConfig(p)).rejects.toThrow(/port/);
    process.env.MCP_GATEWAY_PORT = '4000';
    process.env.MCP_GATEWAY_LOG_LEVEL = 'verbose';
    await expect(loadConfig(p)).rejects.toThrow(/logLevel/);
  });

  it('reports every issue with its path', async () => {
    const p = join(tmp(), 'gw.yml');
    writeFileSync(
      p,
      'port: 0\nhealthCheckIntervalMs: 10\nservers:\n  - {id: w, name: W, transport: websocket, url: "http://x"}\n',
    );
    const err = (await loadConfig(p).catch((e) => e)) as Error;
    expect(err.message).toMatch(/^Invalid configuration:/);
    expect(err.message).toMatch(/- port:/);
    expect(err.message).toMatch(/- healthCheckIntervalMs:/);
    expect(err.message).toMatch(/- servers\.0\.url: websocket transport needs a ws:\/\/ or wss:\/\/ URL/);
  });

  it('rejects oauth2 and out-of-range reconnect settings', async () => {
    const d = tmp();
    const a = join(d, 'a.yml');
    writeFileSync(a, 'auth: {strategy: oauth2}\n');
    await expect(loadConfig(a)).rejects.toThrow(/oauth2 is not implemented/);
    const b = join(d, 'b.yml');
    writeFileSync(b, 'reconnect: {multiplier: 0.5, jitter: 2}\n');
    await expect(loadConfig(b)).rejects.toThrow(/reconnect\.multiplier[\s\S]*reconnect\.jitter/);
  });

  describe('resolveConfigPath', () => {
    it('resolves an explicit path to absolute', () => {
      expect(resolveConfigPath('rel/x.yml')).toBe(join(cwd, 'rel/x.yml'));
    });

    it('returns undefined when no default file exists in the working directory', () => {
      // The repo root has no mcp-gateway.* file; discovery order is covered in cli.test.ts
      // (process.chdir is unavailable in vitest worker threads).
      expect(resolveConfigPath()).toBeUndefined();
    });
  });

  it('generateDefaultConfig produces a config that passes validation', async () => {
    const text = generateDefaultConfig();
    expect(() => parseYaml(text)).not.toThrow();
    const p = join(tmp(), 'mcp-gateway.yml');
    writeFileSync(p, text);
    const c = await loadConfig(p);
    expect(c.servers.map((s) => s.id)).toEqual(['filesystem', 'github']);
    expect(c.servers[1]!.env!.GITHUB_PERSONAL_ACCESS_TOKEN).toBe('${GITHUB_TOKEN}');
  });
});
