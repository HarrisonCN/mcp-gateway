/**
 * 14.9.0: the 15.0.0 deprecations are announced one minor ahead (docs/versions.md) — listed by the loader (config
 * `deprecations`, `mcp-gateway validate`, GET /api/v1/admin/deprecations) and logged once per id at start / reload.
 *
 *  D1 module plugins without `runtime` (or `isolation`): inline in 14.x, `worker` by default in 15.0
 *  D2 unknown top-level keys in a schema v12 file: ignored in 14.x, refused by 15.0
 *  D3 schema v11 files: read (migrated in memory) by 14.x, refused by 15.0 (the existing `schema.v11` notice)
 *  D4 docs/deprecations.md and docs/v15/freeze.md name every id
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { validateConfig } from '../src/config/loader.js';
import { V15_DEPRECATION_IDS, V12_TOP_LEVEL_KEYS, v15DeprecationsIn } from '../src/config/v15-deprecations.js';
import { buildV12ConfigSchema } from '../src/config/v12.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

describe('15.0 deprecations announced in 14.9.0', () => {
  it('D1 a module plugin without runtime is listed; runtime / isolation set or a component plugin is not', () => {
    const c = validateConfig({ version: 12, servers: [], plugins: [{ module: './a.mjs' }, { module: './b.mjs', runtime: 'worker' }, { module: './c.mjs', runtime: 'inline' }, { module: './d.mjs', isolation: 'process' }, { component: './e.wasm' }] });
    const ids = (c.deprecations ?? []).map((d) => d.id);
    expect(ids).toEqual(['v15.plugins.0.runtime']);
    expect(c.deprecations![0]).toMatchObject({ removedIn: '15.0.0', replacement: expect.stringMatching(/runtime: worker/) });
  });
  it('D2 unknown top-level keys of a v12 file are listed (and still ignored in 14.x)', () => {
    const c = validateConfig({ version: 12, servers: [], include: ['x.yml'], extraThing: 1 } as never);
    expect((c.deprecations ?? []).map((d) => d.id).sort()).toEqual(['v15.config.unknown-key.extraThing', 'v15.config.unknown-key.include']);
    expect(validateConfig({ version: 12, servers: [], $schema: './schema/v12/config.schema.json' } as never).deprecations ?? []).toEqual([]);
  });
  it('D3 a v11 file keeps its v12 field deprecations and adds the plugin one; a clean v12 file has none', () => {
    const c = validateConfig({ version: 11, servers: [], kernel: { modules: 'eager' }, plugins: [{ module: './a.mjs' }] });
    expect((c.deprecations ?? []).map((d) => d.id)).toEqual(expect.arrayContaining(['v12.kernel.modules', 'v15.plugins.0.runtime']));
    expect(validateConfig({ version: 12, servers: [] }).deprecations ?? []).toEqual([]);
    expect(v15DeprecationsIn(null)).toEqual([]);
  });
  it('D5 the top-level key list matches generated schema v12 (the loader does not import the schema builder)', () => {
    const gen = Object.keys((buildV12ConfigSchema() as { properties: object }).properties);
    expect([...V12_TOP_LEVEL_KEYS].filter((k) => k !== '$schema').sort()).toEqual(gen.sort());
    expect(readFileSync(join(ROOT, 'src/config/v15-deprecations.ts'), 'utf8')).not.toMatch(/from '\.\/v12\.js'/);
  });
  it('D4 the docs name every 15.0 id', () => {
    const dep = readFileSync(join(ROOT, 'docs/deprecations.md'), 'utf8');
    const freeze = readFileSync(join(ROOT, 'docs/v15/freeze.md'), 'utf8');
    for (const id of V15_DEPRECATION_IDS) {
      expect(dep, id).toContain(`\`${id}\``);
      expect(freeze, id).toContain(`\`${id}\``);
    }
  });
});
