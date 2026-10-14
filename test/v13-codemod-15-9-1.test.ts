/**
 * `mcp-gateway config migrate --to v13` — added in 15.9.0-canary.1 (then: only the v12-compatible rewrites, the file
 * kept `version: 12`). 16.0.0-alpha.1 reads schema v13, so the codemod now writes it (test/v13-schema-16-0-0.test.ts S7
 * covers the rules); this file keeps the codemod's shape:
 *
 *  C1 `isolation` alias → `runtime` (comments and layout kept; WASM component `isolation` untouched), `version: 13`,
 *     same effective runtime, the result loads as v13 with no deprecations.
 *  C2 inline module plugins get `allowInline: true`; 2024-11-05 is dropped from `mcp.protocolVersions`; Node.js 24 stays pending.
 *  C3 idempotent: a v13 file is checked and left as it is.
 *  C4 refusals: `isolation` and `runtime` disagreeing (the v12 loader already refuses it), v11 files, invalid v13 files; JSON input.
 *  C5 CLI: `--dry-run` writes nothing, `--in-place` keeps `<file>.pre-v13.bak` and the result validates, `config diff --to v13`
 *     exits 3 / 0, `--json`, a second run is a no-op, `--to v14` refused.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'yaml';
import { planV13 } from '../src/config/v13-prep.js';
import { validateConfig } from '../src/config/loader.js';
import { v16DeprecationsIn } from '../src/config/v16-deprecations.js';

/* eslint-disable @typescript-eslint/no-explicit-any */
const ROOT = join(__dirname, '..');
const cli = (...a: string[]) => spawnSync(process.execPath, ['--import', 'tsx', join(ROOT, 'src/cli.ts'), ...a], { cwd: ROOT, encoding: 'utf8', timeout: 60_000, env: { ...process.env, LOG_LEVEL: 'error' } });

const SAMPLE = `# gateway config
version: 12
servers:
  - id: echo
    name: echo
    transport: stdio
    command: node
    args: [echo.mjs]
plugins:
  - module: ./a.mjs   # tenant header
    isolation: worker
  - module: ./b.mjs
    isolation: inline
  - module: ./c.mjs
    runtime: process
  - component: ./w.wasm
    isolation: tenant
mcp:
  protocolVersions: ['2025-06-18', '2024-11-05']
`;

describe('config migrate --to v13 codemod (15.9.0-canary.1; writes v13 since 16.0.0-alpha.1)', () => {
  it('C1 rewrites the module-plugin isolation alias to runtime, keeps comments, writes version: 13 that loads', () => {
    const r = planV13(SAMPLE, 'yaml');
    expect(r.ok).toBe(true);
    expect(r.changes.slice(0, 3)).toEqual(['version: 12 → 13', 'plugins[0].isolation: worker → runtime: worker', 'plugins[1].isolation: inline → runtime: inline']);
    expect(r.text).toContain('# tenant header');
    expect(r.text).toMatch(/^version: 13$/m);
    const out = parse(r.text);
    expect(out.plugins.map((p: any) => p.runtime)).toEqual(['worker', 'inline', 'process', undefined]);
    expect(out.plugins[0].isolation).toBeUndefined();
    expect(out.plugins[3].isolation).toBe('tenant'); // WASM component isolation is a different setting
    const before = validateConfig(parse(SAMPLE)) as any;
    const after = validateConfig(out) as any;
    expect(after.schemaVersion).toBe(13);
    expect(after.plugins.map((p: any) => p.runtime ?? p.isolation)).toEqual(before.plugins.map((p: any) => p.runtime ?? p.isolation));
    expect(r.diff).toMatch(/^-\s+isolation: worker$/m);
    expect(r.diff).toMatch(/^\+\s+runtime: worker$/m);
    expect(after.deprecations).toBeUndefined();
    expect(v16DeprecationsIn(parse(SAMPLE)).length).toBeGreaterThan(0);
  });

  it('C2 opts inline plugins in, drops 2024-11-05, keeps Node.js 24 pending', () => {
    const r = planV13(SAMPLE, 'yaml');
    const out = parse(r.text);
    expect(out.plugins[1]).toEqual({ module: './b.mjs', runtime: 'inline', allowInline: true });
    expect(out.mcp.protocolVersions).toEqual(['2025-06-18']);
    expect(r.pending.map((p) => p.id)).toEqual(['v16.node']);
  });

  it('C3 is idempotent: a v13 file is left as it is', () => {
    const once = planV13(SAMPLE, 'yaml');
    const twice = planV13(once.text, 'yaml');
    expect(twice.ok).toBe(true);
    expect(twice.changes).toEqual([]);
    expect(twice.text).toBe(once.text);
    expect(twice.diff).toBe('');
    const clean = planV13('version: 12\nplugins:\n  - module: ./a.mjs\n    runtime: worker\n', 'yaml');
    expect(clean.changes).toEqual(['version: 12 → 13']);
    expect(clean.pending.map((p) => p.id)).toEqual(['v16.node']);
  });

  it('C4 refuses conflicting isolation / runtime, v11 files and invalid v13 files; JSON input', () => {
    const c = planV13('version: 12\nplugins:\n  - module: ./a.mjs\n    isolation: worker\n    runtime: process\n', 'yaml');
    expect(c.ok).toBe(false);
    expect(c.report.errors.join('\n')).toMatch(/plugins\.0\.runtime.*disagree/); // the v12 loader already refuses it
    const same = planV13('version: 12\nplugins:\n  - module: ./a.mjs\n    isolation: worker\n    runtime: worker\n', 'yaml');
    expect(same.ok).toBe(true);
    expect(same.changes).toContain('plugins[0].isolation: worker (same as runtime) removed');
    expect(planV13('version: 11\n', 'yaml').report.errors.join('\n')).toMatch(/config migrate --to v12/);
    expect(planV13('version: 13\nplugins:\n  - module: ./a.mjs\n    runtime: inline\n', 'yaml').report.errors.join('\n')).toMatch(/allowInline: true/);
    const json = planV13(JSON.stringify({ version: 12, plugins: [{ module: './a.mjs', isolation: 'process' }] }), 'json');
    expect(json.ok).toBe(true);
    expect(JSON.parse(json.text)).toEqual({ version: 13, plugins: [{ module: './a.mjs', runtime: 'process' }] });
  });

  it('C5 CLI: --dry-run writes nothing, --in-place keeps a backup, diff exit codes, --json', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mgw-v13-'));
    const f = join(dir, 'gw.yml');
    writeFileSync(f, SAMPLE);
    const dry = cli('config', 'migrate', '--to', 'v13', '--dry-run', '-c', f);
    expect(dry.status).toBe(0);
    expect(dry.stdout).toMatch(/runtime: worker/);
    expect(dry.stdout).toMatch(/pending \(outside the file\)/);
    expect(readFileSync(f, 'utf8')).toBe(SAMPLE);
    expect(cli('config', 'diff', '--to', 'v13', '-c', f).status).toBe(3);
    const j = JSON.parse(cli('config', 'migrate', '--to', 'v13', '--dry-run', '--json', '-c', f).stdout);
    expect(j.to).toBe(13);
    expect(j.writes).toBe(13);
    expect(j.pending.length).toBe(1);
    const ip = cli('config', 'migrate', '--to', 'v13', '--in-place', '-c', f);
    expect(ip.status).toBe(0);
    expect(readFileSync(`${f}.pre-v13.bak`, 'utf8')).toBe(SAMPLE);
    expect(readFileSync(f, 'utf8')).not.toMatch(/isolation: worker/);
    expect(cli('validate', '-c', f).status).toBe(0);
    expect(cli('config', 'diff', '--to', 'v13', '-c', f).status).toBe(0);
    // a second --in-place has nothing to do and leaves the backup alone
    expect(cli('config', 'migrate', '--to', 'v13', '--in-place', '-c', f).status).toBe(0);
    expect(readFileSync(`${f}.pre-v13.bak`, 'utf8')).toBe(SAMPLE);
    expect(existsSync(join(dir, 'gw.v13.yml'))).toBe(false);
    // other targets are still refused
    expect(cli('config', 'migrate', '--to', 'v14', '-c', f).status).toBe(1);
  }, 120_000);
});
