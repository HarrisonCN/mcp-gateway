import { describe, it, expect, afterEach } from 'vitest';
import { fileURLToPath } from 'url';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { McpProxy } from '../src/proxy/index.js';
import { ServerRegistry } from '../src/registry/index.js';
import { ServerSupervisor, computeBackoff, resolveReconnect, DEFAULT_RECONNECT } from '../src/gateway/supervisor.js';
import type { McpServerConfig } from '../src/utils/types.js';
import { logger } from '../src/utils/logger.js';

logger.setLevel('error');
const fixture = fileURLToPath(new URL('./fixtures/fake-mcp-server.mjs', import.meta.url));
const cfg = (over: Partial<McpServerConfig> = {}): McpServerConfig => ({
  id: 'fake',
  name: 'Fake',
  transport: 'stdio',
  command: process.execPath,
  args: [fixture],
  timeout: 3000,
  ...over,
});
const fast = { initialDelayMs: 30, maxDelayMs: 200, jitter: 0 };

const waitFor = async (pred: () => boolean, ms = 5000) => {
  const end = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > end) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 20));
  }
};

let proxy: McpProxy;
let sup: ServerSupervisor | undefined;
afterEach(async () => {
  sup?.stop();
  sup = undefined;
  await proxy?.disconnectAll();
});

function setup(reconnect = fast) {
  proxy = new McpProxy({ killGraceMs: 200 });
  const registry = new ServerRegistry();
  sup = new ServerSupervisor(proxy, registry, { reconnect });
  return registry;
}

describe('computeBackoff', () => {
  const policy = { ...DEFAULT_RECONNECT, initialDelayMs: 100, maxDelayMs: 1000, multiplier: 2, jitter: 0 };
  it('grows exponentially and caps at maxDelayMs', () => {
    expect([1, 2, 3, 4, 5, 6].map((a) => computeBackoff(a, policy))).toEqual([100, 200, 400, 800, 1000, 1000]);
  });
  it('applies bounded jitter', () => {
    const p = { ...policy, jitter: 0.5 };
    expect(computeBackoff(2, p, () => 0)).toBe(100);
    expect(computeBackoff(2, p, () => 1)).toBe(300);
    expect(computeBackoff(10, p, () => 1)).toBe(1000); // never above the cap
  });
  it('merges gateway defaults with server overrides', () => {
    const r = resolveReconnect({ initialDelayMs: 500, maxAttempts: 3 }, { maxAttempts: 1, enabled: undefined });
    expect(r).toMatchObject({ enabled: true, initialDelayMs: 500, maxAttempts: 1, multiplier: 2 });
  });
});

describe('ServerSupervisor', () => {
  it('reconnects a crashed stdio server and reports the state', async () => {
    const registry = setup();
    const config = cfg();
    registry.register(config);
    expect(await sup!.connect(config)).toBe(true);
    expect(registry.getHealth('fake')!.status).toBe('online');

    const statuses: string[] = [];
    registry.on('health-changed', (h) => statuses.push(h.status));
    await proxy.callTool('fake', 'crash', {});
    await waitFor(() => registry.getHealth('fake')!.status === 'online' && proxy.isConnected('fake'));

    expect(statuses).toContain('reconnecting');
    const h = registry.getHealth('fake')!;
    expect(h.reconnect).toMatchObject({ state: 'idle', attempt: 0, reconnects: 1 });
    expect(h.reconnect!.lastDisconnectAt).toBeInstanceOf(Date);
    expect(h.connectedSince).toBeInstanceOf(Date);
    expect((await proxy.callTool('fake', 'echo', { a: 1 })).success).toBe(true);
  });

  it('retries a server that failed its first connect until it comes up', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mcpgw-'));
    const flag = join(dir, 'fail');
    writeFileSync(flag, '1');
    try {
      const registry = setup();
      const config = cfg({ env: { FAIL_INIT_IF_EXISTS: flag } });
      registry.register(config);
      expect(await sup!.connect(config)).toBe(false);
      const h = registry.getHealth('fake')!;
      expect(h.status).toBe('reconnecting');
      expect(h.reconnect!.state).toMatch(/scheduled|connecting/);
      expect(h.reconnect!.lastError).toMatch(/initialize/);

      await waitFor(() => (registry.getHealth('fake')!.reconnect?.attempt ?? 0) >= 2);
      rmSync(flag);
      await waitFor(() => registry.getHealth('fake')!.status === 'online');
      expect(registry.getTools('fake').map((t) => t.name)).toEqual(['echo']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('gives up after maxAttempts and marks the server offline', async () => {
    const registry = setup({ ...fast, maxAttempts: 2 } as typeof fast);
    const config = cfg({ env: { FAIL_INIT: '1' } });
    registry.register(config);
    await sup!.connect(config);
    await waitFor(() => registry.getHealth('fake')!.reconnect?.state === 'gave-up');
    expect(registry.getHealth('fake')!.status).toBe('offline');
    expect(registry.getHealth('fake')!.reconnect!.attempt).toBe(2);
  });

  it('does not reconnect when disabled', async () => {
    const registry = setup({ ...fast, enabled: false } as typeof fast);
    const config = cfg();
    registry.register(config);
    await sup!.connect(config);
    await proxy.callTool('fake', 'crash', {});
    await waitFor(() => registry.getHealth('fake')!.status === 'offline');
    expect(registry.getHealth('fake')!.reconnect!.state).toBe('disabled');
    await new Promise((r) => setTimeout(r, 150));
    expect(proxy.isConnected('fake')).toBe(false);
  });

  it('forget() cancels a pending reconnect', async () => {
    const registry = setup({ ...fast, initialDelayMs: 100 } as typeof fast);
    const config = cfg({ env: { FAIL_INIT: '1' } });
    registry.register(config);
    await sup!.connect(config);
    expect(sup!.isRecovering('fake')).toBe(true);
    sup!.forget('fake');
    expect(sup!.isRecovering('fake')).toBe(false);
    expect(sup!.getState('fake')).toBeUndefined();
  });
});
