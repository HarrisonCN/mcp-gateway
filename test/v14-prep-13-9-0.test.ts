/**
 * 13.9.0 "v14 migration preparation": config schema v12 DRAFT, deprecation inventory with runtime warnings, the
 * `mcp-gateway config migrate --to v12 --dry-run` / `config diff` preview, and the remaining 13.4.0 contract findings
 * (F3 instance isolation, F4 genai-otel interval reconfigure, F5 pq-identity final checkpoint).
 * Schema v11 stays the runtime schema: nothing here may change how a v11 file loads.
 */
import { describe, it, expect, afterEach, vi, beforeAll } from 'vitest';
import { readFileSync, readdirSync, statSync, existsSync, mkdtempSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { tmpdir } from 'os';
import { createServer } from 'http';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import { parse as parseYaml, parseAllDocuments } from 'yaml';
import Ajv from 'ajv';
import { validateConfig, validateV11ForMigration } from '../src/config/loader.js';
import { V12_DEPRECATIONS, migrateToV12, downgradeFromV12, unifiedDiff, buildV12ConfigSchema, buildV12ModuleSchema, moduleDeclarationV12 } from '../src/config/v12.js';
import { deprecate, runtimeDeprecations, resetDeprecations } from '../src/utils/deprecations.js';
import { logger } from '../src/utils/logger.js';
import { FEATURE_MANIFEST } from '../src/features/manifest.js';
import { registeredFeature } from '../src/gateway/features.js';
import { loadFeature } from '../src/gateway/kernel-runtime.js';
import { Gateway } from '../src/gateway/index.js';
import type { GatewayConfig } from '../src/utils/types.js';
import { fixture } from './helpers/feature-gw.js';
import { minimalSections } from './helpers/module-contract.js';
import { hybridKeygen } from '../src/security/pq.js';

logger.setLevel('error');
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FIX = join(ROOT, 'test/fixtures/v11-deprecated.yml');
const fixText = readFileSync(FIX, 'utf8');
/* eslint-disable @typescript-eslint/no-explicit-any */
const ajv = new Ajv({ allErrors: true, strict: false });
/** A fresh Ajv per compile (the draft schemas carry fixed `$id`s). */
const compile = (s: object) => new Ajv({ allErrors: true, strict: false }).compile(s);
const readJson = (p: string) => JSON.parse(readFileSync(join(ROOT, p), 'utf8'));

/** Every gateway config shipped in examples/: plain files, the Kubernetes ConfigMap and the Helm values `config:`. */
function exampleConfigs(): Array<{ name: string; text: string }> {
  const out: Array<{ name: string; text: string }> = [];
  const walk = (d: string) => {
    for (const n of readdirSync(d)) {
      const p = join(d, n);
      if (statSync(p).isDirectory()) walk(p);
      else if (/^mcp-gateway\.ya?ml$/.test(n)) {
        const txt = readFileSync(p, 'utf8');
        const docs = parseAllDocuments(txt).map((x) => x.toJS());
        if (docs.length === 1 && (docs[0]?.version === 11 || docs[0]?.version === 12)) out.push({ name: p.slice(ROOT.length + 1), text: txt });
        for (const d2 of docs) {
          const cm = d2?.kind === 'ConfigMap' ? d2.data?.['mcp-gateway.yml'] : undefined;
          if (typeof cm === 'string') out.push({ name: `${p.slice(ROOT.length + 1)} (ConfigMap)`, text: cm });
        }
      }
    }
  };
  walk(join(ROOT, 'examples'));
  const helm = join(ROOT, 'examples/deploy/helm/values.yaml');
  if (existsSync(helm)) {
    const v = parseYaml(readFileSync(helm, 'utf8'));
    if (v?.config && typeof v.config === 'object') out.push({ name: 'examples/deploy/helm/values.yaml (config)', text: JSON.stringify(v.config, null, 2) });
  }
  out.push({ name: 'test/fixtures/v11-deprecated.yml', text: fixText });
  return out;
}

describe('schema v12 draft files', () => {
  it('schema/v12/config.schema.json and module.schema.json compile (JSON Schema draft-07)', () => {
    for (const f of ['schema/v12/config.schema.json', 'schema/v12/module.schema.json']) {
      const s = readJson(f);
      expect(s.$schema).toBe('http://json-schema.org/draft-07/schema#');
      expect(() => compile(s), f).not.toThrow();
    }
  });
  it('config.schema.json is generated from the code (no drift)', () => {
    expect(readJson('schema/v12/config.schema.json')).toEqual(buildV12ConfigSchema());
    expect(readJson('schema/v12/module.schema.json')).toEqual(buildV12ModuleSchema());
  });
  it('schema/v12-draft (13.9 alias path) is removed in 15.0.0', () => {
    expect(existsSync(join(ROOT, 'schema/v12-draft'))).toBe(false);
  });
  it('the design doc and the deprecation inventory doc exist and name every deprecation', () => {
    const design = readFileSync(join(ROOT, 'docs/design/schema-v12.md'), 'utf8');
    const deps = readFileSync(join(ROOT, 'docs/deprecations.md'), 'utf8');
    expect(V12_DEPRECATIONS.length).toBeGreaterThanOrEqual(5);
    for (const d of V12_DEPRECATIONS) {
      expect(deps, d.path).toContain(d.path);
      expect(deps, d.replacement).toContain(d.replacement);
      expect(design, d.path).toContain(d.path);
    }
    for (const w of ['init', 'reconfigure', 'disable', 'dispose', 'health', 'capabilities']) expect(design).toContain(w);
  });
  it('14.0: schema v12 is the runtime schema; a v11 file without v11-only fields has nothing deprecated', () => {
    expect(validateConfig({ version: 12 }).schemaVersion).toBe(12);
    expect(() => validateConfig({ version: 11 })).toThrow(/schema v11 is no longer read by 15\.0\.0/); // 15.0.0
    expect(validateV11ForMigration({ version: 11 }).deprecations).toBeUndefined();
  });
});

describe('deprecation inventory → runtime warnings', () => {
  afterEach(() => {
    resetDeprecations();
    delete process.env.MCP_GATEWAY_SILENCE_DEPRECATIONS;
    vi.restoreAllMocks();
  });
  it('every inventory entry is removed in 15.0.0 (14.0: read via the in-memory migration) and has a replacement', () => {
    for (const d of V12_DEPRECATIONS) {
      expect(d.removedIn).toBe('15.0.0');
      expect(d.since).toBe('13.9.0');
      expect(d.id).toMatch(/^v12\./);
    }
  });
  it('a v11 config using deprecated fields is read by the migration tooling, which lists each one (the gateway refuses it, 15.0.0)', () => {
    expect(() => validateConfig(parseYaml(fixText))).toThrow(/schema v11 is no longer read/);
    const cfg = validateV11ForMigration(parseYaml(fixText));
    const ids = (cfg.deprecations ?? []).map((d) => d.id).sort();
    expect(ids).toEqual(V12_DEPRECATIONS.map((d) => d.id).sort());
    expect(cfg.kernel?.modules).toBe('lazy');
    expect(cfg.genaiTelemetry).toBeDefined();
  });
  it('warned once per field (repeat calls and reloads stay quiet)', () => {
    const warn = vi.spyOn(logger, 'warn');
    const d = V12_DEPRECATIONS[0]!;
    deprecate(d);
    deprecate(d);
    deprecate(V12_DEPRECATIONS[1]!);
    expect(warn.mock.calls.filter((c) => String(c[0]).includes('DEPRECATED')).length).toBe(2);
    expect(runtimeDeprecations().length).toBe(2);
  });
  it('MCP_GATEWAY_SILENCE_DEPRECATIONS silences the log (all, or a list of ids / paths) but keeps the listing', () => {
    const warn = vi.spyOn(logger, 'warn');
    process.env.MCP_GATEWAY_SILENCE_DEPRECATIONS = `${V12_DEPRECATIONS[0]!.id},${V12_DEPRECATIONS[1]!.path}`;
    deprecate(V12_DEPRECATIONS[0]!);
    deprecate(V12_DEPRECATIONS[1]!);
    deprecate(V12_DEPRECATIONS[2]!);
    expect(warn.mock.calls.filter((c) => String(c[0]).includes('DEPRECATED')).length).toBe(1);
    resetDeprecations();
    process.env.MCP_GATEWAY_SILENCE_DEPRECATIONS = 'all';
    for (const d of V12_DEPRECATIONS) deprecate(d);
    expect(warn.mock.calls.filter((c) => String(c[0]).includes('DEPRECATED')).length).toBe(1);
    expect(runtimeDeprecations().length).toBe(V12_DEPRECATIONS.length);
  });
  it('a gateway started (and reloaded) with deprecated fields warns once per field', async () => {
    const warn = vi.spyOn(logger, 'warn');
    const raw = parseYaml(fixText);
    raw.servers = [];
    const cfg = { ...validateV11ForMigration(raw), port: 0 } as GatewayConfig;
    const gw = new Gateway(cfg);
    await gw.start();
    try {
      await gw.reload({ ...validateV11ForMigration(raw), port: 0 } as GatewayConfig);
      const lines = warn.mock.calls.map((c) => String(c[0])).filter((l) => l.includes('DEPRECATED'));
      for (const d of V12_DEPRECATIONS) expect(lines.filter((l) => l.includes(d.path)).length, d.path).toBe(1);
    } finally {
      await gw.stop();
    }
  });
});

describe('migration preview: v11 → v12', () => {
  const schema = () => compile(readJson('schema/v12/config.schema.json'));
  it('round-trips every example config: v12 output validates against the draft, downgrades to the same v11 config', () => {
    const validate = schema();
    const list = exampleConfigs();
    expect(list.length).toBeGreaterThanOrEqual(8);
    for (const { name, text } of list) {
      const before = parseYaml(text);
      expect(() => validateV11ForMigration(before), name).not.toThrow();
      const r = migrateToV12(text);
      if (before.version === 12) {
        // 14.0.0: the examples ship in schema v12 — nothing to migrate, valid against the schema
        expect(r.changes, name).toEqual([]);
        expect(validateConfig(before).schemaVersion, name).toBe(12);
        expect(validate(before), `${name}: ${ajv.errorsText(validate.errors)}`).toBe(true);
        continue;
      }
      expect(r.report.errors, name).toEqual([]);
      expect(r.config.version, name).toBe(12);
      expect(validate(r.config), `${name}: ${ajv.errorsText(validate.errors)}`).toBe(true);
      expect(downgradeFromV12(r.config), name).toEqual(before);
      // migrating the v12 output again is a no-op
      expect(migrateToV12(r.text).changes, name).toEqual([]);
    }
  });
  it('rewrites every deprecated field, keeps comments, reports manual steps', () => {
    const r = migrateToV12(fixText);
    expect(r.ok).toBe(true);
    const c = r.config as any;
    expect(c.version).toBe(12);
    expect(c.kernel).toBeUndefined();
    expect(c.modules).toEqual({ activation: 'lazy', failurePolicy: { billing: 'closed' } });
    expect(c.features.genaiOtel).toEqual({ exportIntervalMs: 15000 });
    expect(c.features.policySim).toEqual({});
    expect(c.features.pqTls).toEqual({});
    expect(c.features.genaiTelemetry).toBeUndefined();
    expect(r.changes.length).toBe(V12_DEPRECATIONS.length + 1);
    expect(r.text).toContain('# OpenTelemetry GenAI export');
    expect(r.report.warnings.some((w) => /draft/i.test(w))).toBe(false); // 14.0.0: v12 is the runtime schema
    expect(r.report.manual.length).toBeGreaterThan(0);
  });
  it('unified diff of the migration', () => {
    const r = migrateToV12(fixText);
    expect(r.diff).toMatch(/^--- .*\n\+\+\+ .*\n@@ -\d+(,\d+)? \+\d+(,\d+)? @@/);
    expect(r.diff).toContain('-version: 11');
    expect(r.diff).toContain('+version: 12');
    expect(r.diff).toContain('-  genaiTelemetry:');
    expect(r.diff).toContain('+  genaiOtel:');
    expect(unifiedDiff('a\nb\n', 'a\nb\n', 'x', 'y')).toBe('');
    expect(unifiedDiff('a\nb\nc\n', 'a\nB\nc\n', 'x', 'y')).toBe('--- x\n+++ y\n@@ -1,3 +1,3 @@\n a\n-b\n+B\n c\n');
  });
  it('compatibility report errors: older schema, conflicting old and new keys, unparsable input', () => {
    expect(migrateToV12('version: 10\nservers: []\n').report.errors[0]).toMatch(/v10.*migrate --to 11/);
    const both = migrateToV12('version: 11\nfeatures:\n  genaiTelemetry: {}\n  genaiOtel: {}\n');
    expect(both.ok).toBe(false);
    expect(both.report.errors.join()).toMatch(/genaiTelemetry.*genaiOtel/);
    expect(migrateToV12('a: [').ok).toBe(false);
    expect(migrateToV12('version: 11\nfeatures:\n  nope: {}\n').report.errors.join()).toMatch(/nope/);
  });
  it('JSON input stays JSON', () => {
    const r = migrateToV12(JSON.stringify(parseYaml(fixText)), 'json');
    expect(JSON.parse(r.text).modules.activation).toBe('lazy');
  });
});

describe('CLI: config migrate / config diff', () => {
  const cli = (...a: string[]) => spawnSync(process.execPath, ['--import', 'tsx', join(ROOT, 'src/cli.ts'), ...a], { cwd: ROOT, encoding: 'utf8', timeout: 60_000, env: { ...process.env, LOG_LEVEL: 'error' } });
  it('config migrate --to v12 --dry-run --json prints config, diff and report; writes nothing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mgw-139-'));
    const f = join(dir, 'gw.yml');
    writeFileSync(f, fixText);
    const r = cli('config', 'migrate', '--to', 'v12', '--dry-run', '--json', '-c', f);
    expect(r.status, r.stderr).toBe(0);
    const j = JSON.parse(r.stdout);
    expect(j.to).toBe(12);
    expect(j.config.modules.activation).toBe('lazy');
    expect(j.diff).toContain('+version: 12');
    expect(j.report.errors).toEqual([]);
    expect(readFileSync(f, 'utf8')).toBe(fixText);
    const human = cli('config', 'migrate', '--to', 'v12', '--dry-run', '-c', f);
    expect(human.status, human.stderr).toBe(0);
    expect(human.stdout).toMatch(/Compatibility report/);
    expect(human.stdout).toContain('modules:');
  }, 120_000);
  it('config diff --to v12 prints a unified diff (exit 3 when it would change)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mgw-139-'));
    const f = join(dir, 'gw.yml');
    writeFileSync(f, fixText);
    const r = cli('config', 'diff', '--to', 'v12', '-c', f);
    expect(r.status).toBe(3);
    expect(r.stdout).toContain('+  genaiOtel:');
    const bad = join(dir, 'bad.yml');
    writeFileSync(bad, 'version: 10\n');
    expect(cli('config', 'migrate', '--to', 'v12', '--dry-run', '-c', bad).status).toBe(1);
  }, 120_000);
});

// ── 13.4.0 findings ───────────────────────────────────────────────────────────────────────────────────────────────
const srv = (id: string) => ({ id, name: id, transport: 'stdio' as const, command: process.execPath, args: [fixture], timeout: 5000 });
const OP = 'contract-operator-key-0123456789abcdef';
const base = () => ({ port: 0, host: '127.0.0.1', logLevel: 'error', monitor: { requestLog: false }, servers: [srv('fake')], auth: { strategy: 'api-key', apiKeys: [OP] } }) as unknown as GatewayConfig;
const hdr = { authorization: `Bearer ${OP}`, 'content-type': 'application/json' };
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
const kernelState = (gw: Gateway, id: string) => (gw as any).featureRouter.modules().find((m: any) => m.id === id);

describe('13.4.0 F4: genai-otel export interval follows a reload', () => {
  it('changing exportIntervalMs reschedules the OTLP export without a restart', async () => {
    let posts = 0;
    const otlp = createServer((req, res) => {
      posts++;
      req.resume();
      req.on('end', () => res.end('{}'));
    });
    await new Promise<void>((r) => otlp.listen(0, '127.0.0.1', () => r()));
    const ep = `http://127.0.0.1:${(otlp.address() as any).port}`;
    try {
      const cfg = { ...base(), genaiTelemetry: { otlpEndpoint: ep, exportIntervalMs: 600_000 } } as unknown as GatewayConfig;
      const gw = await start(cfg);
      await new Promise((r) => setTimeout(r, 300));
      expect(posts).toBe(0);
      await gw.reload({ ...cfg, genaiTelemetry: { otlpEndpoint: ep, exportIntervalMs: 1000 } } as unknown as GatewayConfig);
      await new Promise((r) => setTimeout(r, 1600));
      expect(posts).toBeGreaterThan(0);
    } finally {
      otlp.close();
    }
  }, 20_000);
});

describe('13.4.0 F5: pq-identity signs a final checkpoint when disabled', () => {
  it('removing features.pqIdentity checkpoints the audit chain head', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mgw-pq-'));
    writeFileSync(join(dir, 'gw.hybrid.json'), JSON.stringify(hybridKeygen().privateKey));
    const cfg = { ...base(), configDir: dir, pqIdentity: { keyFile: 'gw.hybrid.json', keyId: 'gw-test', auditLog: { dir: join(dir, 'audit'), checkpointEvery: 1000, checkpointSeconds: 86_400 } } } as unknown as GatewayConfig;
    const gw = await start(cfg);
    const url = `http://127.0.0.1:${gw.address()!.port}`;
    const r = await fetch(`${url}/api/v1/tools/call`, { method: 'POST', headers: hdr, body: JSON.stringify({ server: 'fake', tool: 'echo', arguments: { text: 'hi' } }) });
    expect(r.status).toBe(200);
    await new Promise((res) => setTimeout(res, 100));
    const { pqIdentity: _p, ...without } = cfg as any;
    await gw.reload(without as GatewayConfig);
    await new Promise((res) => setTimeout(res, 100));
    const files = readdirSync(join(dir, 'audit'));
    const lines = files.flatMap((f) => readFileSync(join(dir, 'audit', f), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)));
    const entries = lines.filter((l) => l.type !== 'checkpoint');
    const cps = lines.filter((l) => l.type === 'checkpoint');
    expect(entries.length).toBeGreaterThan(0);
    expect(cps.at(-1)?.seq, 'final checkpoint covers the chain head').toBe(entries.at(-1)?.seq);
  }, 20_000);
});

describe('13.4.0 F3 / C7: instance isolation and v12 module declarations (all 46 modules)', () => {
  const { sections } = minimalSections();
  beforeAll(async () => {
    for (const e of FEATURE_MANIFEST) expect(await loadFeature(e.id), e.id).toBe(true);
  }, 60_000);
  it('every module has a v12 declaration (lifecycle, capabilities, failure policy) valid against module.schema.json', () => {
    const validate = compile(readJson('schema/v12/module.schema.json'));
    expect(FEATURE_MANIFEST.length).toBe(46);
    for (const e of FEATURE_MANIFEST) {
      const d = moduleDeclarationV12(e, registeredFeature(e.id)) as any;
      expect(validate(d), `${e.id}: ${ajv.errorsText(validate.errors)}`).toBe(true);
      expect(d.id).toBe(e.id);
      expect(d.lifecycle.mount).toBe(true);
      if (e.hook) expect(d.capabilities).toContain('call-hook');
      if (e.guard) {
        expect(d.capabilities).toContain('security-guard');
        expect(d.failurePolicy).toEqual({ default: 'closed', configurable: false });
      }
      for (const k of e.activation ?? []) expect(d.configSections).toContain(k === 'genaiTelemetry' ? 'genaiOtel' : k === 'postQuantumTls' ? 'pqTls' : k);
    }
  });
  for (const e of FEATURE_MANIFEST) {
    it(`F3 ${e.id}: stopping one gateway instance leaves the other's module active and reloadable`, async () => {
      const cfg = { ...base(), ...sections[e.id] } as unknown as GatewayConfig;
      const a = await start(cfg);
      const b = await start(cfg);
      // always-available modules (no activating section) stay 'available' until first use
      const want = kernelState(a, e.id)?.state;
      expect(['active', 'available']).toContain(want);
      expect(kernelState(b, e.id)?.state).toBe(want);
      await a.stop();
      running.splice(running.indexOf(a), 1);
      expect(kernelState(b, e.id)?.state, 'after the other instance stopped').toBe(want);
      await b.reload({ ...cfg, monitor: { requestLog: false, historySize: 50 } } as GatewayConfig);
      expect(kernelState(b, e.id)?.state, 'after a reload').toBe(want);
      const r = await fetch(`http://127.0.0.1:${b.address()!.port}/api/v1/admin/kernel`, { headers: hdr });
      expect(r.status).toBe(200);
    }, 30_000);
  }
});
