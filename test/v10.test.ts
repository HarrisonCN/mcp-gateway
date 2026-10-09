/** 10.0: schema v10 only (`features` block), unified kernel, LTS. */
import { describe, it, expect, afterEach } from 'vitest';
import { parse } from 'yaml';
import { validateConfig, generateDefaultConfig } from '../src/config/loader.js';
import { migrateConfigText } from '../src/config/migrate.js';
import { configDeprecations, removedConfigKeys, DEPRECATIONS } from '../src/utils/deprecations.js';
import { portableConfig } from '../src/gateway/admin.js';
import { distributedConfig } from '../src/gateway/control-plane.js';
import { CONFIG_SCHEMA_VERSION, LTS, ltsStatus } from '../src/features/kernel.js';
import { startFeatureGw, type FeatureGw } from './helpers/feature-gw.js';

const chaos = { experiments: [{ id: 'slow', fault: { latencyMs: 10 } }] };
let h: FeatureGw | undefined;
afterEach(async () => {
  await h?.stop();
  h = undefined;
});

describe('10.0: schema v10, unified kernel, LTS', () => {
  it('reads schema v10 only; v9 and top-level feature sections are refused with the migration hint', () => {
    expect(Object.keys(DEPRECATIONS)).toEqual([]);
    expect(configDeprecations({ version: 10, features: { chaos } })).toEqual([]);
    expect(() => validateConfig({ version: 9, servers: [] })).toThrow(/config schema v9 was removed in 10.0 — use `version: 10`; run `mcp-gateway migrate --to 10`/);
    expect(() => validateConfig({ version: 8, servers: [] })).toThrow(/use `version: 10`/);
    expect(() => validateConfig({ servers: [], chaos })).toThrow(/chaos: removed in 10.0 — move under `features: \{ … \}`/);
    expect(() => validateConfig({ version: 11, servers: [] })).toThrow(/10.0 reads `version: 10`/);
    expect(() => validateConfig({ version: 10, servers: [], features: { nope: {} } })).toThrow(/unknown feature section\(s\) nope/);
    const cfg = validateConfig({ version: 10, servers: [], features: { chaos } });
    expect(cfg.chaos).toBeDefined();
    expect(cfg.deprecations).toBeUndefined();
    expect(validateConfig({ servers: [], features: { chaos } }).chaos).toBeDefined(); // version may be omitted
    expect(removedConfigKeys({ version: 10 })).toEqual([]);
    expect(parse(generateDefaultConfig()).version).toBe(10);
  });

  it('round trips through the config API and data planes always get version 10', () => {
    const cfg = validateConfig({ servers: [], features: { chaos } });
    const p = portableConfig(cfg);
    expect(p.features).toEqual({ chaos: cfg.chaos });
    expect(p).not.toHaveProperty('chaos');
    expect(validateConfig(p).chaos).toEqual(cfg.chaos);
    expect(distributedConfig({ servers: [] }).version).toBe(10);
  });

  it('migrate --to 10 still upgrades 9.x files', () => {
    const r = migrateConfigText('version: 9\nsla:\n  targets: [{ id: gold, availability: 99.9 }] # gold\nservers: []\n');
    expect(r.changes).toEqual(['version: 9 → 10', 'sla → features.sla']);
    expect(r.text).toContain('# gold');
    expect(validateConfig(parse(r.text)).sla).toBeDefined();
  });

  it('kernel: schema, LTS, modules, hook pipeline, configured sections', async () => {
    expect(CONFIG_SCHEMA_VERSION).toBe(10);
    expect(LTS).toMatchObject({ line: '10.x', lts: true });
    expect(ltsStatus(new Date('2027-01-01'))).toBe('active');
    expect(ltsStatus(new Date('2028-01-01'))).toBe('maintenance');
    expect(ltsStatus(new Date('2029-01-01'))).toBe('end-of-life');
    h = await startFeatureGw({ chaos } as never);
    const k = await h.admin('kernel');
    expect(k.body.schema).toBe(10);
    expect(k.body.lts.line).toBe('10.x');
    expect(k.body.modules.map((m: any) => m.id)).toEqual(expect.arrayContaining(['kernel', 'chaos', 'sla', 'self-healing', 'ecosystem']));
    expect(k.body.hooks.map((x: any) => x.id)).toEqual(expect.arrayContaining(['chaos', 'multimodal', 'confidential', 'sla', 'self-healing']));
    expect(k.body.hooks[0].order).toBe(1);
    expect(k.body.features.find((f: any) => f.section === 'features.chaos').configured).toBe(true);
    expect(k.body.features.find((f: any) => f.section === 'features.sla').configured).toBe(false);
  });
});
