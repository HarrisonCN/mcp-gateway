/**
 * 17.0.0-rc.1 (prerelease on npm `canary`; stable 17.0.0 needs the v17 gates, and 15.0.0 / 16.0.0 are not stable
 * either — gates A / B / C open): the 17.0 list is frozen.
 *
 *  F1 docs/v17/freeze.md says "frozen from 17.0.0-rc.1", no longer calls the list a proposal or a draft, and still says
 *     stable 17.0.0 needs its gates (none passed).
 *  F2 docs/migrating-to-v17.md and docs/deprecations.md: no "proposal" status for the 17.0 list.
 *  F3 plugin compatibility: the 17.0 row is "frozen (prerelease)" — never "shipped" while no 17.0.0 GA exists;
 *     pluginApiSupport reports `frozen: true` for 17.x; the generated table in the guide matches.
 *  F4 the SDK export surface is re-recorded at 17.0.0-rc.1 (the frozen list) and keeps every export recorded at
 *     17.0.0-alpha.2.
 *  F5 docs/versions.md names the planned 15.x maintenance line (`v15-lts`) and says it is not active: it starts only
 *     after 15.0.0 and 17.0.0 are stable.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as compat from '../src/plugins/compat.js';

/* eslint-disable @typescript-eslint/no-explicit-any */
const ROOT = join(__dirname, '..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
const readJson = (p: string) => JSON.parse(read(p));

/** Every export recorded at 17.0.0-alpha.2 (the first, proposal record) — the frozen list may only add to it. */
const ALPHA2_COUNTS: Record<string, number> = { '.': 542, './gateway': 113, './edge': 23, './testing': 27 };

describe('17.0 freeze (17.0.0-rc.1)', () => {
  it('F1 docs/v17/freeze.md: frozen from 17.0.0-rc.1, gates still required for stable', () => {
    const doc = read('docs/v17/freeze.md');
    expect(doc).toMatch(/Status: frozen from 17\.0\.0-rc\.1/);
    expect(doc).not.toMatch(/proposal/i);
    expect(doc).not.toMatch(/draft/i);
    // 17.0.0: shipped by owner decision without its gates (test/v17-ga-17-0-0.test.ts); before: "stable 17.0.0 needs gates"
    expect(doc).toMatch(/stable 17\.0\.0[^.]*gates/i);
    expect(doc).toMatch(/not a passed gate/);
    expect(doc).not.toMatch(/gates? (A|B|C)[^.\n]* (passed|closed)/i);
  });

  it('F2 migration guide and deprecations: the 17.0 list is no longer a proposal', () => {
    const mig = read('docs/migrating-to-v17.md');
    expect(mig).toMatch(/Status: frozen from 17\.0\.0-rc\.1/);
    expect(mig).not.toMatch(/proposal/i);
    expect(mig).toMatch(/gates/i);
    expect(read('docs/deprecations.md')).not.toMatch(/17\.0 list is a \*\*proposal\*\*/);
  });

  it('F3 plugin compatibility: 17.0 is "frozen (prerelease)" until a 17.0.0 GA exists', () => {
    // 17.0.0 GA (owner decision, 2026-10-15): the row moved from frozen (prerelease) to shipped — see v17-ga-17-0-0
    const r17 = compat.PLUGIN_COMPATIBILITY.find((r) => r.from === '17.0.0');
    expect(r17?.status).toBe('shipped');
    expect(r17?.notes).not.toMatch(/proposal/);
    expect(compat.pluginApiSupport('17.0.0-rc.1')).toEqual({ min: 6, max: 6 });
    const md = compat.compatibilityMarkdown();
    expect(md).toMatch(/\| 17\.0\.0 \+ \| v6 \| shipped \|/);
    expect(md).not.toMatch(/\| 17\.0\.0 \+ \| v6 \| frozen \(prerelease\) \|/);
    expect(read('docs/guides/plugin-compatibility.md')).toContain(md);
  });

  it('F4 SDK exports: re-recorded at 17.0.0-rc.1, nothing recorded at alpha.2 dropped', () => {
    const rec = readJson('api/exports-surface.json');
    expect(rec.recordedAt).toBe('17.0.0-rc.1');
    expect(rec.$comment).toMatch(/frozen/i);
    for (const [e, n] of Object.entries(ALPHA2_COUNTS)) expect(rec.entries[e].length, e).toBeGreaterThanOrEqual(n);
  });

  it('F5 docs/versions.md: the 15.x maintenance line (v15-lts) is planned, not active', () => {
    const v = read('docs/versions.md');
    expect(v).toMatch(/`v15-lts`/);
    expect(v).toMatch(/planned[^.\n]*not active/i);
    // 17.0.0 shipped but 15.0.0 never did: still no v15-lts (14.9.x is kept as v14-lts instead)
    expect(v).toMatch(/no\s+`v15-lts` tag/);
    expect(v).toMatch(/`v14-lts`/);
  });
});
