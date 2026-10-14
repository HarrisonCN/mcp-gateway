/**
 * 15.0.0: the four changes announced in 14.9.0 (docs/v15/freeze.md, docs/migrating-to-v15.md) — and nothing else.
 *
 *  C1 `schema.v11`: a v11 file (`version: 11`, or unversioned with a v11-only field) is refused with the migrate command;
 *     `mcp-gateway config migrate --to v12` (migrateToV12) still reads it
 *  C2 `v15.plugins.<i>.runtime`: a module plugin without `runtime` / `isolation` runs in a worker; `runtime: inline` keeps
 *     the 14.x behaviour; component plugins are unchanged
 *  C3 `v15.config.unknown-key.<key>`: an unknown top-level key of a `version: 12` file is refused (`$schema` allowed)
 *  C4 `schema/v12-draft`: the alias directory is gone; schema/v12 is generated from the code
 *  C5 the docs name every 15.0 id; the v12 top-level key list matches the generated schema
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { validateConfig } from '../src/config/loader.js';
import { V15_DEPRECATION_IDS, V12_TOP_LEVEL_KEYS, v15ConfigErrors } from '../src/config/v15-deprecations.js';
import { buildV12ConfigSchema, migrateToV12 } from '../src/config/v12.js';
import { runtimeOfConfig } from '../src/plugins/index.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

describe('15.0.0 changes (announced in 14.9.0)', () => {
  it('C1 v11 files are refused with the migrate command; config migrate still reads them', () => {
    for (const raw of [{ version: 11, servers: [] }, { servers: [], kernel: { modules: 'eager' } }, { servers: [], features: { policyShadow: {} } }]) {
      expect(() => validateConfig(raw), JSON.stringify(raw)).toThrow(/config schema v11 is no longer read by 15\.0\.0.*mcp-gateway config migrate --to v12 --in-place/s);
    }
    const r = migrateToV12('version: 11\nservers: []\nkernel: { modules: eager }\n');
    expect(r.report.errors).toEqual([]);
    expect(validateConfig(r.config).schemaVersion).toBe(12);
    expect(validateConfig({ servers: [] }).schemaVersion).toBe(12); // unversioned without v11 fields: v12, as in 14.x
  });

  it('C2 module plugins run in a worker unless they say runtime: inline', () => {
    expect(runtimeOfConfig({ module: './a.mjs' } as never)).toBe('worker');
    expect(runtimeOfConfig({ module: './a.mjs', runtime: 'inline' } as never)).toBe('inline');
    expect(runtimeOfConfig({ module: './a.mjs', isolation: 'inline' } as never)).toBe('inline');
    expect(runtimeOfConfig({ module: './a.mjs', runtime: 'process' } as never)).toBe('process');
    const base = { version: 12, servers: [] };
    // limits / permissions need an isolated runtime: valid by default now, refused for explicit inline
    expect(() => validateConfig({ ...base, plugins: [{ module: './a.mjs', permissions: { network: false } }] })).not.toThrow();
    expect(() => validateConfig({ ...base, plugins: [{ module: './a.mjs', runtime: 'inline', permissions: { network: false } }] })).toThrow(/isolated runtime/);
    expect((validateConfig({ ...base, plugins: [{ module: './a.mjs' }, { component: './e.wasm' }] }).deprecations ?? []).filter((d) => d.id !== 'schema.v12')).toEqual([]); // 16.0.0-alpha.1: + schema.v12
  });

  it('C3 unknown top-level keys of a v12 file are refused; $schema is allowed', () => {
    expect(() => validateConfig({ version: 12, servers: [], include: ['x.yml'], extraThing: 1 } as never)).toThrow(/include: `include` is not a top-level key[\s\S]*extraThing: `extraThing`/);
    expect(() => validateConfig({ version: 12, servers: [], $schema: './schema/v12/config.schema.json' } as never)).not.toThrow();
    expect(v15ConfigErrors({ version: 12, servrs: [] })).toEqual([expect.stringMatching(/^servrs: /)]);
    expect(v15ConfigErrors(null)).toEqual([]);
  });

  it('C4 schema/v12-draft is removed; schema/v12 stays', () => {
    expect(existsSync(join(ROOT, 'schema/v12-draft'))).toBe(false);
    expect(existsSync(join(ROOT, 'schema/v12/config.schema.json'))).toBe(true);
    const files = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).files as string[] | undefined;
    if (files) expect(files.join(' ')).not.toMatch(/v12-draft/);
  });

  it('C5 docs name every 15.0 id; the top-level key list matches generated schema v12 (loader does not import the builder)', () => {
    const dep = readFileSync(join(ROOT, 'docs/deprecations.md'), 'utf8');
    const freeze = readFileSync(join(ROOT, 'docs/v15/freeze.md'), 'utf8');
    const mig = readFileSync(join(ROOT, 'docs/migrating-to-v15.md'), 'utf8');
    for (const id of V15_DEPRECATION_IDS) for (const [n, d] of [['deprecations', dep], ['freeze', freeze], ['migrating', mig]]) expect(d, `${n}: ${id}`).toContain(`\`${id}\``);
    const gen = Object.keys((buildV12ConfigSchema() as { properties: object }).properties);
    expect([...V12_TOP_LEVEL_KEYS].filter((k) => k !== '$schema').sort()).toEqual(gen.sort());
    expect(readFileSync(join(ROOT, 'src/config/v15-deprecations.ts'), 'utf8')).not.toMatch(/from '\.\/v12\.js'/);
  });
});
