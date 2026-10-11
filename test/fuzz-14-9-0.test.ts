/**
 * 14.9.0 property / fuzz runs for the v15 release candidate: config parsing (schema v12, v11 → v12 migration, `${VAR}`
 * expansion, loader ⇔ JSON-schema agreement) and routing (split decisions). Seeds are fixed so a failure reproduces;
 * FC_RUNS raises the number of runs (CI nightly / soak job: FC_RUNS=5000).
 */
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { stringify } from 'yaml';
import Ajv from 'ajv';
import { validateConfig } from '../src/config/loader.js';
import { migrateToV12, downgradeFromV12, downgradeLoss, V12_DEPRECATIONS } from '../src/config/v12.js';
import { canonicalJson, configHash } from '../src/config/gitops.js';
import { SmartRouter } from '../src/gateway/routing.js';
import { logger } from '../src/utils/logger.js';

logger.setLevel('error');
/* eslint-disable @typescript-eslint/no-explicit-any */
const RUNS = Number(process.env.FC_RUNS ?? 200);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SCHEMA = JSON.parse(readFileSync(join(ROOT, 'schema/v12/config.schema.json'), 'utf8'));
const validateSchema = new Ajv({ allErrors: true, strict: false }).compile(SCHEMA);
/** How many generated configs were accepted (a property that only ever sees rejected input proves nothing). */
const accepted = { f1: 0, f3: 0 };
const invalid = (err: unknown) => expect(String(err)).toMatch(/Invalid configuration|references environment variable|must be/);

const server = (id: string) => ({ id, name: id, transport: 'stdio', command: 'node' });
const servers = fc.uniqueArray(fc.constantFrom('a', 'b', 'c', 'search', 'search-v2'), { minLength: 1, maxLength: 4 }).map((ids) => ids.map(server));

/** v11 files as people write them: optional deprecated fields (V12_DEPRECATIONS) plus ordinary sections. */
const v11Config = fc.record(
  {
    kernel: fc.record({ modules: fc.constantFrom('lazy', 'eager'), failurePolicy: fc.dictionary(fc.constantFrom('billing', 'console', 'realtime-budgets'), fc.constantFrom('open', 'closed', 'degrade')) }, { requiredKeys: [] }),
    features: fc.record({ genaiTelemetry: fc.record({ exportIntervalMs: fc.integer({ min: 1000, max: 60000 }) }, { requiredKeys: [] }), policyShadow: fc.constant({}), postQuantumTls: fc.constant({}), chaos: fc.record({ enabled: fc.boolean() }, { requiredKeys: [] }) }, { requiredKeys: [] }),
    rateLimit: fc.record({ windowSeconds: fc.integer({ min: 1, max: 3600 }), limit: fc.integer({ min: 1, max: 10000 }) }),
    logLevel: fc.constantFrom('debug', 'info', 'warn', 'error'),
    port: fc.integer({ min: 1, max: 65535 }),
  },
  { requiredKeys: [] },
);

describe('F1 v11 → v12 migration', () => {
  it('v11 files are refused by the loader (15.0); their migration is valid, loadable v12 that migrates again to nothing', () => {
    fc.assert(
      fc.property(v11Config, servers, (extra, srv) => {
        const v11: any = { version: 11, servers: srv, ...extra };
        // 15.0.0: a v11 file is refused by the loader — `config migrate --to v12` is the only way in
        expect(() => validateConfig(JSON.parse(JSON.stringify(v11)))).toThrow(/schema v11 is no longer read by 15\.0\.0.*config migrate --to v12/s);
        const r = migrateToV12(stringify(v11));
        try {
          validateConfig(JSON.parse(JSON.stringify(r.config)));
        } catch (err) {
          invalid(err);
          return;
        }
        accepted.f1++;
        expect(r.report.errors).toEqual([]);
        expect((r.config as any).version).toBe(12);
        expect(validateSchema(r.config), JSON.stringify(validateSchema.errors?.slice(0, 2))).toBe(true);
        expect(() => validateConfig(JSON.parse(JSON.stringify(r.config)))).not.toThrow();
        expect(migrateToV12(r.text).changes).toEqual([]);
        expect(downgradeLoss(r.config as any)).toEqual([]);
        expect(downgradeFromV12(r.config as any)).toEqual(downgradeFromV12(migrateToV12(stringify(downgradeFromV12(r.config as any))).config as any));
        // every deprecated v11 path is gone from the output
        const out = JSON.stringify(r.config);
        expect(out).not.toMatch(/"kernel"|"genaiTelemetry"|"policyShadow"|"postQuantumTls"/);
        void V12_DEPRECATIONS;
      }),
      { numRuns: RUNS, seed: 1490 },
    );
    expect(accepted.f1).toBeGreaterThan(RUNS / 4);
  });

  it('arbitrary text never crashes migrateToV12 (it reports instead)', () => {
    fc.assert(
      fc.property(fc.oneof(fc.string(), fc.jsonValue().map((v) => JSON.stringify(v)), fc.jsonValue().map((v) => stringify(v))), (text) => {
        const r = migrateToV12(text);
        expect(typeof r.ok).toBe('boolean');
        if (!r.ok) expect(r.report.errors.length).toBeGreaterThan(0);
      }),
      { numRuns: RUNS * 2, seed: 1491 },
    );
  });
});

describe('F2 ${VAR} expansion in API keys (MGW-2026-019 class)', () => {
  const name = fc.stringMatching(/^[A-Z][A-Z0-9_]{0,12}$/);
  it('an accepted config never keeps an unexpanded ${NAME} reference as a key', () => {
    fc.assert(
      fc.property(name, fc.option(fc.string({ minLength: 1, maxLength: 20 }), { nil: undefined }), fc.constantFrom('string', 'object'), fc.string({ maxLength: 6 }), (n, value, form, pre) => {
        const v = `MGW_F2_${n}`;
        if (value === undefined) delete process.env[v];
        else process.env[v] = value;
        const ref = `${pre}\${${v}}`;
        const key = form === 'string' ? ref : { key: ref };
        try {
          const c = validateConfig({ servers: [], auth: { strategy: 'api-key', apiKeys: [key] } });
          const got = JSON.stringify(c.auth?.apiKeys);
          expect(got).not.toContain(`\${${v}}`);
          expect(value === undefined || value === '').toBe(false); // unset / empty references are refused
        } catch (err) {
          invalid(err);
        } finally {
          delete process.env[v];
        }
      }),
      { numRuns: RUNS, seed: 1492 },
    );
  });
});

describe('F3 loader ⇔ JSON schema agreement on known sections', () => {
  const section = fc.record(
    {
      host: fc.oneof(fc.constant('127.0.0.1'), fc.string({ maxLength: 8 })),
      port: fc.oneof(fc.integer({ min: -5, max: 70000 }), fc.string({ maxLength: 3 })),
      logLevel: fc.oneof(fc.constantFrom('debug', 'info', 'warn', 'error'), fc.string({ maxLength: 5 })),
      rateLimit: fc.record({ windowSeconds: fc.oneof(fc.integer({ min: -1, max: 100 }), fc.constant('x')), limit: fc.integer({ min: -1, max: 100 }) }, { requiredKeys: [] }),
      auth: fc.oneof(fc.constant({ strategy: 'none' }), fc.record({ strategy: fc.constant('api-key'), apiKeys: fc.array(fc.stringMatching(/^[a-z0-9-]{4,24}$/), { maxLength: 3 }) })),
      modules: fc.record({ activation: fc.oneof(fc.constantFrom('lazy', 'eager'), fc.string({ maxLength: 4 })) }, { requiredKeys: [] }),
    },
    { requiredKeys: [] },
  );
  it('a config the loader accepts is valid against schema/v12/config.schema.json', () => {
    fc.assert(
      fc.property(section, servers, (s, srv) => {
        const cfg = { version: 12, servers: srv, ...s };
        try {
          validateConfig(JSON.parse(JSON.stringify(cfg)));
        } catch (err) {
          invalid(err);
          return;
        }
        accepted.f3++;
        expect(validateSchema(cfg), `${JSON.stringify(cfg)}: ${JSON.stringify(validateSchema.errors?.slice(0, 2))}`).toBe(true);
      }),
      { numRuns: RUNS, seed: 1493 },
    );
    expect(accepted.f3).toBeGreaterThan(RUNS / 20);
  });
});

describe('F4 gitops config hash', () => {
  const shuffle = (v: unknown): unknown => (Array.isArray(v) ? v.map(shuffle) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v as object).reverse().map(([k, x]) => [k, shuffle(x)])) : v);
  it('is independent of key order and changes with any value', () => {
    fc.assert(
      fc.property(fc.dictionary(fc.string({ maxLength: 5 }), fc.jsonValue({ maxDepth: 3 })), fc.string({ minLength: 1, maxLength: 5 }), (o, k) => {
        expect(configHash(shuffle(o))).toBe(configHash(o));
        expect(canonicalJson(shuffle(o))).toBe(canonicalJson(o));
        const changed = { ...o, [`__${k}`]: 'x' };
        expect(configHash(changed)).not.toBe(configHash(o));
      }),
      { numRuns: RUNS, seed: 1494 },
    );
  });
});

describe('F5 routing splits', () => {
  const ids = ['a', 'b', 'c'];
  const split = fc.record({
    name: fc.constantFrom('s1', 's2'),
    server: fc.constantFrom(...ids),
    sticky: fc.constantFrom('client', 'none', undefined),
    variants: fc.array(fc.record({ server: fc.constantFrom(...ids), weight: fc.integer({ min: 0, max: 5 }) }), { minLength: 1, maxLength: 3 }),
  });
  it('a decision only targets a configured variant with weight > 0 (else the baseline); sticky clients get one variant', () => {
    fc.assert(
      fc.property(fc.array(split, { minLength: 1, maxLength: 3 }), fc.constantFrom(...ids), fc.string({ maxLength: 6 }), fc.double({ min: 0, max: 0.999999, noNaN: true }), (splits, target, client, rnd) => {
        let cfg: any;
        try {
          cfg = validateConfig({ servers: ids.map(server), routing: { splits } });
        } catch (err) {
          invalid(err);
          return;
        }
        const router = new SmartRouter(() => cfg.routing, { random: () => rnd });
        const d = router.route(target, 'tool', client || undefined);
        const sp = router.splitFor(target, 'tool');
        if (!sp) return void expect(d).toBeUndefined();
        expect(d).toBeDefined();
        const live = sp.variants.filter((v: any) => v.weight > 0).map((v: any) => v.server);
        if (live.length) expect(live).toContain(d!.server);
        else expect(d!.server).toBe(sp.server);
        if ((sp.sticky ?? 'client') === 'client' && client) {
          const again = new SmartRouter(() => cfg.routing, { random: () => (rnd + 0.5) % 1 }).route(target, 'tool', client);
          expect(again!.server).toBe(d!.server);
        }
      }),
      { numRuns: RUNS * 2, seed: 1495 },
    );
  });
});
