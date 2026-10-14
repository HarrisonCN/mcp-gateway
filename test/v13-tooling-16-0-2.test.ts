/**
 * 16.0.0-alpha.2 (development prerelease; the 16.0 list is a proposal until 16.0.0-rc.1, docs/v16/freeze.md):
 *
 *  J1 schema/v13/config.schema.json is committed, compiles (draft-07), is generated from the code
 *     (`buildV13ConfigSchema`, no drift) and is shipped (package.json `files` has `schema`).
 *  J2 the JSON Schema states the v13 rules: `version: 13`; module plugins take `runtime` only (component `isolation`
 *     stays); `runtime: inline` needs `allowInline: true`; `allowInline` only on inline module plugins; no 2024-11-05
 *     in `mcp.protocolVersions`.
 *  J3 the loader and the JSON Schema agree on those cases (accept ⇔ valid).
 *  J4 docs-check: a `version: 13` config fence is validated (loader + schema v13); a broken one is a finding; every
 *     current v12 / unversioned config must also be valid in its v13 form (codemod output against schema/v13), so the
 *     docs switch at 16.0 GA is mechanical.
 *  J5 `config rollback` undoes `config migrate --to v13 --in-place` (restores <file>.pre-v13.bak, keeps the v13 file
 *     as <file>.v13.bak); with both a v11 and a pre-v13 backup it asks for `--to`; `--to v12` / `--to v11` pick one.
 *  J6 decision (alpha.2, replaces the alpha.1 "revisit"): an unversioned file stays schema v12 in 16.x and gets no
 *     `schema.v12` notice, but every 16.0 removal in it is still reported (v16.* deprecations) — 17.0.0 reads an
 *     unversioned file as v13, so those notices are the 16.x warning for it.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'yaml';
import Ajv from 'ajv';
import { validateConfig } from '../src/config/loader.js';
import { buildV13ConfigSchema } from '../src/config/v13-schema.js';
import { runDocsCheck } from '../scripts/docs-check.js';

/* eslint-disable @typescript-eslint/no-explicit-any */
const ROOT = join(__dirname, '..');
const readJson = (p: string) => JSON.parse(readFileSync(join(ROOT, p), 'utf8'));
const compile = (s: object) => new Ajv({ allErrors: true, strict: false }).compile(s);
const cli = (...a: string[]) => spawnSync(process.execPath, ['--import', 'tsx', join(ROOT, 'src/cli.ts'), ...a], { cwd: ROOT, encoding: 'utf8', timeout: 60_000, env: { ...process.env, LOG_LEVEL: 'error' } });
const loads = (raw: unknown) => {
  try {
    validateConfig(raw);
    return true;
  } catch {
    return false;
  }
};
const ids = (c: any): string[] => (c.deprecations ?? []).map((d: any) => d.id).sort();

const CASES: Array<{ name: string; raw: Record<string, unknown>; ok: boolean }> = [
  { name: 'empty v13', raw: { version: 13 }, ok: true },
  { name: 'worker module', raw: { version: 13, plugins: [{ module: './a.mjs', runtime: 'worker' }] }, ok: true },
  { name: 'inline + allowInline', raw: { version: 13, plugins: [{ module: './a.mjs', runtime: 'inline', allowInline: true }] }, ok: true },
  { name: 'component isolation', raw: { version: 13, plugins: [{ component: './w.wasm', isolation: 'tenant' }] }, ok: true },
  { name: 'protocolVersions without 2024-11-05', raw: { version: 13, mcp: { protocolVersions: ['2025-06-18'] } }, ok: true },
  { name: 'module isolation alias', raw: { version: 13, plugins: [{ module: './a.mjs', isolation: 'worker' }] }, ok: false },
  { name: 'inline without allowInline', raw: { version: 13, plugins: [{ module: './a.mjs', runtime: 'inline' }] }, ok: false },
  { name: 'allowInline on a worker', raw: { version: 13, plugins: [{ module: './a.mjs', runtime: 'worker', allowInline: true }] }, ok: false },
  { name: 'allowInline on a component', raw: { version: 13, plugins: [{ component: './w.wasm', allowInline: true }] }, ok: false },
  { name: '2024-11-05 named', raw: { version: 13, mcp: { protocolVersions: ['2025-06-18', '2024-11-05'] } }, ok: false },
];

describe('config schema v13 tooling (16.0.0-alpha.2)', () => {
  it('J1 schema/v13/config.schema.json is generated, compiles and ships', () => {
    const s = readJson('schema/v13/config.schema.json');
    expect(s.$schema).toBe('http://json-schema.org/draft-07/schema#');
    expect(s.$id).toMatch(/\/schema\/v13\/config\.schema\.json$/);
    expect(s.properties.version).toEqual({ const: 13 });
    expect(() => compile(s)).not.toThrow();
    expect(s).toEqual(buildV13ConfigSchema());
    expect(readJson('package.json').files).toContain('schema');
    const gen = spawnSync(process.execPath, ['--import', 'tsx', join(ROOT, 'scripts/gen-schema-v13.ts'), '--check'], { cwd: ROOT, encoding: 'utf8', timeout: 60_000 });
    expect(gen.status, gen.stderr).toBe(0);
  });

  it('J2 the JSON Schema states the v13 rules', () => {
    const v = compile(buildV13ConfigSchema());
    for (const c of CASES) expect(v(c.raw), `${c.name}: ${JSON.stringify(v.errors)}`).toBe(c.ok);
    expect(v({ version: 12 })).toBe(false);
  });

  it('J3 loader and JSON Schema agree on the v13 rule cases', () => {
    const v = compile(buildV13ConfigSchema());
    for (const c of CASES) expect([c.name, loads(c.raw)]).toEqual([c.name, v(c.raw) as boolean]);
  });

  it('J4 docs-check validates version: 13 fences and the v13 form of every current config', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mgw-dc13-'));
    for (const f of ['package.json', 'package-lock.json', 'scripts/docs-check.json', 'src/cli.ts', 'README.md']) {
      mkdirSync(join(dir, f, '..'), { recursive: true });
      cpSync(join(ROOT, f), join(dir, f));
    }
    mkdirSync(join(dir, 'docs'), { recursive: true });
    const fence = (y: string) => '```yaml\n' + y + '```\n';
    writeFileSync(join(dir, 'docs/good13.md'), '# ok\n\n' + fence('version: 13\nplugins:\n  - module: ./a.mjs\n    runtime: inline\n    allowInline: true\n'));
    writeFileSync(join(dir, 'docs/bad13.md'), '# bad\n\n' + fence('version: 13\nplugins:\n  - module: ./a.mjs\n    runtime: inline\n'));
    writeFileSync(join(dir, 'docs/v12.md'), '# v12\n\n' + fence('version: 12\nplugins:\n  - module: ./a.mjs\n    runtime: worker\n'));
    const { findings, stats } = await runDocsCheck(dir);
    const cfg = findings.filter((f) => f.rule === 'config');
    expect(cfg.filter((f) => f.file === 'docs/good13.md')).toEqual([]);
    expect(cfg.filter((f) => f.file === 'docs/v12.md')).toEqual([]);
    expect(cfg.find((f) => f.file === 'docs/bad13.md')?.message).toMatch(/allowInline/);
    // good13 + v12 are checked in their v13 form; bad13 already fails the loader
    expect(stats.v13Checked).toBeGreaterThanOrEqual(2);
  });

  it('J5 config rollback undoes config migrate --to v13 --in-place', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mgw-rb13-'));
    const p = join(dir, 'gw.yml');
    const v12 = 'version: 12\nplugins:\n  - module: ./a.mjs\n    isolation: worker\n';
    writeFileSync(p, v12);
    const m = cli('config', 'migrate', '--to', 'v13', '--in-place', '-c', p);
    expect(m.status, m.stderr).toBe(0);
    expect(m.stdout).toMatch(/config rollback/);
    expect(parse(readFileSync(p, 'utf8')).version).toBe(13);
    const r = cli('config', 'rollback', '-c', p);
    expect(r.status, r.stderr).toBe(0);
    expect(readFileSync(p, 'utf8')).toBe(v12);
    expect(parse(readFileSync(`${p}.v13.bak`, 'utf8')).version).toBe(13);
    // both backups → ambiguous without --to
    writeFileSync(`${p}.v11.bak`, 'version: 11\n');
    writeFileSync(`${p}.pre-v13.bak`, v12);
    writeFileSync(p, readFileSync(`${p}.v13.bak`));
    const amb = cli('config', 'rollback', '-c', p);
    expect(amb.status).not.toBe(0);
    expect(amb.stderr + amb.stdout).toMatch(/--to v12.*--to v11|--to v11.*--to v12/s);
    expect(cli('config', 'rollback', '--to', 'v12', '-c', p).status).toBe(0);
    expect(readFileSync(p, 'utf8')).toBe(v12);
    expect(cli('config', 'rollback', '--to', 'v11', '-c', p).status).toBe(0);
    expect(readFileSync(p, 'utf8')).toBe('version: 11\n');
    expect(existsSync(`${p}.v12.bak`)).toBe(true);
    expect(cli('config', 'rollback', '--to', 'v9', '-c', p).status).not.toBe(0);
  }, 120_000);

  it('J6 an unversioned file stays v12 without schema.v12, but its 16.0 removals are reported', () => {
    const plain = validateConfig({}) as any;
    expect(plain.schemaVersion ?? 12).toBe(12);
    expect(ids(plain)).toEqual([]);
    const c = validateConfig({ plugins: [{ module: './a.mjs', isolation: 'worker' }] }) as any;
    expect(ids(c)).not.toContain('schema.v12');
    expect(ids(c).some((x) => x.startsWith('v16.'))).toBe(true);
  });
});
