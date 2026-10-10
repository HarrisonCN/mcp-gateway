/**
 * 13.2.0 Transactional Kernel Reload — written first, against 13.1.3 (see the failing-before notes).
 *
 *  - every committed config is an immutable, numbered generation; a failed reload does not bump it;
 *  - modified servers are prepared aside (old session keeps serving) and swapped in at commit; a modify whose new
 *    session cannot be prepared rolls back and the old server stays callable;
 *  - in-flight calls are pinned to the generation they started in: server config, credentials, session, policy and
 *    plugins never mix across generations (an approval hold that spans a reload does not run with the new config);
 *  - plugin updates: partial builds are closed, a failed update keeps (and never closes) the old instances, a later
 *    commit failure restores them;
 *  - feature modules: init / reconfigure / disable failures roll the reload back with compensation;
 *  - races: concurrent reloads are serialized; an old server's reconnect during a reload never overwrites the new one;
 *  - fault injection at every reload phase leaves the old generation serving;
 *  - N reloads do not grow handles, timers, listeners, sessions or child processes.
 */
import { describe, it, expect, afterEach, beforeAll } from 'vitest';
import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { startFeatureGw, fakeServer, type FeatureGw } from './helpers/feature-gw.js';
import { registerFeature, FEATURE_ACTIVATION } from '../src/gateway/features.js';
import type { GatewayConfig } from '../src/utils/types.js';
import { clientPrincipal } from '../src/auth/authorizer.js';

/* eslint-disable @typescript-eslint/no-explicit-any */
type Gw = any;

let h: FeatureGw | undefined;
afterEach(async () => {
  await h?.stop();
  h = undefined;
});

const ADMIN_TOKEN = 'admin-token-gen2-ONLY';
process.env.MGW_T132_ADMIN = ADMIN_TOKEN;

const call = async (server: string, args: Record<string, unknown> = { x: 1 }, key = 'op', tool = 'echo') => {
  const r = await fetch(`${h!.base}/api/v1/tools/call`, {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify({ server, tool, arguments: args }),
  });
  const text = await r.text();
  return { status: r.status, text };
};
const tagOf = (text: string): string | undefined => /"_server\\?":\\?"([a-z0-9-]+)/.exec(text)?.[1];
const until = async (cond: () => boolean | Promise<boolean>, ms = 8000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('condition not met in time');
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const genOf = (gw: Gw): number | undefined => gw.generation?.id;

/** Holds a reload right before its commit (13.1.1 harness: the feature-router reconcile is the first commit step that awaits). */
function gateCommit(gw: Gw, fail?: string) {
  let open!: () => void;
  let reached!: () => void;
  const atCommit = new Promise<void>((r) => (reached = r));
  const released = new Promise<void>((r) => (open = r));
  const orig = gw.featureRouter.reconcile.bind(gw.featureRouter);
  gw.featureRouter.reconcile = async (...a: unknown[]) => {
    reached();
    await released;
    gw.featureRouter.reconcile = orig;
    if (fail) throw new Error(fail);
    return orig(...a);
  };
  return { atCommit, open: () => open() };
}

// ── generations ──────────────────────────────────────────────────────────────

describe('versioned config generations (13.2.0)', () => {
  it('a committed reload bumps the generation; a failed one does not; snapshots are frozen', async () => {
    h = await startFeatureGw();
    const gw = h.gw as Gw;
    expect(genOf(gw)).toBe(1);
    expect(Object.isFrozen(gw.generation.config)).toBe(true);
    expect(Object.isFrozen(gw.generation.config.servers)).toBe(true);
    await gw.reload({ ...gw.config, logLevel: 'warn' } as GatewayConfig);
    expect(genOf(gw)).toBe(2);
    const g = gateCommit(gw, 'boom');
    const r = gw.reload({ ...gw.config, logLevel: 'error' } as GatewayConfig);
    await g.atCommit;
    g.open();
    await expect(r).rejects.toThrow(/boom/);
    expect(genOf(gw)).toBe(2);
    expect(gw.config.logLevel).toBe('warn');
    const k = await h.admin('kernel');
    expect(k.body.reload?.generation).toBe(2);
    expect(k.body.reload?.rollbacks).toBe(1);
  }, 30_000);
});

// ── modified / removed servers ───────────────────────────────────────────────

describe('per-server Prepare / Commit / Rollback for modified and removed servers (13.2.0)', () => {
  it('a modify whose new session cannot be prepared is rolled back: the old server keeps serving', async () => {
    h = await startFeatureGw({ servers: [fakeServer('fake', { SERVER_TAG: 'v1' })] } as never);
    const gw = h.gw as Gw;
    expect(tagOf((await call('fake')).text)).toBe('v1');
    await expect(gw.reload({ ...gw.config, servers: [fakeServer('fake', { SERVER_TAG: 'v2', FAIL_INIT: '1' })] } as GatewayConfig)).rejects.toThrow(/fake/);
    const r = await call('fake');
    expect(r.status).toBe(200);
    expect(tagOf(r.text)).toBe('v1');
    expect(gw.config.servers[0].env.SERVER_TAG).toBe('v1');
    expect(gw.registry.getServer('fake').env.SERVER_TAG).toBe('v1');
  }, 30_000);

  it('during a modify the old session serves until commit; afterwards the new one does', async () => {
    h = await startFeatureGw({ servers: [fakeServer('fake', { SERVER_TAG: 'v1' })] } as never);
    const gw = h.gw as Gw;
    const g = gateCommit(gw);
    const r = gw.reload({ ...gw.config, servers: [fakeServer('fake', { SERVER_TAG: 'v2' })] } as GatewayConfig);
    await g.atCommit;
    expect(tagOf((await call('fake')).text)).toBe('v1');
    g.open();
    await r;
    expect(tagOf((await call('fake')).text)).toBe('v2');
  }, 30_000);

  it('an in-flight call on a modified server completes on its own (old) session instead of being cut off', async () => {
    h = await startFeatureGw({ servers: [fakeServer('fake', { SERVER_TAG: 'v1', SLOW_MS: '700' })] } as never);
    const gw = h.gw as Gw;
    const inflight = call('fake', { x: 1 }, 'op', 'slow');
    await sleep(150);
    await gw.reload({ ...gw.config, servers: [fakeServer('fake', { SERVER_TAG: 'v2' })] } as GatewayConfig);
    const r = await inflight;
    expect(r.status).toBe(200);
    expect(tagOf(r.text)).toBe('v1');
    expect(tagOf((await call('fake')).text)).toBe('v2');
  }, 30_000);

  it('an in-flight call on a removed server drains; new calls are refused', async () => {
    h = await startFeatureGw({ servers: [fakeServer('fake'), fakeServer('gone', { SERVER_TAG: 'gone', SLOW_MS: '700' })] } as never);
    const gw = h.gw as Gw;
    const inflight = call('gone', { x: 1 }, 'op', 'slow');
    await sleep(150);
    await gw.reload({ ...gw.config, servers: [fakeServer('fake')] } as GatewayConfig);
    expect((await call('gone')).status).toBe(404);
    const r = await inflight;
    expect(r.status).toBe(200);
    expect(tagOf(r.text)).toBe('gone');
    await until(() => !gw.proxy.isConnected('gone'));
  }, 30_000);

  it('a commit failure after a modify was prepared keeps the old session and closes the prepared one', async () => {
    h = await startFeatureGw({ servers: [fakeServer('fake', { SERVER_TAG: 'v1' })] } as never);
    const gw = h.gw as Gw;
    const g = gateCommit(gw, 'commit exploded');
    const r = gw.reload({ ...gw.config, servers: [fakeServer('fake', { SERVER_TAG: 'v2' })] } as GatewayConfig);
    await g.atCommit;
    g.open();
    await expect(r).rejects.toThrow(/commit exploded/);
    expect(tagOf((await call('fake')).text)).toBe('v1');
    expect(gw.proxy.sessionCount?.()).toBe(1);
  }, 30_000);
});

// ── in-flight pinning (no cross-generation reads) ────────────────────────────

describe('in-flight calls are pinned to one generation (13.2.0)', () => {
  it('an approval hold that spans a reload never runs with the new generation’s server config or credentials', async () => {
    h = await startFeatureGw({
      servers: [fakeServer('fake', { SERVER_TAG: 'v1' })],
      policy: { rules: [{ name: 'hold', effect: 'approve', tools: ['echo'] }], approval: { timeoutSeconds: 30 } },
    } as never);
    const gw = h.gw as Gw;
    const pending = call('fake', { q: 'gen1' });
    await until(() => gw.invoker.approvals.list().pending.length === 1);
    // Generation 2: the same server id now points at a privileged upstream with an admin credential, and the policy
    // denies the tool to everyone.
    await gw.reload({
      ...gw.config,
      servers: [{ ...fakeServer('fake', { SERVER_TAG: 'v2' }), inject: [{ ref: 'secret://env/MGW_T132_ADMIN', argument: 'token' }] }],
      policy: { rules: [{ name: 'lockdown', effect: 'deny', tools: ['echo'] }], approval: { timeoutSeconds: 30 } },
    } as GatewayConfig);
    const id = gw.invoker.approvals.list().pending[0].id;
    gw.invoker.approvals.decide(id, true, 'key:op');
    const r = await pending;
    // eslint-disable-next-line no-console
    console.log('[approval-span-reload]', r.status, r.text.slice(0, 300));
    expect(r.text).not.toContain(ADMIN_TOKEN);
    expect(tagOf(r.text)).not.toBe('v2');
    if (r.status === 200) expect(tagOf(r.text)).toBe('v1');
    // new calls use generation 2 (denied)
    expect((await call('fake')).status).toBe(403);
  }, 30_000);

  it('the final security snapshot carries the generation the call was authorized in', async () => {
    h = await startFeatureGw();
    const gw = h.gw as Gw;
    await gw.reload({ ...gw.config, logLevel: 'warn' } as GatewayConfig);
    const res = await gw.invoker.invoke({ serverId: 'fake', name: 'echo', kind: 'tool', method: 'tools/call', params: { a: 1 }, via: 'rest', principal: clientPrincipal('key:op'), clientId: 'key:op' });
    expect(res.error).toBeUndefined();
    expect(res.snapshot?.generation).toBe(2);
  }, 30_000);
});

// ── plugins ──────────────────────────────────────────────────────────────────

describe('plugin updates are transactional (13.2.0)', () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'mgw132-'));
    const src = (name: string) => `
      const g = globalThis.__mgw132 ??= { seq: 0, closed: [], seen: [], hold: undefined };
      export default (ctx) => {
        const inst = '${name}#' + (++g.seq) + ':' + (ctx.options.tag ?? '');
        return {
          name: '${name}', apiVersion: 5,
          async onToolCall() { if (g.hold) await g.hold; },
          onResponse(call, r) { g.seen.push(inst); },
          close() { g.closed.push(inst); },
        };
      };`;
    writeFileSync(join(dir, 'pa.mjs'), src('pa'));
    writeFileSync(join(dir, 'pb.mjs'), src('pb'));
    writeFileSync(join(dir, 'broken.mjs'), 'export default () => { throw new Error("broken plugin"); };');
  });
  const G = () => (globalThis as any).__mgw132 as { seq: number; closed: string[]; seen: string[]; hold?: Promise<void> };
  const reset = () => Object.assign(G() ?? ((globalThis as any).__mgw132 = {}), { seq: 0, closed: [], seen: [], hold: undefined });

  it('a failing plugin update fails the whole reload; built instances are closed; old ones keep running', async () => {
    reset();
    h = await startFeatureGw({ configDir: dir, plugins: [{ module: './pa.mjs', options: { tag: 'v1' } }] } as never);
    const gw = h.gw as Gw;
    await call('fake');
    expect(G().seen).toEqual(['pa#1:v1']);
    await expect(
      gw.reload({ ...gw.config, configDir: dir, logLevel: 'warn', plugins: [{ module: './pa.mjs', options: { tag: 'v2' } }, { module: './broken.mjs' }] } as GatewayConfig),
    ).rejects.toThrow(/broken plugin/);
    expect(G().closed).toEqual(['pa#2:v2']); // the partially built instance — never the running one
    expect(gw.config.logLevel).not.toBe('warn');
    expect(gw.config.plugins[0].options.tag).toBe('v1');
    await call('fake');
    expect(G().seen).toEqual(['pa#1:v1', 'pa#1:v1']);
  }, 30_000);

  it('a commit failure after the plugin swap restores the old instances (not closed) and closes the new ones', async () => {
    reset();
    h = await startFeatureGw({ configDir: dir, plugins: [{ module: './pa.mjs', options: { tag: 'v1' } }] } as never);
    const gw = h.gw as Gw;
    const orig = gw.invoker.refreshPolicy.bind(gw.invoker);
    gw.invoker.refreshPolicy = () => {
      gw.invoker.refreshPolicy = orig;
      throw new Error('policy commit exploded');
    };
    await expect(
      gw.reload({ ...gw.config, configDir: dir, plugins: [{ module: './pa.mjs', options: { tag: 'v2' } }], policy: { rules: [{ effect: 'allow', tools: ['*'] }] } } as GatewayConfig),
    ).rejects.toThrow(/policy commit exploded/);
    expect(G().closed).toEqual(['pa#2:v2']);
    await call('fake');
    expect(G().seen.at(-1)).toBe('pa#1:v1');
  }, 30_000);

  it('a call in flight across a plugin swap runs onResponse of its own generation’s plugins, closed only after it ends', async () => {
    reset();
    h = await startFeatureGw({ configDir: dir, plugins: [{ module: './pa.mjs', options: { tag: 'v1' } }] } as never);
    const gw = h.gw as Gw;
    let release!: () => void;
    G().hold = new Promise<void>((r) => (release = r));
    const inflight = call('fake');
    await sleep(200);
    G().hold = undefined;
    await gw.reload({ ...gw.config, configDir: dir, plugins: [{ module: './pa.mjs', options: { tag: 'v2' } }] } as GatewayConfig);
    expect(G().closed).toEqual([]); // still used by the in-flight call
    release();
    expect((await inflight).status).toBe(200);
    expect(G().seen).toEqual(['pa#1:v1']);
    await until(() => G().closed.includes('pa#1:v1'));
    await call('fake');
    expect(G().seen.at(-1)).toBe('pa#2:v2');
  }, 30_000);
});

// ── feature modules ──────────────────────────────────────────────────────────

const tx = { failReconfigure: false, failInitB: false, events: [] as string[], timers: new Set<NodeJS.Timeout>() };
registerFeature({
  id: 'tx-a',
  since: '13.2.0',
  summary: 'test module A',
  mount: () => {},
  init: () => {
    tx.events.push('a:init');
    tx.timers.add(setInterval(() => {}, 60_000));
  },
  reconfigure: (next) => {
    tx.events.push(`a:reconfigure:${next.logLevel}`);
    if (tx.failReconfigure && next.logLevel === 'warn') throw new Error('reconfigure exploded');
  },
  disable: () => {
    tx.events.push('a:disable');
  },
  dispose: () => {
    tx.events.push('a:dispose');
    for (const t of tx.timers) clearInterval(t);
    tx.timers.clear();
  },
});
registerFeature({
  id: 'tx-b',
  since: '13.2.0',
  summary: 'test module B',
  mount: () => {},
  init: () => {
    tx.events.push('b:init');
    if (tx.failInitB) throw new Error('init exploded');
  },
  dispose: () => {
    tx.events.push('b:dispose');
  },
});
(FEATURE_ACTIVATION as Record<string, string[]>)['tx-a'] = ['sla'];
(FEATURE_ACTIVATION as Record<string, string[]>)['tx-b'] = ['sla'];

describe('module init / reconfigure / destroy compensation (13.2.0)', () => {
  const resetTx = () => Object.assign(tx, { failReconfigure: false, failInitB: false, events: [] });
  it('a reconfigure failure rolls the reload back; the module stays active with its old config and calls work', async () => {
    resetTx();
    h = await startFeatureGw({ sla: {}, logLevel: 'error' } as never);
    const gw = h.gw as Gw;
    tx.failReconfigure = true;
    await expect(gw.reload({ ...gw.config, logLevel: 'warn' } as GatewayConfig)).rejects.toThrow(/reconfigure exploded/);
    expect(gw.config.logLevel).toBe('error');
    expect(gw.featureRouter.failureOf('tx-a')).toBeUndefined();
    expect(gw.featureRouter.modules().find((m: any) => m.id === 'tx-a').state).toBe('active');
    expect((await call('fake')).status).toBe(200);
  }, 30_000);

  it('a new module whose init fails rolls the reload back and disposes what this reload initialised', async () => {
    resetTx();
    h = await startFeatureGw({} as never);
    const gw = h.gw as Gw;
    tx.failInitB = true;
    await expect(gw.reload({ ...gw.config, sla: {} } as GatewayConfig)).rejects.toThrow(/init exploded/);
    expect(gw.config.sla).toBeUndefined();
    expect(tx.events).toContain('a:init');
    expect(tx.events).toContain('a:dispose');
    expect(tx.events).toContain('b:dispose');
    expect(tx.timers.size).toBe(0);
    expect(gw.featureRouter.failureOf('tx-b')).toBeUndefined();
    expect((await call('fake')).status).toBe(200);
    // a later good reload activates both
    tx.failInitB = false;
    await gw.reload({ ...gw.config, sla: {} } as GatewayConfig);
    expect(gw.featureRouter.modules().find((m: any) => m.id === 'tx-b').state).toBe('active');
  }, 30_000);
});

// ── races ────────────────────────────────────────────────────────────────────

describe('reload races (13.2.0)', () => {
  it('concurrent reloads are serialized and each gets its own generation', async () => {
    h = await startFeatureGw();
    const gw = h.gw as Gw;
    await Promise.all([
      gw.reload({ ...gw.config, servers: [fakeServer('fake'), fakeServer('a')] } as GatewayConfig),
      gw.reload({ ...gw.config, servers: [fakeServer('fake'), fakeServer('b')] } as GatewayConfig),
    ]);
    expect(genOf(gw)).toBe(3);
    expect(gw.config.servers.map((s: any) => s.id)).toEqual(['fake', 'b']);
    expect(gw.registry.getAllServers().map((s: any) => s.id).sort()).toEqual(['b', 'fake']);
  }, 30_000);

  it('an old server reconnecting during a reload never replaces the new session', async () => {
    h = await startFeatureGw({ servers: [fakeServer('fake', { SERVER_TAG: 'v1' })], reconnect: { initialDelayMs: 50, maxDelayMs: 50, jitter: 0 } } as never);
    const gw = h.gw as Gw;
    const g = gateCommit(gw);
    const r = gw.reload({ ...gw.config, servers: [fakeServer('fake', { SERVER_TAG: 'v2' })] } as GatewayConfig);
    await g.atCommit;
    // the old upstream drops mid-reload → the supervisor reconnects it with the OLD config
    gw.proxy.emit('disconnected', 'fake', new Error('simulated drop'));
    g.open();
    await r;
    await sleep(400);
    expect(tagOf((await call('fake')).text)).toBe('v2');
    expect(gw.supervisor.getState('fake')?.state).not.toBe('scheduled');
  }, 30_000);
});

// ── fault injection at every phase ───────────────────────────────────────────

describe('fault injection at each reload phase (13.2.0)', () => {
  const phases = ['prepare:catalog', 'prepare:plugins', 'prepare:modules', 'prepare:servers', 'commit:router', 'commit:modules', 'commit:plugins', 'commit:servers', 'commit:final'];
  for (const phase of phases) {
    it(`a failure at ${phase} leaves generation 1 serving with no half-commit`, async () => {
      h = await startFeatureGw({ servers: [fakeServer('fake', { SERVER_TAG: 'v1' }), fakeServer('old')] } as never);
      const gw = h.gw as Gw;
      gw.faults = { [phase]: () => { throw new Error(`fault@${phase}`); } };
      await expect(
        gw.reload({ ...gw.config, logLevel: 'warn', servers: [fakeServer('fake', { SERVER_TAG: 'v2' }), fakeServer('new')], policy: { rules: [{ effect: 'deny', tools: ['echo'], servers: ['old'] }] } } as GatewayConfig),
      ).rejects.toThrow(new RegExp(`fault@${phase}`));
      gw.faults = undefined;
      expect(genOf(gw)).toBe(1);
      expect(tagOf((await call('fake')).text)).toBe('v1');
      expect((await call('old')).status).toBe(200);
      expect((await call('new')).status).toBe(404);
      expect(gw.registry.getServer('new', { includeStaged: true })).toBeUndefined();
      expect(gw.proxy.sessionCount()).toBe(2);
    }, 30_000);
  }
});

// ── no growth across N reloads ───────────────────────────────────────────────

describe('no growing connections / timers / listeners across reloads (13.2.0)', () => {
  it('20 reloads (add, modify, remove, failing) leave handles, timers, listeners, sessions and children flat', async () => {
    h = await startFeatureGw({ servers: [fakeServer('fake', { SERVER_TAG: 'v0' })] } as never);
    const gw = h.gw as Gw;
    const measure = () => {
      const res = (process as any).getActiveResourcesInfo() as string[];
      const listeners = (e: any) => e.eventNames().reduce((n: number, k: string | symbol) => n + e.listenerCount(k), 0);
      return {
        timers: res.filter((r) => r === 'Timeout').length,
        handles: res.filter((r) => r !== 'Timeout' && r !== 'TTYWrap').length,
        proxyListeners: listeners(gw.proxy),
        registryListeners: listeners(gw.registry),
        sessions: gw.proxy.sessionCount(),
        retired: gw.proxy.retiredCount(),
        generationsAlive: gw.generations().alive,
      };
    };
    const cycle = async (i: number) => {
      await gw.reload({ ...gw.config, servers: [fakeServer('fake', { SERVER_TAG: `v${i}` }), fakeServer(`tmp${i}`)] } as GatewayConfig);
      await gw.reload({ ...gw.config, servers: [fakeServer('fake', { SERVER_TAG: `v${i}` })] } as GatewayConfig);
      await gw.reload({ ...gw.config, servers: [fakeServer('fake', { SERVER_TAG: 'bad', FAIL_INIT: '1' })] } as GatewayConfig).catch(() => {});
      await call('fake');
    };
    await cycle(0);
    await sleep(300);
    const before = measure();
    for (let i = 1; i <= 20; i++) await cycle(i);
    await sleep(500);
    const after = measure();
    // eslint-disable-next-line no-console
    console.log('[reload-leak] before', JSON.stringify(before), 'after', JSON.stringify(after));
    expect(after.sessions).toBe(1);
    expect(after.retired).toBe(0);
    expect(after.generationsAlive).toBe(1);
    expect(after.proxyListeners).toBe(before.proxyListeners);
    expect(after.registryListeners).toBe(before.registryListeners);
    expect(after.handles).toBeLessThanOrEqual(before.handles + 2);
    expect(after.timers).toBeLessThanOrEqual(before.timers + 2);
  }, 120_000);
});
