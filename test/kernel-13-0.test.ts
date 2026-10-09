// 13.0: true modular kernel — schemas split from modules, import() manifest, declared dependencies, lifecycle with
// dependency ordering and failure isolation; disabled modules are never evaluated (module-load tracing).
import { describe, it, expect, afterEach } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { readFileSync, readdirSync, writeFileSync, mkdtempSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { FEATURE_MANIFEST, manifestEntry } from '../src/features/manifest.js';
import { dependencyOrder, dependentsOf, requireDependency, markRuntimeFailed, clearRuntimeFailed } from '../src/gateway/kernel-runtime.js';
import { createFeatureRouter, FEATURE_ACTIVATION, type FeatureModule, type FeatureRouter } from '../src/gateway/features.js';
import { activeCallHooks, registerCallHook } from '../src/gateway/hooks.js';
import { RELEASE_LINE } from '../src/features/kernel.js';
import { startFeatureGw, type FeatureGw } from './helpers/feature-gw.js';
import type { GatewayConfig } from '../src/utils/types.js';

const SRC = resolve(__dirname, '..', 'src');
const FEAT = join(SRC, 'features');
const moduleFiles = readdirSync(FEAT).filter((f) => f.endsWith('.ts') && !['index.ts', 'manifest.ts'].includes(f));
const featureIds = new Set(moduleFiles.map((f) => f.slice(0, -3)));

let fx: FeatureGw | undefined;
afterEach(async () => {
  await fx?.stop();
  fx = undefined;
});

describe('13.0: manifest and declared dependencies', () => {
  it('lists every feature module file once, in a dependency-respecting order, with the registered id', () => {
    expect(FEATURE_MANIFEST.map((e) => e.id).sort()).toEqual([...featureIds].sort());
    for (const f of moduleFiles) {
      const src = readFileSync(join(FEAT, f), 'utf8');
      expect(src, f).toContain(`id: '${f.slice(0, -3)}'`);
      const e = manifestEntry(f.slice(0, -3))!;
      expect(src.includes('registerCallHook('), `${f} hook`).toBe(!!e.hook);
    }
    const ids = FEATURE_MANIFEST.map((e) => e.id);
    expect(dependencyOrder(ids)).toEqual(ids); // manifest order already has dependencies first
    expect(RELEASE_LINE).toEqual({ line: '13.x', lts: false });
  });

  it('declares exactly the cross-module edges the code uses', () => {
    expect(Object.fromEntries(FEATURE_MANIFEST.filter((e) => e.dependsOn?.length).map((e) => [e.id, e.dependsOn]))).toEqual({
      billing: ['genai-otel'],
      sanitize: ['anomaly'],
      'edge-autonomy': ['edge-runtime', 'offline'],
      'task-graphs': ['a2a-federation'],
    });
    for (const f of moduleFiles) {
      const used = [...readFileSync(join(FEAT, f), 'utf8').matchAll(/requireDependency<[^>]*>\('([a-z0-9-]+)', '([a-z0-9-]+)'\)/g)];
      for (const [, from, dep] of used) {
        expect(from).toBe(f.slice(0, -3));
        expect(manifestEntry(from)!.dependsOn).toContain(dep);
      }
    }
    expect(dependencyOrder(['billing'])).toEqual(['genai-otel', 'billing']);
    expect(dependencyOrder(['edge-autonomy', 'task-graphs'])).toEqual(['a2a-federation', 'task-graphs', 'edge-runtime', 'offline', 'edge-autonomy']);
    expect(dependentsOf('anomaly')).toEqual(['sanitize']);
  });

  it('a module cannot obtain a dependency it did not declare', async () => {
    await expect(requireDependency('billing', 'anomaly')).rejects.toThrow(/without declaring it in dependsOn/);
    const ns = await requireDependency<{ extractUsage: unknown }>('billing', 'genai-otel');
    expect(typeof ns.extractUsage).toBe('function');
  });

  it('no feature module imports another one, and the core imports only schemas / the manifest', () => {
    const value = /^import\s+(?!type\b)[^;]*?from\s+'([^']+)'/gms;
    for (const f of moduleFiles) {
      for (const [, spec] of readFileSync(join(FEAT, f), 'utf8').matchAll(value)) {
        const m = /^\.\/([a-z0-9-]+)\.js$/.exec(spec);
        expect(m && featureIds.has(m[1]) ? `${f} → ${spec}` : '').toBe('');
      }
    }
    for (const f of readdirSync(join(FEAT, 'schemas'))) {
      for (const [, spec] of readFileSync(join(FEAT, 'schemas', f), 'utf8').matchAll(value)) {
        // schemas may import sibling schemas and core modules, never a feature module
        expect(/^\.\.\/[a-z0-9-]+\.js$/.test(spec) ? `${f} → ${spec}` : '').toBe('');
      }
    }
    const files = (d: string): string[] => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? (e.name === 'features' ? [] : files(join(d, e.name))) : e.name.endsWith('.ts') ? [join(d, e.name)] : []));
    for (const f of files(SRC)) {
      if (f === join(SRC, 'index.ts') || f === join(SRC, 'cli.ts')) continue; // the root entry re-exports modules; the CLI import()s them per command
      for (const [, spec] of readFileSync(f, 'utf8').matchAll(value)) {
        const m = /features\/([a-z0-9-]+)\.js$/.exec(spec);
        expect(m && m[1] !== 'manifest' ? `${f.slice(SRC.length)} → ${spec}` : '').toBe('');
      }
    }
  });
});

describe('13.0: disabled modules are never evaluated (module-load tracing)', () => {
  const require = createRequire(import.meta.url);
  const TSX = join(require.resolve('tsx/package.json'), '..', 'dist', 'cli.mjs');
  const dir = mkdtempSync(join(tmpdir(), 'mgw-k13-'));
  const script = join(dir, 'trace.mts');
  writeFileSync(
    script,
    `import { registerHooks } from 'node:module';
const loaded = new Set();
registerHooks({ load(url, ctx, next) { const m = /\\/src\\/features\\/([a-z0-9-]+)\\.ts$/.exec(url); if (m && m[1] !== 'manifest') loaded.add(m[1]); return next(url, ctx); } });
const { Gateway } = await import(${JSON.stringify(join(SRC, 'gateway', 'index.ts'))});
const { logger } = await import(${JSON.stringify(join(SRC, 'utils', 'logger.ts'))});
logger.setLevel('error');
const extra = JSON.parse(process.argv[2]);
const gw = new Gateway({ port: 0, host: '127.0.0.1', logLevel: 'error', servers: [], auth: { strategy: 'api-key', apiKeys: ['k'.repeat(40)] }, monitor: { requestLog: false }, ...extra });
await gw.start();
const atStart = [...loaded].sort();
let kernel;
if (process.argv[3]) kernel = await (await fetch('http://127.0.0.1:' + gw.address().port + '/api/v1/admin/kernel', { headers: { authorization: 'Bearer ' + 'k'.repeat(40) } })).json();
await gw.stop();
console.log(JSON.stringify({ atStart, after: [...loaded].sort(), kernel }));
`,
  );
  const traced = (extra: Partial<GatewayConfig>, askKernel = false) => {
    const r = spawnSync(process.execPath, [TSX, script, JSON.stringify(extra), askKernel ? '1' : ''], { encoding: 'utf8', timeout: 60_000 });
    const line = r.stdout.trim().split('\n').pop() ?? '';
    if (!line.startsWith('{')) throw new Error(r.stderr || r.stdout);
    return JSON.parse(line) as { atStart: string[]; after: string[]; kernel?: { modules: Array<{ id: string; state: string; evaluated: boolean }>; evaluated: string[] } };
  };
  const hasHooks = typeof (require('node:module') as { registerHooks?: unknown }).registerHooks === 'function';

  it.skipIf(!hasHooks)('a gateway with no feature sections evaluates no feature module', () => {
    expect(traced({}).atStart).toEqual([]);
  }, 60_000);

  it.skipIf(!hasHooks)('configured modules (and their declared dependencies) are the only ones evaluated', () => {
    expect(traced({ dlp: {} } as never).atStart).toEqual(['dlp']);
    expect(traced({ billing: {} } as never).atStart).toEqual(['billing', 'genai-otel']);
    const t = traced({ sanitize: {} } as never, true);
    expect(t.atStart).toEqual(['anomaly', 'sanitize']);
    // the kernel module is evaluated on its first request; nothing else is
    expect(t.after).toEqual(['anomaly', 'kernel', 'sanitize']);
    const mods = Object.fromEntries(t.kernel!.modules.map((m) => [m.id, m]));
    expect(mods.sanitize).toMatchObject({ state: 'active', evaluated: true });
    expect(mods.anomaly).toMatchObject({ state: 'inactive', evaluated: true }); // dependency: evaluated, not activated
    expect(mods.dlp).toMatchObject({ state: 'inactive', evaluated: false });
    expect(mods.k8s).toMatchObject({ state: 'available', evaluated: false });
  }, 60_000);

  it.skipIf(!hasHooks)('kernel.modules: eager evaluates every module (10.x behaviour)', () => {
    expect(traced({ kernel: { modules: 'eager' } } as never).atStart).toHaveLength(FEATURE_MANIFEST.length);
  }, 60_000);
});

describe('13.0: lifecycle, dependency ordering and failure isolation', () => {
  const ctxBase = (cfg: () => GatewayConfig) => ({ config: cfg, tools: () => [], invoke: async () => ({ success: true, durationMs: 0 }), recent: () => [], baseUrl: () => undefined });

  async function serve(router: FeatureRouter) {
    const app = express();
    app.use(router);
    const srv = app.listen(0, '127.0.0.1');
    await new Promise((r) => srv.once('listening', r));
    const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
    return { base, close: () => new Promise((r) => srv.close(r)) };
  }

  it('init / reconfigure / disable / dispose run in order; a failing module is isolated', async () => {
    const calls: string[] = [];
    let cfg = { servers: [], kernel: { modules: 'lazy' } } as unknown as GatewayConfig;
    const mod = (id: string, extra: Partial<FeatureModule> = {}): FeatureModule => ({
      id,
      since: '13.0.0',
      summary: id,
      mount: (r) => void r.get('/', (_q, s) => void s.json({ id })),
      init: () => void calls.push(`init:${id}`),
      reconfigure: () => void calls.push(`reconfigure:${id}`),
      disable: () => void calls.push(`disable:${id}`),
      dispose: () => void calls.push(`dispose:${id}`),
      health: () => ({ status: 'ok', id }),
      ...extra,
    });
    const router = createFeatureRouter({
      authenticate: (_q, _s, n) => n(),
      isOperator: () => true,
      context: ctxBase(() => cfg),
      features: [mod('a'), mod('broken', { init: () => { throw new Error('boom'); } }), mod('b')],
    });
    const s = await serve(router);
    expect(await router.activate()).toEqual(['a', 'b']);
    expect(calls).toEqual(['init:a', 'init:b']);
    expect((await fetch(`${s.base}/admin/a`)).status).toBe(200);
    const br = await fetch(`${s.base}/admin/broken`);
    expect(br.status).toBe(503);
    expect((await br.json()).message).toMatch(/init: boom/);
    expect((await fetch(`${s.base}/admin/b`)).status).toBe(200);
    const views = Object.fromEntries(router.modules().map((m) => [m.id, m]));
    expect(views.a).toMatchObject({ state: 'active', health: { status: 'ok' } });
    expect(views.broken).toMatchObject({ state: 'failed', error: 'init: boom' });
    calls.length = 0;
    await router.reconcile(cfg);
    expect(calls).toEqual(['reconfigure:a', 'reconfigure:b']);
    await router.dispose();
    expect(calls.slice(2)).toEqual(['dispose:b', 'dispose:a']);
    clearRuntimeFailed();
    await s.close();
  });

  it('a module whose section is removed is disabled (404) and comes back on re-add', async () => {
    let cfg = { servers: [], dlp: {} } as unknown as GatewayConfig;
    const calls: string[] = [];
    const router = createFeatureRouter({
      authenticate: (_q, _s, n) => n(),
      isOperator: () => true,
      context: ctxBase(() => cfg),
      features: [{ id: 'dlp', since: '5.6.0', summary: 'x', mount: (r) => void r.get('/', (_q, s) => void s.json({})), init: () => void calls.push('init'), disable: () => void calls.push('disable') }],
    });
    const s = await serve(router);
    await router.activate();
    expect((await fetch(`${s.base}/admin/dlp`)).status).toBe(200);
    const prev = cfg;
    cfg = { servers: [] } as unknown as GatewayConfig;
    await router.reconcile(prev);
    expect((await fetch(`${s.base}/admin/dlp`)).status).toBe(404);
    cfg = { servers: [], dlp: {} } as unknown as GatewayConfig;
    await router.reconcile(prev);
    expect((await fetch(`${s.base}/admin/dlp`)).status).toBe(200);
    expect(calls).toEqual(['init', 'disable', 'init']);
    expect(FEATURE_ACTIVATION.dlp).toEqual(['dlp']);
    await s.close();
  });

  it('call hooks keep manifest order whatever the load order, and a failed module stops hooking', () => {
    const cfg = { servers: [], kernel: { modules: 'eager' } } as unknown as GatewayConfig;
    registerCallHook({ id: 'zz-plugin-13' });
    registerCallHook({ id: 'sla' });
    registerCallHook({ id: 'dlp' });
    const ids = activeCallHooks(cfg).map((h) => h.id);
    expect(ids.indexOf('dlp')).toBeLessThan(ids.indexOf('sla'));
    expect(ids.indexOf('sla')).toBeLessThan(ids.indexOf('zz-plugin-13'));
    markRuntimeFailed('dlp', 'test');
    expect(activeCallHooks(cfg).map((h) => h.id)).not.toContain('dlp');
    clearRuntimeFailed('dlp');
    expect(activeCallHooks(cfg).map((h) => h.id)).toContain('dlp');
  });

  it('GET /admin/kernel reports state, dependencies and evaluation on a real gateway', async () => {
    fx = await startFeatureGw({ billing: {} } as never);
    const k = (await fx.admin('kernel')).body;
    expect(k.line).toEqual({ line: '13.x', lts: false });
    const mods = Object.fromEntries(k.modules.map((m: { id: string }) => [m.id, m]));
    expect(mods.billing).toMatchObject({ state: 'active', dependsOn: ['genai-otel'], evaluated: true, active: true });
    expect(k.evaluated).toEqual(expect.arrayContaining(['genai-otel', 'billing', 'kernel']));
    expect(k.evaluated.indexOf('genai-otel')).toBeLessThan(k.evaluated.indexOf('billing'));
    expect((await fx.admin('billing/usage')).status).not.toBe(503);
  });
});
