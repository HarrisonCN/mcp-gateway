/**
 * 13.4.0 module contract harness: ONE shared lifecycle / security contract applied to every feature module registered
 * in the manifest (46 in 13.x). A module that is added to the manifest is covered automatically; it only needs a
 * minimal config section in test/helpers/module-contract.ts.
 *
 * Contract:
 *   C1 manifest      ids unique, a registered module per id (same id / since / summary), activation keys are
 *                    feature config keys, dependencies exist and are acyclic, minimal sections validate (schema v11).
 *   C2 hooks         every manifest `hook` is registered by its module and every built-in hook is declared.
 *   C3 failureMode   hook modules declare a failure policy; guards are `closed` and not configurable; a module that
 *                    fails to initialise is handled by its policy (closed → -32026, open → call runs, degrade → call
 *                    runs and the result is marked degraded).
 *   C4 lifecycle     init → active (routes reachable), reconfigure keeps it active, disable → routes 404, its hook leaves
 *                    the plan and every background timer it started is stopped, re-enable → active again without
 *                    duplicated timers, gateway stop → no timer left; dispose is idempotent.
 *   C5 generation    a call hook reads configuration only from the call's pinned generation (the `cfg` argument or the
 *                    pinned context) — never from a generation committed while the call is in flight.
 *   C6 identity      every hook (before / after / refused) sees the authoritative identity: `clientId` = the
 *                    principal's subject (not a feature label) and the principal itself.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { Gateway } from '../src/gateway/index.js';
import type { GatewayConfig } from '../src/utils/types.js';
import { logger } from '../src/utils/logger.js';
import { VERSION } from '../src/utils/version.js';
import { validateConfig } from '../src/config/loader.js';
import { FEATURE_MANIFEST, failurePolicyOf, hookOwner } from '../src/features/manifest.js';
import { FEATURE_CONFIG_KEYS, registeredFeature, registerFeature, type FeatureModule } from '../src/gateway/features.js';
import { loadFeature } from '../src/gateway/kernel-runtime.js';
import { callHookPlan, registerCallHook, type CallHook, type HookCall } from '../src/gateway/hooks.js';
import { failureScopeOf } from '../src/gateway/failure-scope.js';
import { callGeneration, frozenCopy, type ConfigGeneration } from '../src/gateway/generation.js';
import { fixture } from './helpers/feature-gw.js';
import { minimalSections } from './helpers/module-contract.js';

logger.setLevel('error');

// ── background timer tracking (C4) ────────────────────────────────────────────────────────────────────────────────
const liveIntervals = new Set<unknown>();
const realSetInterval = globalThis.setInterval;
const realClearInterval = globalThis.clearInterval;
beforeAll(() => {
  (globalThis as { setInterval: unknown }).setInterval = ((...a: Parameters<typeof setInterval>) => {
    const t = realSetInterval(...a);
    liveIntervals.add(t);
    return t;
  }) as typeof setInterval;
  (globalThis as { clearInterval: unknown }).clearInterval = ((t: Parameters<typeof clearInterval>[0]) => {
    liveIntervals.delete(t);
    return realClearInterval(t);
  }) as typeof clearInterval;
});
afterAll(() => {
  globalThis.setInterval = realSetInterval;
  globalThis.clearInterval = realClearInterval;
});

const { sections } = minimalSections();
const srv = (id: string) => ({ id, name: id, transport: 'stdio' as const, command: process.execPath, args: [fixture], timeout: 5000 });
const OP = 'contract-operator-key-0123456789abcdef';
const base = () => ({ port: 0, host: '127.0.0.1', logLevel: 'error', monitor: { requestLog: false }, servers: [srv('fake'), srv('fake2')], auth: { strategy: 'api-key', apiKeys: [OP] } }) as unknown as GatewayConfig;
const withModule = (id: string, extra: Record<string, unknown> = {}) => ({ ...base(), ...sections[id], ...extra }) as unknown as GatewayConfig;
const settle = (ms = 120) => new Promise((r) => setTimeout(r, ms));
const hdr = { authorization: `Bearer ${OP}`, 'content-type': 'application/json' };
/* eslint-disable @typescript-eslint/no-explicit-any */
const kernelState = (gw: Gateway, id: string) => (gw as any).featureRouter.modules().find((m: any) => m.id === id);
const urlOf = (gw: Gateway) => `http://127.0.0.1:${gw.address()!.port}`;
const callTool = async (gw: Gateway, tool = 'echo', args: Record<string, unknown> = { text: 'hi' }) => {
  const r = await fetch(`${urlOf(gw)}/api/v1/tools/call`, { method: 'POST', headers: hdr, body: JSON.stringify({ server: 'fake', tool, arguments: args }) });
  return { status: r.status, body: (await r.json()) as any };
};
const errorCode = (b: any): number | undefined => b?.error?.code ?? b?.code;

const IDS = FEATURE_MANIFEST.map((e) => e.id);
const HOOK_MODULES = FEATURE_MANIFEST.filter((e) => e.hook);
const running: Gateway[] = [];
afterEach(async () => {
  for (const g of running.splice(0)) await g.stop().catch(() => undefined);
});
const start = async (cfg: GatewayConfig) => {
  const gw = new Gateway(cfg);
  running.push(gw);
  await gw.start();
  return gw;
};
const semver = (v: string) => v.split('.').map(Number).reduce((a, n) => a * 1000 + n, 0);

beforeAll(async () => {
  for (const id of IDS) expect(await loadFeature(id), `load ${id}`).toBe(true);
}, 60_000);

// ── C1 / C2 / C3 (static) ─────────────────────────────────────────────────────────────────────────────────────────
describe('C1 manifest contract', () => {
  it('46 registered modules, unique ids, one minimal section each', () => {
    expect(IDS.length).toBe(46);
    expect(new Set(IDS).size).toBe(IDS.length);
    for (const id of IDS) expect(sections[id], `no minimal section for "${id}"`).toBeDefined();
  });

  it.each(IDS)('%s: registered as declared, since ≤ current version, activation keys / dependencies valid', (id) => {
    const e = FEATURE_MANIFEST.find((x) => x.id === id)!;
    const m = registeredFeature(id);
    expect(m, 'module registers itself').toBeDefined();
    expect({ id: m!.id, since: m!.since, summary: m!.summary }).toEqual({ id: e.id, since: e.since, summary: e.summary });
    expect(semver(e.since)).toBeLessThanOrEqual(semver(VERSION));
    for (const k of e.activation ?? []) expect(FEATURE_CONFIG_KEYS as readonly string[]).toContain(k);
    for (const d of e.dependsOn ?? []) expect(IDS.indexOf(d), `dependency ${d}`).toBeGreaterThanOrEqual(0);
    const seen = new Set<string>();
    const walk = (x: string) => {
      expect(seen.has(x), `dependency cycle through ${x}`).toBe(false);
      seen.add(x);
      for (const d of FEATURE_MANIFEST.find((y) => y.id === x)?.dependsOn ?? []) walk(d);
      seen.delete(x);
    };
    walk(id);
    // the minimal section is valid schema-v11 configuration
    const { configDir: _dir, ...features } = sections[id] as Record<string, unknown>;
    expect(() => validateConfig({ version: 11, servers: [], features })).not.toThrow();
  });
});

describe('C2 call hooks are declared', () => {
  it('every manifest hook is registered by its module, every built-in hook is declared in the manifest', () => {
    const eager = { kernel: { modules: 'eager' } } as unknown as GatewayConfig;
    const registered = callHookPlan(eager, () => undefined).hooks.map((h) => h.id).filter((h) => !h.startsWith('test-') && !h.startsWith('contract-'));
    for (const e of HOOK_MODULES) expect(registered, `hook of ${e.id}`).toContain(e.hook);
    for (const h of registered) expect(hookOwner(h), `undeclared hook ${h}`).toBeDefined();
  });
});

describe('C3 failure policy (static)', () => {
  it.each(HOOK_MODULES.map((e) => e.id))('%s: explicit failure policy; guards closed and not configurable', (id) => {
    const e = FEATURE_MANIFEST.find((x) => x.id === id)!;
    expect(e.failurePolicy, 'hook modules declare failurePolicy').toBeDefined();
    if (e.guard) {
      expect(e.failurePolicy).toBe('closed');
      expect(e.failurePolicyConfigurable ?? false).toBe(false);
      // a configured override never weakens a guard
      expect(failurePolicyOf(id, { kernel: { failurePolicy: { [id]: 'open' } } } as unknown as GatewayConfig)).toBe('closed');
    }
  });
});

// ── C4 lifecycle (runtime, every module) ──────────────────────────────────────────────────────────────────────────
describe('C4 lifecycle', () => {
  let minimalRunning = 0;
  beforeAll(async () => {
    const before = liveIntervals.size;
    const gw = await start(base());
    await settle();
    minimalRunning = liveIntervals.size - before;
    await gw.stop();
    running.length = 0;
    await settle(200);
  }, 30_000);

  it.each(IDS)('%s: init → reconfigure → disable → re-enable → stop', async (id) => {
    const e = FEATURE_MANIFEST.find((x) => x.id === id)!;
    const before = liveIntervals.size;
    const cfg = withModule(id);
    const gw = await start(cfg);
    // modules without an activation section are loaded on first request
    await fetch(`${urlOf(gw)}/api/v1/admin/${id}/`, { headers: hdr });
    await settle();
    expect(kernelState(gw, id)).toMatchObject({ state: 'active' });
    expect(kernelState(gw, id).error).toBeUndefined();
    const activeTimers = liveIntervals.size - before;

    // reconfigure (a reload that keeps the section) keeps the module active
    await gw.reload({ ...cfg, monitor: { requestLog: false, historySize: 50 } } as GatewayConfig);
    await settle();
    expect(kernelState(gw, id)).toMatchObject({ state: 'active' });

    if (e.activation?.length) {
      // disable: section removed → routes answer 404, its hook leaves the plan, its timers stop
      await gw.reload(base());
      await settle();
      expect(kernelState(gw, id).state).toBe('disabled');
      expect((await fetch(`${urlOf(gw)}/api/v1/admin/${id}/`, { headers: hdr })).status).toBe(404);
      if (e.hook) expect(callHookPlan((gw as any).config, (x) => (gw as any).featureRouter.failureOf(x)).hooks.map((h) => h.id)).not.toContain(e.hook);
      expect(liveIntervals.size - before, `timers left running by disabled module "${id}"`).toBe(minimalRunning);

      // re-enable: active again, timers not duplicated
      await gw.reload(cfg);
      await settle();
      expect(kernelState(gw, id)).toMatchObject({ state: 'active' });
      expect(liveIntervals.size - before, `timers after re-enabling "${id}"`).toBe(activeTimers);
    }

    await gw.stop();
    await settle(150);
    expect(liveIntervals.size, `timers left after stop by "${id}"`).toBe(before);
    // dispose is idempotent
    await expect((gw as any).featureRouter.dispose()).resolves.toBeUndefined();
    await expect((gw as any).featureRouter.dispose()).resolves.toBeUndefined();
  }, 30_000);
});

// ── C3 failure policy (runtime, every hook module) ────────────────────────────────────────────────────────────────
describe('C3 failure policy at runtime', () => {
  it.each(HOOK_MODULES.map((e) => e.id))('%s: a failed init is handled by the module failure policy', async (id) => {
    const orig = registeredFeature(id)! as FeatureModule;
    registerFeature({ ...orig, init: () => { throw new Error('contract: injected init failure'); } });
    try {
      const gw = await start(withModule(id));
      await settle();
      expect(kernelState(gw, id).state).toBe('failed');
      const policy = failurePolicyOf(id, withModule(id), true);
      const r = await callTool(gw);
      // 13.1.1: a closed module refuses only the calls in its failure scope (derived from its own config section)
      const scope = failureScopeOf(id, withModule(id));
      const governed = !scope || scope.matches({ serverId: 'fake', tool: 'echo', clientId: r.body?.clientId });
      if (policy === 'closed' && governed) expect(errorCode(r.body), JSON.stringify(r.body)).toBe(-32026);
      else {
        expect(r.status, JSON.stringify(r.body)).toBe(200);
        expect(r.body.result?.content, JSON.stringify(r.body)).toBeDefined();
        const degraded = r.body.result?._meta?.['mcp-gateway/degraded'];
        if (policy === 'degrade') expect(degraded).toMatchObject({ modules: expect.arrayContaining([id]) });
        else expect(degraded).toBeUndefined();
      }
    } finally {
      registerFeature(orig);
    }
  }, 30_000);
});

// ── C5 generation pin (every hook module) ─────────────────────────────────────────────────────────────────────────
describe('C5 generation pin', () => {
  it.each(HOOK_MODULES.map((e) => e.id))('%s: hooks read only the pinned generation', async (id) => {
    const e = FEATURE_MANIFEST.find((x) => x.id === id)!;
    const cfg = withModule(id);
    const gw = await start(cfg);
    await settle();
    const hook = callHookPlan((gw as any).config, () => undefined).hooks.find((h) => h.id === e.hook)!;
    expect(hook).toBeDefined();
    const pinned: ConfigGeneration = { id: 1, config: frozenCopy((gw as any).config), servers: new Map(), plugins: [], committedAt: new Date().toISOString() };
    // a generation committed while the call is in flight: every read of it is recorded
    const live = (gw as any).config;
    const reads: string[] = [];
    (gw as any).config = new Proxy(live, { get: (t, k) => (typeof k === 'string' && reads.push(k), Reflect.get(t, k)) });
    const principal = { kind: 'client' as const, id: 'key:contract-op' };
    const call: HookCall = { serverId: 'fake', tool: 'echo', clientId: principal.id, args: { text: 'hi' }, principal };
    try {
      await callGeneration.run(pinned, async () => {
        const c = pinned.config as GatewayConfig;
        await Promise.resolve(hook.before?.(call, c)).catch(() => undefined);
        await Promise.resolve(hook.after?.(call, { success: true, result: { content: [{ type: 'text', text: 'ok' }] }, durationMs: 1 } as any, c)).catch(() => undefined);
        try { hook.refused?.(call, { code: -32003, message: 'denied' }, c); } catch { /* must not throw, not part of C5 */ }
      });
    } finally {
      (gw as any).config = live;
    }
    expect(reads, `hook "${e.hook}" read the live (unpinned) config`).toEqual([]);
  }, 30_000);
});

// ── C6 identity context (every hook module) ───────────────────────────────────────────────────────────────────────
describe('C6 identity context', () => {
  it.each(HOOK_MODULES.map((e) => e.id))('%s: hooks see the principal and its subject, never the call-site label', async (id) => {
    const e = FEATURE_MANIFEST.find((x) => x.id === id)!;
    const gw = await start(withModule(id));
    await settle();
    const hook = callHookPlan((gw as any).config, () => undefined).hooks.find((h) => h.id === e.hook)! as CallHook;
    const seen: Array<{ phase: string; clientId?: string; principal?: string }> = [];
    const orig = { before: hook.before, after: hook.after };
    if (orig.before) hook.before = (c, cfg) => (seen.push({ phase: 'before', clientId: c.clientId, principal: c.principal?.id }), orig.before!(c, cfg));
    if (orig.after) hook.after = (c, r, cfg) => (seen.push({ phase: 'after', clientId: c.clientId, principal: c.principal?.id }), orig.after!(c, r, cfg));
    try {
      const operator = { kind: 'client', id: 'key:contract-op' };
      await (gw as any).invoker.invoke({ serverId: 'fake', name: 'echo', kind: 'tool', method: 'tools/call', params: { text: 'x' }, clientId: 'feature:contract-label', principal: operator, via: 'rest' });
    } finally {
      Object.assign(hook, orig);
    }
    for (const s of seen) {
      expect(s.clientId, `${s.phase}: clientId is the subject`).toBe('key:contract-op');
      expect(s.principal, `${s.phase}: principal present`).toBe('key:contract-op');
    }
  }, 30_000);

  it('refused hooks receive the principal too (pipeline contract shared by every module)', async () => {
    const gw = await start({ ...base(), policy: { rules: [{ name: 'deny-echo', effect: 'deny', tools: ['echo'] }] } } as unknown as GatewayConfig);
    const seen: HookCall[] = [];
    registerCallHook({ id: 'contract-spy', refused: (c) => void seen.push(c), before: (c) => void seen.push(c) });
    try {
      const operator = { id: 'key:contract-op', kind: 'client' };
      const r = await (gw as any).invoker.invoke({ serverId: 'fake', name: 'echo', kind: 'tool', method: 'tools/call', params: {}, clientId: 'feature:contract-label', principal: operator, via: 'rest' });
      expect(r.success).toBe(false);
    } finally {
      registerCallHook({ id: 'contract-spy' });
    }
    expect(seen.length).toBeGreaterThan(0);
    for (const c of seen) {
      expect(c.clientId).toBe('key:contract-op');
      expect(c.principal?.id).toBe('key:contract-op');
    }
  }, 30_000);
});
