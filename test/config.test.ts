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
});
