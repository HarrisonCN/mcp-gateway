/** 9.9: 10.0 preparation — schema v10 preview (`features` block), deprecations, migrate --to 10. */
import { describe, it, expect } from 'vitest';
import { parse } from 'yaml';
import { validateConfig } from '../src/config/loader.js';
import { migrateConfigText } from '../src/config/migrate.js';
import { configDeprecations, removedConfigKeys, normalizeFeaturesV10, DEPRECATIONS } from '../src/utils/deprecations.js';
import { portableConfig } from '../src/gateway/admin.js';
import { distributedConfig } from '../src/gateway/control-plane.js';

const chaos = { experiments: [{ id: 'slow', fault: { latencyMs: 10 } }] };
const sla = { targets: [{ id: 'gold', availability: 99.9 }] };

describe('10.0 preparation (9.9)', () => {
  it('deprecates schema v9 and top-level feature sections; schema v10 preview with `features`', () => {
    expect(Object.values(DEPRECATIONS).map((d) => `${d.id}@${d.removedIn}`)).toEqual(['schema-v9@10.0.0', 'top-level-features@10.0.0']);
    expect(configDeprecations({ version: 9, chaos, sla }).map((d) => `${d.id}:${d.detail}`)).toEqual(['schema-v9:version: 9', 'top-level-features:chaos, sla']);
    expect(configDeprecations({ chaos }).map((d) => d.id)).toEqual(['top-level-features']);
    expect(configDeprecations({ version: 10, features: { chaos } })).toEqual([]);
    const v10 = validateConfig({ version: 10, servers: [], store: { backend: 'memory' }, features: { chaos, sla } });
    expect(v10.version).toBe(10);
    expect(v10.deprecations).toBeUndefined();
    expect(v10.chaos).toBeDefined(); // internals keep the sections top-level
    expect(v10.sla).toBeDefined();
    expect(() => validateConfig({ version: 10, servers: [], chaos })).toThrow(/chaos: not part of config schema v10 — move under `features: \{ … \}`/);
    expect(() => validateConfig({ version: 9, servers: [], features: { chaos } })).toThrow(/`features` is part of config schema v10/);
    expect(() => validateConfig({ version: 10, servers: [], features: { nope: {} } })).toThrow(/unknown feature section\(s\) nope/);
    expect(() => validateConfig({ version: 10, servers: [], features: [] })).toThrow(/features: must be an object/);
    expect(() => validateConfig({ version: 11, servers: [] })).toThrow(/9.9 reads `version: 9` or `version: 10`/);
    expect(() => validateConfig({ version: 10, servers: [], features: { sla: { targets: [{ id: 'x', availability: 200 }] } } })).toThrow(/sla/);
    expect(validateConfig({ version: 9, servers: [], chaos }).deprecations?.map((d) => d.id)).toEqual(['schema-v9', 'top-level-features']);
    expect(removedConfigKeys({ version: 10, features: {} })).toEqual([]);
    expect(normalizeFeaturesV10({ a: 1 })).toEqual({ a: 1 });
  });

  it('round trips: portableConfig nests `features` on v10, data planes keep the schema version', () => {
    const v10 = validateConfig({ version: 10, servers: [], features: { chaos } });
    const p = portableConfig(v10);
    expect(p.features).toEqual({ chaos: v10.chaos });
    expect(p).not.toHaveProperty('chaos');
    expect(validateConfig(p).chaos).toEqual(v10.chaos);
    const v9 = portableConfig(validateConfig({ version: 9, servers: [], chaos }));
    expect(v9.chaos).toBeDefined();
    expect(v9).not.toHaveProperty('features');
    expect(distributedConfig({ version: 10, servers: [] }).version).toBe(10);
    expect(distributedConfig({ servers: [] }).version).toBe(9);
  });

  it('migrate --to 10 (default): version 10, feature sections → features, keeps comments', () => {
    const src = '# gw\nversion: 9\nstore: { backend: memory }\n# chaos drills\nchaos:\n  experiments:\n    - id: slow # staging only\n      fault: { latencyMs: 10 }\nsla:\n  targets: [{ id: gold, availability: 99.9 }]\nservers: []\n';
    const r = migrateConfigText(src);
    expect(r.changes).toEqual(['version: 9 → 10', 'chaos → features.chaos', 'sla → features.sla']);
    expect(r.text).toContain('# gw');
    expect(r.text).toContain('id: slow # staging only');
    const cfg = validateConfig(parse(r.text));
    expect(cfg.version).toBe(10);
    expect(cfg.chaos).toBeDefined();
    expect(cfg.deprecations).toBeUndefined();
    expect(migrateConfigText(r.text).changed).toBe(false);
    expect(migrateConfigText('version: 9\nfeatures: { chaos: {} }\nchaos: {}\n').notes.join()).toMatch(/both set/);
    expect(migrateConfigText('version: 8\nstate: { store: memory }\ndlp: {}\nservers: []\n').changes).toEqual(['version: 8 → 10', 'state → store', 'dlp → features.dlp']);
    expect(migrateConfigText(src, 'yaml', 9).changed).toBe(false);
  });
});
