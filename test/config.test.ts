import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { loadConfig } from '../src/config/loader.js';

function file(content: string) {
  const dir = mkdtempSync(join(tmpdir(), 'mcpgw-'));
  const p = join(dir, 'mcp-gateway.yml');
  writeFileSync(p, content);
  return p;
}

afterEach(() => {
  delete process.env.MCP_GATEWAY_API_KEYS;
});

describe('loadConfig', () => {
  it('applies defaults', async () => {
    const c = await loadConfig(file('servers:\n  - {id: a, name: A, transport: stdio, command: node}\n'));
    expect(c.port).toBe(4000);
    expect(c.servers[0]!.timeout).toBe(30000);
  });

  it('accepts an empty file', async () => {
    const c = await loadConfig(file(''));
    expect(c.servers).toEqual([]);
  });

  it('rejects duplicate ids and missing command/url', async () => {
    await expect(
      loadConfig(file('servers:\n  - {id: a, name: A, transport: stdio, command: x}\n  - {id: a, name: B, transport: stdio, command: y}\n')),
    ).rejects.toThrow(/duplicate/);
    await expect(loadConfig(file('servers:\n  - {id: a, name: A, transport: stdio}\n'))).rejects.toThrow(/command/);
    await expect(loadConfig(file('servers:\n  - {id: a, name: A, transport: sse}\n'))).rejects.toThrow(/url/);
  });

  it('rejects insecure auth configs', async () => {
    await expect(loadConfig(file('auth: {strategy: api-key}\n'))).rejects.toThrow(/apiKeys/);
    await expect(loadConfig(file('auth: {strategy: jwt}\n'))).rejects.toThrow(/jwtSecret/);
    await expect(loadConfig(file('auth: {strategy: oauth2}\n'))).rejects.toThrow(/oauth2/);
  });

  it('MCP_GATEWAY_API_KEYS enables api-key auth', async () => {
    process.env.MCP_GATEWAY_API_KEYS = 'k1, k2,';
    const c = await loadConfig(file(''));
    expect(c.auth).toEqual({ strategy: 'api-key', apiKeys: ['k1', 'k2'] });
  });

  it('accepts remote transports and checks URL schemes', async () => {
    const c = await loadConfig(
      file(
        'servers:\n' +
          '  - {id: h, name: H, transport: streamable-http, url: "https://x.example/mcp", headers: {Authorization: "Bearer ${T}"}}\n' +
          '  - {id: w, name: W, transport: websocket, url: "wss://x.example/ws", subprotocol: ""}\n' +
          '  - {id: s, name: S, transport: sse, url: "http://x.example/sse", reconnect: {maxAttempts: 3}}\n',
      ),
    );
    expect(c.servers.map((s) => s.transport)).toEqual(['streamable-http', 'websocket', 'sse']);
    expect(c.servers[0]!.headers).toEqual({ Authorization: 'Bearer ${T}' });
    expect(c.servers[2]!.reconnect).toEqual({ maxAttempts: 3 });
    await expect(
      loadConfig(file('servers:\n  - {id: w, name: W, transport: websocket, url: "http://x.example"}\n')),
    ).rejects.toThrow(/ws:\/\//);
    await expect(
      loadConfig(file('servers:\n  - {id: h, name: H, transport: streamable-http, url: "ws://x.example"}\n')),
    ).rejects.toThrow(/http:\/\//);
  });

  it('parses reconnect, protect and dashboard settings with defaults', async () => {
    const c = await loadConfig(
      file(
        'reconnect: {initialDelayMs: 500, maxAttempts: 5}\n' +
          'auth: {strategy: api-key, apiKeys: [k], protect: {metrics: true}}\n' +
          'dashboard: {enabled: false}\n',
      ),
    );
    expect(c.reconnect).toEqual({ initialDelayMs: 500, maxAttempts: 5 });
    expect(c.auth?.protect).toEqual({ health: false, metrics: true });
    expect(c.dashboard).toEqual({ enabled: false });
    expect(c.healthCheckIntervalMs).toBe(30000);
    await expect(loadConfig(file('reconnect: {jitter: 2}\n'))).rejects.toThrow(/jitter/);
  });

  it('MCP_GATEWAY_API_KEYS keeps protect flags from the file', async () => {
    process.env.MCP_GATEWAY_API_KEYS = 'env-key';
    const c = await loadConfig(file('auth: {strategy: none, protect: {health: true}}\n'));
    expect(c.auth).toMatchObject({ strategy: 'api-key', apiKeys: ['env-key'], protect: { health: true } });
  });
});
