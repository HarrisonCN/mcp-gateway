/**
 * 17.0.0-alpha.2 (development prerelease; the 17.0 list is a proposal until 17.0.0-rc.1, docs/v17/freeze.md): the
 * package's public exports — the SDK — get a recorded surface, so the 17.0 freeze can be checked mechanically.
 *
 *  E1 `api/exports-surface.json` records every export (value or type) of each package entry point (`package.json`
 *     `exports`: `.`, `./gateway`, `./edge`, `./testing`), sorted, with the version it was recorded at.
 *  E2 `scripts/sdk-surface.ts` computes the surface from the TypeScript sources: the current surface contains every
 *     recorded export (the surface may only grow), and a recorded name that disappears is reported (exit 1).
 *  E3 the recorded value exports of each entry point are exactly what the module exports at runtime (types aside),
 *     so the record cannot drift from what `import` sees.
 *  E4 the plugin-author surface in `./testing` is complete: plugin API constants, compatibility table, signing helpers
 *     and the harness.
 *  E5 `docs/v17/freeze.md` (draft) names the frozen surfaces — plugin API v6, schema v13, the four entry points — says
 *     the list is a proposal until rc.1 and that stable 17.0.0 needs its gates.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sdkSurface, ENTRY_POINTS } from '../scripts/sdk-surface.js';

/* eslint-disable @typescript-eslint/no-explicit-any */
const ROOT = join(__dirname, '..');
const readJson = (p: string) => JSON.parse(readFileSync(join(ROOT, p), 'utf8'));
const run = (...a: string[]) => spawnSync(process.execPath, ['--import', 'tsx', join(ROOT, 'scripts/sdk-surface.ts'), ...a], { cwd: ROOT, encoding: 'utf8', timeout: 110_000 });

describe('SDK export surface (17.0.0-alpha.2)', { timeout: 120_000 }, () => {
  const rec = readJson('api/exports-surface.json');
  const cur = sdkSurface(ROOT);

  it('E1 the record covers every package entry point, sorted, with the version it was recorded at', () => {
    expect(Object.keys(readJson('package.json').exports).sort()).toEqual(Object.keys(ENTRY_POINTS).sort());
    expect(Object.keys(rec.entries).sort()).toEqual(['.', './edge', './gateway', './testing']);
    expect(rec.recordedAt).toMatch(/^17\.0\.0-/);
    for (const [e, names] of Object.entries(rec.entries) as Array<[string, string[]]>) {
      expect(names.length, e).toBeGreaterThan(0);
      expect([...names].sort(), e).toEqual(names);
      expect(new Set(names).size, e).toBe(names.length);
      for (const n of names) expect(n, e).toMatch(/^(value|type) [A-Za-z_$][\w$]*$/);
    }
  });

  it('E2 the surface may only grow; a recorded export that disappears is reported', () => {
    for (const [e, names] of Object.entries(rec.entries) as Array<[string, string[]]>) {
      const now = new Set(cur[e]);
      expect(names.filter((n) => !now.has(n)), e).toEqual([]);
    }
    expect(run().status).toBe(0);
    const d = mkdtempSync(join(tmpdir(), 'mgw-sdk-'));
    const fake = { ...rec, entries: { ...rec.entries, './testing': [...rec.entries['./testing'], 'value zzRemovedHelper'].sort() } };
    writeFileSync(join(d, 'rec.json'), JSON.stringify(fake));
    const r = run('--record-file', join(d, 'rec.json'));
    expect(r.status).toBe(1);
    expect(r.stdout + r.stderr).toMatch(/\.\/testing: value zzRemovedHelper/);
  });

  it('E3 recorded value exports match the runtime exports of each entry point', async () => {
    for (const [e, src] of Object.entries(ENTRY_POINTS)) {
      const m = await import(join(ROOT, src));
      const runtime = Object.keys(m).filter((k) => k !== 'default').sort();
      const values = (cur[e] as string[]).filter((n) => n.startsWith('value ')).map((n) => n.slice(6));
      expect(values, e).toEqual(runtime);
    }
  });

  it('E4 ./testing carries the whole plugin-author surface', () => {
    const t = rec.entries['./testing'] as string[];
    for (const n of ['PLUGIN_API_VERSION', 'PLUGIN_API_MIN_VERSION', 'PLUGIN_COMPATIBILITY', 'pluginApiSupport', 'isPluginApiSupported', 'compatibilityMarkdown', 'startPluginHarness', 'toolCall', 'toolResponse', 'createTestSigningKey', 'signPluginFile', 'verifyReproducible']) {
      expect(t, n).toContain(`value ${n}`);
    }
  });

  it('E5 docs/v17/freeze.md names the frozen surfaces and the status', () => {
    const doc = readFileSync(join(ROOT, 'docs/v17/freeze.md'), 'utf8');
    for (const s of ['plugin API v6', 'schema v13', '`.`', '`./gateway`', '`./edge`', '`./testing`', 'api/exports-surface.json', 'scripts/sdk-surface.ts']) expect(doc, s).toContain(s);
    expect(doc).toMatch(/proposal until 17\.0\.0-rc\.1/);
    expect(doc).toMatch(/gates/);
    expect(doc).not.toMatch(/gates? (A|B|C)[^.\n]* (passed|closed)/i);
  });
});
