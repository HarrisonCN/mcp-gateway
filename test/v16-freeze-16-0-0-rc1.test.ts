/**
 * 16.0.0-rc.1 (prerelease on npm `canary`; stable 16.0.0 still needs the v16 gates): the 16.0 list is frozen.
 *
 *  R1 docs/v16/freeze.md says "frozen from 16.0.0-rc.1" and no longer calls the list a proposal; it still says stable
 *     16.0.0 needs its own gates (A/B against 15.0, an incremental external security review).
 *  R2 docs/migrating-to-v16.md and docs/deprecations.md: no "proposal" status for the 16.0 list.
 *  R3 the v13 schema title / code headers drop "proposal until 16.0.0-rc.1" and say frozen.
 *  R4 plugin compatibility: the 16.0 row is "frozen (prerelease)" — never "shipped" while no 16.0.0 GA exists;
 *     17.0 stayed a proposal until 17.0.0-rc.1 froze it (test/v17-freeze-17-0-0-rc1.test.ts); pluginApiSupport reports
 *     `frozen: true` for 16.x.
 *  R5 frozen surface guard: schema/v13/frozen-surface.json (recorded at 16.0.0-rc.1) lists every v13 key path and
 *     enum value; the current schema keeps all of them (additions allowed, removals / renames / narrowed enums fail).
 *  R6 CI for the 16.x line runs the gateway on Node 24 only (engines >= 24); the release gate's required checks follow.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { buildV13ConfigSchema } from '../src/config/v13-schema.js';
import * as compat from '../src/plugins/compat.js';

/* eslint-disable @typescript-eslint/no-explicit-any */
const ROOT = join(__dirname, '..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
const readJson = (p: string) => JSON.parse(read(p));

describe('16.0 freeze (16.0.0-rc.1)', () => {
  it('R1 docs/v16/freeze.md: frozen from 16.0.0-rc.1, gates still required for stable', () => {
    const doc = read('docs/v16/freeze.md');
    expect(doc).toMatch(/Status: frozen from 16\.0\.0-rc\.1/);
    expect(doc).not.toMatch(/proposal/i);
    expect(doc).not.toMatch(/may still change/i);
    expect(doc).toMatch(/gates/i);
    expect(doc).toContain('schema/v13/frozen-surface.json');
  });

  it('R2 migration guide and deprecations: the 16.0 list is no longer a proposal', () => {
    const mig = read('docs/migrating-to-v16.md');
    expect(mig).toMatch(/Status: frozen from 16\.0\.0-rc\.1/);
    expect(mig).not.toMatch(/proposal/i);
    expect(mig).toMatch(/gates/i);
    expect(read('docs/deprecations.md')).not.toMatch(/proposal\*\* until 16\.0\.0-rc\.1/);
  });

  it('R3 schema v13 title and code headers say frozen, not "proposal until rc.1"', () => {
    const files = ['schema/v13/config.schema.json', 'src/config/v13.ts', 'src/config/v13-schema.ts', 'src/config/v13-prep.ts', 'src/config/v16-deprecations.ts'];
    for (const f of files) expect(read(f), f).not.toMatch(/proposal until 16\.0\.0-rc\.1/);
    expect(readJson('schema/v13/config.schema.json').title).toMatch(/frozen from 16\.0\.0-rc\.1/);
    expect((buildV13ConfigSchema() as any).title).toMatch(/frozen from 16\.0\.0-rc\.1/);
  });

  it('R4 plugin compatibility: 16.0 is "frozen (prerelease)" until a 16.0.0 GA exists; 17.0 is frozen from 17.0.0-rc.1', () => {
    const r16 = compat.PLUGIN_COMPATIBILITY.find((r) => r.from === '16.0.0');
    const r17 = compat.PLUGIN_COMPATIBILITY.find((r) => r.from === '17.0.0');
    expect(r16?.status).toBe('frozen');
    expect(r17?.status).toBe('shipped'); // 17.0.0 GA (frozen in rc.1, a proposal before)
    expect(compat.pluginApiSupport('16.0.0-rc.1')).toEqual({ min: 5, max: 5, frozen: true });
    expect(compat.pluginApiSupport('17.0.0-alpha.1')).toEqual({ min: 6, max: 6 }); // 17.0.0 shipped the row (rc.1 froze it)
    const md = compat.compatibilityMarkdown();
    // 16.9.0-canary.0: the frozen v5 range ends at 16.9.0 (16.9 loads v5 – v6 early, a proposal like 17.0)
    expect(md).toMatch(/\| 16\.0\.0 – <16\.9\.0 \| v5 \| frozen \(prerelease\) \|/);
    expect(md).not.toMatch(/\| 16\.0\.0 – <1[67]\.\d\.0 \| v5 \| shipped \|/);
    expect(read('docs/guides/plugin-compatibility.md')).toContain(md);
  });

  it('R5 frozen surface: every v13 path / enum value recorded at rc.1 is still in the schema', async () => {
    const { surfaceOf, missingFromSurface } = await import('../scripts/v13-surface.js');
    expect(existsSync(join(ROOT, 'schema/v13/frozen-surface.json'))).toBe(true);
    const frozen = readJson('schema/v13/frozen-surface.json');
    expect(frozen.recordedAt).toBe('16.0.0-rc.1');
    expect(frozen.surface.length).toBeGreaterThan(100);
    expect(frozen.surface).toEqual(expect.arrayContaining(['version=13', 'plugins[].runtime', 'plugins[].runtime=worker', 'plugins[].allowInline', 'plugins[].isolation=tenant']));
    expect(missingFromSurface(frozen.surface, surfaceOf(buildV13ConfigSchema()))).toEqual([]);
    // the guard notices a removal and a narrowed enum; an added key passes
    const s = buildV13ConfigSchema() as any;
    delete s.properties.plugins.items.properties.allowInline;
    s.properties.plugins.items.properties.runtime.enum = ['inline', 'worker'];
    s.properties.addedLater = { type: 'string' };
    expect(missingFromSurface(frozen.surface, surfaceOf(s))).toEqual(['plugins[].allowInline', 'plugins[].runtime=process']);
  });

  it('R6 CI: gateway jobs on Node 24 only for 16.x; release gate follows', () => {
    const ci = parse(read('.github/workflows/ci.yml'));
    expect(ci.jobs.test.strategy.matrix.node).toEqual([24]);
    const perf = parse(read('.github/workflows/perf.yml'));
    expect(perf.jobs.load.name).toBe('Load + faults (Node 24)');
    for (const j of Object.values<any>(perf.jobs)) for (const st of j.steps ?? []) if (st.with?.['node-version'] !== undefined) expect(st.with['node-version']).toBe(24);
    const rel = parse(read('.github/workflows/release.yml'));
    expect(rel.jobs.assets.steps.find((s: any) => s.with?.['node-version'])?.with['node-version']).toBe(24);
    expect(read('.github/workflows/deploy-examples.yml')).not.toMatch(/node:22-alpine/);
    const req = readJson('scripts/required-checks.json');
    expect(req.required).toContain('Node 24');
    expect(req.required).not.toContain('Node 22');
    expect(req.conditional).toContain('Load + faults (Node 24)');
    expect(req.conditional).not.toContain('Load + faults (Node 22)');
    expect(read('docs/release-gates.md')).not.toMatch(/^\| `Node 22` \|/m);
    expect(readJson('package.json').engines.node).toBe('>=24.0.0');
  });
});
