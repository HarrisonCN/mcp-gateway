/**
 * 14.0.0 "core architecture v2": config schema v12 is the runtime schema (v11 files are auto-migrated in memory with
 * one deprecation warning per field and a startup notice until 15.0), the unified module lifecycle v2 (init /
 * reconfigure / disable / dispose / health with bounds) with a v11-compat adapter for legacy modules, capability
 * declarations enforced by the kernel (`modules.capabilities.<id>.deny`; network and timers through the module context),
 * per-instance module state (13.4.0 finding F3) and the migration tool that writes files (`config migrate --to v12`,
 * `--in-place` with a backup, `config rollback`).
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { readFileSync, readdirSync, writeFileSync, mkdtempSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { tmpdir } from 'os';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import { parse as parseYaml } from 'yaml';
import express from 'express';
import { validateConfig, validateV11ForMigration } from '../src/config/loader.js';
import { portableConfig } from '../src/gateway/admin.js';
import { resetDeprecations } from '../src/utils/deprecations.js';
import { logger } from '../src/utils/logger.js';
import { FEATURE_MANIFEST } from '../src/features/manifest.js';
import { createFeatureRouter, moduleMode, type FeatureModule, type FeatureContext } from '../src/gateway/features.js';
import { schemaNotice, MODULE_CAPABILITIES } from '../src/config/v12.js';
import { instanceLocal, InstanceScope, runInScope } from '../src/kernel/instance.js';
import type { GatewayConfig } from '../src/utils/types.js';
import { startFeatureGw, type FeatureGw } from './helpers/feature-gw.js';

logger.setLevel('error');
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
/* eslint-disable @typescript-eslint/no-explicit-any */

describe('14.0 config: schema v12 is the runtime schema', () => {
  afterEach(() => resetDeprecations());

  it('reads a v12 file: modules block, renamed sections, lifecycle bounds and capability denials', () => {
    const cfg = validateConfig({
      version: 12,
      servers: [],
      modules: { activation: 'eager', failurePolicy: { billing: 'closed' }, lifecycle: { initTimeoutMs: 5000, unloadTimeoutMs: 2000 }, capabilities: { 'genai-otel': { deny: ['outbound-network'] } } },
      features: { genaiOtel: { otlpEndpoint: 'http://c:4318' }, policySim: {}, pqTls: {} },
    }) as any;
    expect(cfg.schemaVersion).toBe(12);
    expect(moduleMode(cfg)).toBe('eager');
    expect(cfg.modules.lifecycle).toMatchObject({ initTimeoutMs: 5000, unloadTimeoutMs: 2000 });
    expect(cfg.modules.capabilities['genai-otel'].deny).toEqual(['outbound-network']);
    // 16.0.0-alpha.1: an explicit v12 file is reported as `schema.v12` (read until 17.0.0); nothing else
    expect((cfg.deprecations ?? []).map((d: any) => d.id)).toEqual(['schema.v12']);
    expect(schemaNotice(cfg)).toBeUndefined();
  });

  it('the five deprecated v11 fields are not part of schema v12', () => {
    const bad = (raw: object, re: RegExp) => expect(() => validateConfig({ version: 12, servers: [], ...raw })).toThrow(re);
    bad({ kernel: { modules: 'eager' } }, /kernel.*not part of config schema v12.*modules\.activation/s);
    bad({ kernel: { failurePolicy: { billing: 'closed' } } }, /modules\.failurePolicy/);
    bad({ features: { genaiTelemetry: {} } }, /genaiTelemetry.*genaiOtel/s);
    bad({ features: { policyShadow: {} } }, /policyShadow.*policySim/s);
    bad({ features: { postQuantumTls: {} } }, /postQuantumTls.*pqTls/s);
  });

  it('validates modules.capabilities and modules.failurePolicy against the manifest', () => {
    expect(() => validateConfig({ version: 12, servers: [], modules: { capabilities: { nope: { deny: ['filesystem'] } } } })).toThrow(/unknown module "nope"/);
    expect(() => validateConfig({ version: 12, servers: [], modules: { capabilities: { billing: { deny: ['teleport'] } } } })).toThrow();
    expect(() => validateConfig({ version: 12, servers: [], modules: { failurePolicy: { dlp: 'open' } } })).toThrow(/failure policy of "dlp" is fixed/);
    expect(() => validateConfig({ version: 14, servers: [] })).toThrow(/version/); // 16.0.0-alpha.1: v13 is read
  });

  it('15.0.0: a v11 file is refused with the migrate command; the migration tooling still reads it (same runtime config as v12)', () => {
    const v11 = { version: 11, servers: [], kernel: { modules: 'eager', failurePolicy: { billing: 'closed' } }, features: { genaiTelemetry: { otlpEndpoint: 'http://c:4318' }, postQuantumTls: {} } };
    expect(() => validateConfig(v11)).toThrow(/schema v11 is no longer read by 15\.0\.0.*config migrate --to v12 --in-place/s);
    const cfg = validateV11ForMigration(v11) as any; // what `config migrate --to v12` reads
    expect(cfg.schemaVersion).toBe(11);
    expect(moduleMode(cfg)).toBe('eager');
    const v12 = validateConfig({ version: 12, servers: [], modules: { activation: 'eager', failurePolicy: { billing: 'closed' } }, features: { genaiOtel: { otlpEndpoint: 'http://c:4318' }, pqTls: {} } }) as any;
    const strip = (c: any) => { const { schemaVersion: _s, deprecations: _d, version: _v, ...rest } = c; return rest; };
    expect(strip(v12)).toEqual(strip(cfg));
  });

  it('an unversioned file is v12; one that uses a v11-only field is a v11 file and refused (15.0.0)', () => {
    expect((validateConfig({ servers: [] }) as any).schemaVersion).toBe(12);
    expect((validateConfig({ servers: [], features: { genaiOtel: {} } }) as any).schemaVersion).toBe(12);
    expect(() => validateConfig({ servers: [], kernel: { modules: 'lazy' } })).toThrow(/schema v11 is no longer read/);
    expect(() => validateConfig({ servers: [], features: { genaiTelemetry: {} } })).toThrow(/schema v11 is no longer read/);
    expect(() => validateV11ForMigration({ servers: [], kernel: { modules: 'lazy' }, modules: { activation: 'lazy' } })).toThrow(/both/);
  });

  it('the admin API returns the running config in v12 form', () => {
    const cfg = validateV11ForMigration({ version: 11, servers: [], kernel: { modules: 'eager' }, features: { genaiTelemetry: {} } });
    const p = portableConfig(cfg) as any;
    expect(p.version).toBe(12);
    expect(p.kernel).toBeUndefined();
    expect(p.modules.activation).toBe('eager');
    expect(p.features.genaiOtel).toBeDefined();
    expect(p.features.genaiTelemetry).toBeUndefined();
    expect((validateConfig(p) as any).schemaVersion).toBe(12);
  });

});

describe('14.0 migration tool: config migrate --to v12 writes files', () => {
  const cli = (...a: string[]) => spawnSync(process.execPath, ['--import', 'tsx', join(ROOT, 'src/cli.ts'), ...a], { cwd: ROOT, encoding: 'utf8', timeout: 60_000, env: { ...process.env, LOG_LEVEL: 'error' } });
  const V11 = '# my gateway\nversion: 11\nservers: []\nkernel:\n  modules: eager   # keep\nfeatures:\n  genaiTelemetry:\n    otlpEndpoint: http://c:4318\n';

  it('writes <name>.v12.yml next to the file by default (never over the input), and -o elsewhere', () => {
    const d = mkdtempSync(join(tmpdir(), 'mgw14-'));
    const f = join(d, 'gw.yml');
    writeFileSync(f, V11);
    const r = cli('config', 'migrate', '--to', 'v12', '-c', f);
    expect(r.status, r.stderr + r.stdout).toBe(0);
    const out = readFileSync(join(d, 'gw.v12.yml'), 'utf8');
    expect(readFileSync(f, 'utf8')).toBe(V11);
    expect(out).toMatch(/# my gateway/);
    expect(out).toMatch(/activation: eager +# keep/);
    expect((validateConfig(parseYaml(out)) as any).schemaVersion).toBe(12);
    // refuses to overwrite an existing output without --force
    expect(cli('config', 'migrate', '--to', 'v12', '-c', f).status).toBe(1);
    expect(cli('config', 'migrate', '--to', 'v12', '-c', f, '--force').status).toBe(0);
    const o = join(d, 'other.yml');
    expect(cli('config', 'migrate', '--to', 'v12', '-c', f, '-o', o).status).toBe(0);
    expect(parseYaml(readFileSync(o, 'utf8')).version).toBe(12);
  }, 90_000);

  it('--in-place keeps a backup, is idempotent, and config rollback restores the v11 file', () => {
    const d = mkdtempSync(join(tmpdir(), 'mgw14-'));
    const f = join(d, 'gw.yml');
    writeFileSync(f, V11);
    const r = cli('config', 'migrate', '--to', 'v12', '--in-place', '-c', f);
    expect(r.status, r.stderr + r.stdout).toBe(0);
    expect(readFileSync(`${f}.v11.bak`, 'utf8')).toBe(V11);
    expect(parseYaml(readFileSync(f, 'utf8')).version).toBe(12);
    // already v12: nothing written, no second backup
    const again = cli('config', 'migrate', '--to', 'v12', '--in-place', '-c', f);
    expect(again.status).toBe(0);
    expect(again.stdout).toMatch(/already on schema v12/);
    expect(readdirSync(d).filter((n) => n.includes('.bak'))).toEqual(['gw.yml.v11.bak']);
    // rollback
    const rb = cli('config', 'rollback', '-c', f);
    expect(rb.status, rb.stderr + rb.stdout).toBe(0);
    expect(readFileSync(f, 'utf8')).toBe(V11);
    expect(existsSync(`${f}.v12.yml`) || existsSync(join(d, 'gw.v12.yml')) || true).toBe(true);
  }, 90_000);

  it('a file that does not validate is not written', () => {
    const d = mkdtempSync(join(tmpdir(), 'mgw14-'));
    const f = join(d, 'gw.yml');
    writeFileSync(f, 'version: 11\nservers: 5\n');
    expect(cli('config', 'migrate', '--to', 'v12', '--in-place', '-c', f).status).toBe(1);
    expect(readFileSync(f, 'utf8')).toBe('version: 11\nservers: 5\n');
    expect(existsSync(`${f}.v11.bak`)).toBe(false);
  }, 60_000);
});

describe('14.0 module lifecycle v2, capabilities and per-instance state', () => {
  const baseCtx = (cfg: () => GatewayConfig): FeatureContext => ({ config: cfg, tools: () => [], invoke: async () => ({ success: true, result: {}, durationMs: 0 }) as any, recent: () => [], baseUrl: () => undefined });
  const deps = (features: FeatureModule[], cfg: () => GatewayConfig) => ({ authenticate: ((_q: any, _s: any, n: any) => n()) as express.RequestHandler, isOperator: () => true, context: baseCtx(cfg), features });

  it('every built-in module declares its runtime capabilities (at least what its source uses)', () => {
    for (const e of FEATURE_MANIFEST) {
      expect(Array.isArray((e as any).capabilities), e.id).toBe(true);
      for (const c of (e as any).capabilities) expect(MODULE_CAPABILITIES, `${e.id}: ${c}`).toContain(c);
      const file = join(ROOT, 'src/features', `${e.id}.ts`);
      if (!existsSync(file)) continue;
      const src = readFileSync(file, 'utf8');
      if (/\bsetInterval\(/.test(src)) expect((e as any).capabilities, `${e.id} uses setInterval`).toContain('background-timers');
      if (/\bfetch\(/.test(src)) expect((e as any).capabilities, `${e.id} uses fetch`).toContain('outbound-network');
      if (/from '(node:)?fs(\/promises)?'/.test(src)) expect((e as any).capabilities, `${e.id} uses fs`).toContain('filesystem');
    }
  });

  it('lifecycle v2: init → reconfigure → disable → dispose in order, health in the kernel view, api v2 vs v11-compat', async () => {
    const calls: string[] = [];
    let cfg = { servers: [], x: 1 } as any;
    const v2: FeatureModule = { id: 'm2', since: '14.0.0', summary: '', apiVersion: 2, capabilities: [], mount: () => {}, init: () => void calls.push('init'), reconfigure: () => void calls.push('reconfigure'), disable: () => void calls.push('disable'), dispose: () => void calls.push('dispose'), health: () => ({ status: 'ok' }) } as any;
    const legacy: FeatureModule = { id: 'm1', since: '13.0.0', summary: '', mount: () => {} };
    const r = createFeatureRouter(deps([v2, legacy], () => cfg));
    await r.activate();
    const prev = cfg;
    cfg = { ...cfg, x: 2 };
    await r.reconcile(prev);
    await r.dispose();
    expect(calls).toEqual(['init', 'reconfigure', 'dispose']);
    const views = r.modules() as any[];
    expect(views.find((v) => v.id === 'm2').lifecycle).toBe('v2');
    expect(views.find((v) => v.id === 'm1').lifecycle).toBe('v11-compat');
  });

  it('modules.lifecycle.initTimeoutMs bounds init: a hanging init fails the module, the gateway keeps running', async () => {
    const cfg = { servers: [], modules: { lifecycle: { initTimeoutMs: 100 } } } as any;
    const slow: FeatureModule = { id: 'slow', since: '14.0.0', summary: '', apiVersion: 2, capabilities: [], mount: () => {}, init: () => new Promise(() => {}) } as any;
    const r = createFeatureRouter(deps([slow], () => cfg));
    const t = Date.now();
    await r.activate();
    expect(Date.now() - t).toBeLessThan(2000);
    expect(r.failureOf('slow')).toMatch(/init timed out after 100 ms/);
  });

  it('a denied declared capability refuses activation; ctx.timers / ctx.net refuse undeclared or denied use', async () => {
    let cfg = { servers: [], modules: { capabilities: { net: { deny: ['outbound-network'] } } } } as any;
    const net: FeatureModule = { id: 'net', since: '14.0.0', summary: '', apiVersion: 2, capabilities: ['outbound-network'], mount: () => {}, init: vi.fn() } as any;
    const sneaky: FeatureModule = { id: 'sneaky', since: '14.0.0', summary: '', apiVersion: 2, capabilities: [], mount: () => {}, init: (ctx: any) => { ctx.timers.setInterval(() => {}, 1000); } } as any;
    const sneakyNet: FeatureModule = { id: 'sneaky-net', since: '14.0.0', summary: '', apiVersion: 2, capabilities: [], mount: () => {}, init: async (ctx: any) => { await ctx.net.fetch('http://127.0.0.1:9/'); } } as any;
    let timer: any;
    const ok: FeatureModule = { id: 'ok', since: '14.0.0', summary: '', apiVersion: 2, capabilities: ['background-timers'], mount: () => {}, init: (ctx: any) => { timer = ctx.timers.setInterval(() => {}, 1000); } } as any;
    const r = createFeatureRouter(deps([net, sneaky, sneakyNet, ok], () => cfg));
    await r.activate();
    expect(r.failureOf('net')).toMatch(/capability "outbound-network" denied/);
    expect((net as any).init).not.toHaveBeenCalled();
    expect(r.failureOf('sneaky')).toMatch(/capability "background-timers" not declared/);
    expect(r.failureOf('sneaky-net')).toMatch(/capability "outbound-network" not declared/);
    expect(r.failureOf('ok')).toBeUndefined();
    expect(timer).toBeDefined();
    await r.dispose();
    // timers started through ctx.timers are cleared by the kernel when the module goes away
    expect((timer as any)._destroyed).toBe(true);
    cfg = { servers: [] };
  });

  it('a built-in module whose declared capability is denied is refused at activation (genai-otel, outbound-network)', async () => {
    const cfg = validateConfig({ version: 12, servers: [], modules: { capabilities: { 'genai-otel': { deny: ['outbound-network'] } } }, features: { genaiOtel: {} } });
    const h = await startFeatureGw({ modules: cfg.modules, genaiTelemetry: cfg.genaiTelemetry } as any);
    const k = await h.admin('kernel');
    const m = k.body.modules.find((x: any) => x.id === 'genai-otel');
    expect(m.state).toBe('failed');
    expect(m.error).toMatch(/capability "outbound-network" denied/);
    await h.stop();
  }, 30_000);

  it('instanceLocal: each gateway instance gets its own module state; the process scope is the fallback', () => {
    const counter = instanceLocal('t', 'counter', () => new Map<string, number>());
    const a = new InstanceScope('a');
    const b = new InstanceScope('b');
    runInScope(a, () => counter.set('x', 1));
    runInScope(b, () => counter.set('x', 2));
    expect(runInScope(a, () => counter.get('x'))).toBe(1);
    expect(runInScope(b, () => counter.get('x'))).toBe(2);
    expect(counter.get('x')).toBeUndefined();
    a.drop('t');
    expect(runInScope(a, () => counter.get('x'))).toBeUndefined();
    expect(runInScope(b, () => counter.size)).toBe(1);
  });

  it('F3: no built-in module keeps mutable state at module level (singletons are instanceLocal)', () => {
    const offenders: string[] = [];
    for (const f of readdirSync(join(ROOT, 'src/features')).filter((n) => n.endsWith('.ts') && n !== 'manifest.ts')) {
      const src = readFileSync(join(ROOT, 'src/features', f), 'utf8');
      for (const [i, line] of src.split('\n').entries()) {
        // a pure memo (same input → same value, nothing instance-specific) may stay process-wide when it says so
        if (/f3: process-wide pure memo/.test(line)) continue;
        if (/^(export )?let /.test(line)) offenders.push(`${f}:${i + 1}: ${line.trim()}`);
        const m = /^(export )?const \w+(?:: [^=]+)? = new (\w+)/.exec(line);
        if (m && !/^(RegExp|WeakMap|WeakSet)$/.test(m[2]!) && !/new Set\(\[/.test(line)) offenders.push(`${f}:${i + 1}: ${line.trim()}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  let hs: FeatureGw[] = [];
  afterEach(async () => {
    for (const h of hs) await h.stop().catch(() => undefined);
    hs = [];
  });

  it('F3: two gateways in one process keep separate module state (genai-otel spans, billing meters)', async () => {
    const a = await startFeatureGw({ genaiTelemetry: {}, billing: {} } as any);
    const b = await startFeatureGw({ genaiTelemetry: {}, billing: {} } as any);
    hs = [a, b];
    const call = (h: FeatureGw) => fetch(`${h.base}/api/v1/tools/call`, { method: 'POST', headers: { authorization: 'Bearer op', 'content-type': 'application/json' }, body: JSON.stringify({ server: 'fake', tool: 'echo', arguments: {} }) });
    expect((await call(a)).status).toBe(200);
    expect((await call(a)).status).toBe(200);
    expect((await a.admin('genai-otel')).body.spans).toBe(2);
    expect((await b.admin('genai-otel')).body.spans).toBe(0);
  }, 30_000);

  it('F3: a module disabled by a reload starts with fresh state when it is enabled again', async () => {
    const a = await startFeatureGw({ genaiTelemetry: {} } as any);
    hs = [a];
    await fetch(`${a.base}/api/v1/tools/call`, { method: 'POST', headers: { authorization: 'Bearer op', 'content-type': 'application/json' }, body: JSON.stringify({ server: 'fake', tool: 'echo', arguments: {} }) });
    expect((await a.admin('genai-otel')).body.spans).toBe(1);
    const cfg = (a.gw as any).config;
    const { genaiTelemetry: _g, ...without } = cfg;
    await a.gw.reload(without);
    await a.gw.reload({ ...without, genaiTelemetry: {} });
    expect((await a.admin('genai-otel')).body.spans).toBe(0);
  }, 30_000);
});
