/** 10.0: schema v10 only (`features` block), unified kernel, LTS. */
import { describe, it, expect, afterEach } from 'vitest';
import { parse } from 'yaml';
import { validateConfig, generateDefaultConfig } from '../src/config/loader.js';
import { migrateConfigText } from '../src/config/migrate.js';
import { configDeprecations, removedConfigKeys, DEPRECATIONS } from '../src/utils/deprecations.js';
import { portableConfig, featureSection, withFeatureSection } from '../src/gateway/admin.js';
import { desktopConfig } from '../src/features/offline.js';
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
    expect(Object.keys(DEPRECATIONS)).toEqual([]); // 11.0
    expect(configDeprecations({ version: 11, features: { chaos } })).toEqual([]);
    expect(() => validateConfig({ version: 9, servers: [] })).toThrow(/config schema v9 was removed in 10.0 — use `version: 11`; run `mcp-gateway migrate --to 11`/);
    expect(() => validateConfig({ version: 8, servers: [] })).toThrow(/use `version: 11`/);
    expect(() => validateConfig({ servers: [], chaos })).toThrow(/chaos: removed in 10.0 — move under `features: \{ … \}`/);
    expect(() => validateConfig({ version: 12, servers: [] })).toThrow(/11.0 reads `version: 11`/);
    expect(() => validateConfig({ version: 11, servers: [], features: { nope: {} } })).toThrow(/unknown feature section\(s\) nope/);
    const cfg = validateConfig({ version: 11, servers: [], features: { chaos } });
    expect(cfg.chaos).toBeDefined();
    expect(cfg.deprecations?.map((d) => d.id)).toBeUndefined();
    expect(validateConfig({ servers: [], features: { chaos } }).chaos).toBeDefined(); // version may be omitted
    expect(removedConfigKeys({ version: 11 })).toEqual([]);
    expect(parse(generateDefaultConfig()).version).toBe(11); // 10.9: init writes schema v11
  });

  it('round trips through the config API and data planes always get version 10', () => {
    const cfg = validateConfig({ servers: [], features: { chaos } });
    const p = portableConfig(cfg);
    expect(p.features).toEqual({ chaos: cfg.chaos });
    expect(p).not.toHaveProperty('chaos');
    expect(validateConfig(p).chaos).toEqual(cfg.chaos);
    expect(distributedConfig({ servers: [] }).version).toBe(11);
  });

  it('migrate --to 10 still upgrades 9.x files; 11.0 validates them after --to 11', () => {
    const r = migrateConfigText('version: 9\nsla:\n  targets: [{ id: gold, availability: 99.9 }] # gold\nservers: []\n', 'yaml', 10);
    expect(r.changes).toEqual(['version: 9 → 10', 'sla → features.sla']);
    expect(r.text).toContain('# gold');
    expect(() => validateConfig(parse(r.text))).toThrow(/schema v10 was removed in 11.0/);
    const r11 = migrateConfigText(r.text, 'yaml');
    expect(r11.text).toContain('# gold');
    expect(validateConfig(parse(r11.text)).sla).toBeDefined();
  });

  it('kernel: schema, LTS, modules, hook pipeline, configured sections', async () => {
    expect(CONFIG_SCHEMA_VERSION).toBe(11);
    expect(LTS).toMatchObject({ line: '10.x', lts: true });
    expect(ltsStatus(new Date('2027-01-01'))).toBe('active');
    expect(ltsStatus(new Date('2028-01-01'))).toBe('maintenance');
    expect(ltsStatus(new Date('2029-01-01'))).toBe('end-of-life');
    h = await startFeatureGw({ chaos } as never);
    const k = await h.admin('kernel');
    expect(k.body.schema).toBe(11);
    expect(k.body.lts.line).toBe('10.x');
    expect(k.body.line).toEqual({ line: '11.x', lts: false });
    expect(k.body.moduleMode).toBe('lazy');
    expect(k.body.modules.map((m: any) => m.id)).toEqual(expect.arrayContaining(['kernel', 'chaos', 'sla', 'self-healing', 'ecosystem']));
    expect(k.body.hooks.map((x: any) => x.id)).toEqual(expect.arrayContaining(['chaos', 'multimodal', 'confidential', 'sla', 'self-healing']));
    expect(k.body.hooks[0].order).toBe(1);
    expect(k.body.features.find((f: any) => f.section === 'features.chaos').configured).toBe(true);
    expect(k.body.features.find((f: any) => f.section === 'features.sla').configured).toBe(false);
  });
  it('schema-form helpers and generated configs use `features` (10.0 fixes)', () => {
    const p = portableConfig(validateConfig({ servers: [], features: { chaos } }));
    expect(featureSection(p, 'chaos')).toEqual(p.features && (p.features as any).chaos);
    const q = withFeatureSection(p, 'rollouts', [{ id: 'r', server: 'a', percent: 10 }]);
    expect((q.features as any).rollouts).toHaveLength(1);
    expect(q).not.toHaveProperty('rollouts');
    expect(withFeatureSection(withFeatureSection(p, 'chaos', undefined), 'x', undefined)).not.toHaveProperty('features');
    const d = desktopConfig({ apiKey: 'k' }).config;
    expect(d).toMatchObject({ version: 11, features: { offline: { mode: 'auto' } } });
    expect(validateConfig(d).offline).toMatchObject({ mode: 'auto' });
  });
});
