/**
 * 15.9.0-canary.1 (v16 preparation): `mcp-gateway config migrate --to v13` — the codemod for the 16.0 config changes
 * (docs/migrating-to-v16.md; proposal). Config schema v13 itself lands in 16.0.0-alpha.1, so on 15.9 the codemod:
 *
 *  C1 applies only the rewrites that stay schema-v12-valid and mean the same thing on 15.x: `isolation: worker|process|inline`
 *     on a module plugin → `runtime:` (comments and layout kept; WASM component `isolation` untouched). The file stays `version: 12`.
 *  C2 reports the v13-only changes it cannot apply on 15.x as `pending` (inline module plugins need the per-plugin
 *     `allowInline: true` opt-in in v13; `mcp.protocolVersions` 2024-11-05 must go; Node.js 24) — never written.
 *  C3 is idempotent: its output plans no further change, and a clean file is reported as such.
 *  C4 refuses what it cannot rewrite safely: `isolation` and `runtime` disagreeing, a non-v12 file.
 *  C5 CLI: `config migrate --to v13 --dry-run` prints the diff and the plan, writes nothing; `--in-place` rewrites the
 *     file after a `<file>.pre-v13.bak` backup and the result loads; `config diff --to v13` exits 3 / 0; `--json`.
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

describe('config migrate --to v13 codemod (15.9.0-canary.1)', () => {
  it('C1 rewrites the module-plugin isolation alias to runtime, keeps comments, stays v12-valid and equivalent', () => {
    const r = planV13(SAMPLE, 'yaml');
    expect(r.ok).toBe(true);
    expect(r.changes).toEqual(['plugins[0].isolation: worker → runtime: worker', 'plugins[1].isolation: inline → runtime: inline']);
    expect(r.text).toContain('# tenant header');
    expect(r.text).toMatch(/^version: 12$/m);
    const out = parse(r.text);
    expect(out.plugins.map((p: any) => p.runtime)).toEqual(['worker', 'inline', 'process', undefined]);
    expect(out.plugins[0].isolation).toBeUndefined();
    expect(out.plugins[3].isolation).toBe('tenant'); // WASM component isolation is a different setting
    const before = validateConfig(parse(SAMPLE)) as any;
    const after = validateConfig(out) as any;
    expect(after.schemaVersion).toBe(12);
    expect(after.plugins.map((p: any) => p.runtime ?? p.isolation)).toEqual(before.plugins.map((p: any) => p.runtime ?? p.isolation));
    expect(r.diff).toMatch(/^-\s+isolation: worker$/m);
    expect(r.diff).toMatch(/^\+\s+runtime: worker$/m);
    // the alias deprecations are gone after the rewrite; the v13-only ones stay
    expect(v16DeprecationsIn(out).map((d) => d.id).sort()).toEqual(['v16.mcp.protocol-2024-11-05', 'v16.plugins.1.inline']);
  });

  it('C2 lists the v13-only changes as pending and never writes them', () => {
    const r = planV13(SAMPLE, 'yaml');
    expect(r.pending.map((p) => p.id)).toEqual(['v16.plugins.1.inline', 'v16.mcp.protocol-2024-11-05', 'v16.node']);
    expect(r.pending[0]!.v13).toMatch(/allowInline: true/);
    expect(r.text).not.toMatch(/allowInline/);
    expect(parse(r.text).mcp.protocolVersions).toEqual(['2025-06-18', '2024-11-05']);
  });

  it('C3 is idempotent and reports a clean file as clean', () => {
    const once = planV13(SAMPLE, 'yaml');
    const twice = planV13(once.text, 'yaml');
    expect(twice.ok).toBe(true);
    expect(twice.changes).toEqual([]);
    expect(twice.text).toBe(once.text);
    expect(twice.diff).toBe('');
    const clean = planV13('version: 12\nplugins:\n  - module: ./a.mjs\n    runtime: worker\n', 'yaml');
    expect(clean.changes).toEqual([]);
    expect(clean.pending.map((p) => p.id)).toEqual(['v16.node']);
  });

  it('C4 refuses conflicting isolation / runtime and files that are not schema v12', () => {
    const c = planV13('version: 12\nplugins:\n  - module: ./a.mjs\n    isolation: worker\n    runtime: process\n', 'yaml');
    expect(c.ok).toBe(false);
    expect(c.report.errors.join('\n')).toMatch(/plugins\.0\.runtime.*disagree/); // the v12 loader already refuses it
    const same = planV13('version: 12\nplugins:\n  - module: ./a.mjs\n    isolation: worker\n    runtime: worker\n', 'yaml');
    expect(same.ok).toBe(true);
    expect(same.changes).toEqual(['plugins[0].isolation: worker (same as runtime) removed']);
    expect(planV13('version: 11\n', 'yaml').report.errors.join('\n')).toMatch(/config migrate --to v12/);
    expect(planV13('version: 13\n', 'yaml').report.errors.join('\n')).toMatch(/16\.0/);
    const json = planV13(JSON.stringify({ version: 12, plugins: [{ module: './a.mjs', isolation: 'process' }] }), 'json');
    expect(json.ok).toBe(true);
    expect(JSON.parse(json.text).plugins[0]).toEqual({ module: './a.mjs', runtime: 'process' });
  });

  it('C5 CLI: --dry-run writes nothing, --in-place keeps a backup, diff exit codes, --json', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mgw-v13-'));
    const f = join(dir, 'gw.yml');
    writeFileSync(f, SAMPLE);
    const dry = cli('config', 'migrate', '--to', 'v13', '--dry-run', '-c', f);
    expect(dry.status).toBe(0);
    expect(dry.stdout).toMatch(/runtime: worker/);
    expect(dry.stdout).toMatch(/pending \(schema v13, 16\.0\)/);
    expect(readFileSync(f, 'utf8')).toBe(SAMPLE);
    expect(cli('config', 'diff', '--to', 'v13', '-c', f).status).toBe(3);
    const j = JSON.parse(cli('config', 'migrate', '--to', 'v13', '--dry-run', '--json', '-c', f).stdout);
    expect(j.to).toBe(13);
    expect(j.writes).toBe(12);
    expect(j.pending.length).toBe(3);
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
