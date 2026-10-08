/** 3.9: v4 deprecations, `mcp-gateway migrate`, benchmarks. */
import { describe, it, expect } from 'vitest';
import { migrateConfigText, migrateConfigObject } from '../src/config/migrate.js';
import { validateConfig } from '../src/config/loader.js';
import { configDeprecations, removedConfigKeys } from '../src/utils/deprecations.js';
import { runBenchmark, summarize, percentile, benchMarkdown } from '../src/bench/index.js';
import { logger } from '../src/utils/logger.js';

logger.setLevel('error');

const V3 = `# my gateway
version: 3
auth:
  strategy: api-key
  apiKeys:
    - name: ci        # the CI bot
      key: \${CI_KEY}
      servers: ["github"]
      rateLimit: { limit: 10, windowSeconds: 60 }
    - name: ops
      key: ops-key
servers:
  - id: search
    name: Search
    transport: streamable-http
    url: https://a.example/mcp
    replicas: [{ url: https://b.example/mcp }]
    loadBalancing:
      strategy: least-latency   # fastest first
plugins:
  - module: ./audit.mjs
`;

describe('4.0 removals (were 3.9 deprecations)', () => {
  it('rejects the v3 forms with the migration hint', () => {
    const raw = { version: 3, auth: { strategy: 'api-key', apiKeys: [{ name: 'ci', key: 'k', servers: ['x'] }, 'plain'] }, servers: [{ id: 's', loadBalancing: { strategy: 'least-latency' } }] };
    const errs = removedConfigKeys(raw);
    expect(errs).toHaveLength(3);
    expect(errs[0]).toMatch(/version: config schema v3 was removed in 4.0/);
    expect(errs[1]).toMatch(/auth.apiKeys.0: servers directly on an API key was removed in 4.0/);
    expect(errs[2]).toMatch(/servers.0.loadBalancing.strategy: least-latency was removed/);
    expect(() => validateConfig(raw)).toThrow(/mcp-gateway migrate/);
    expect(configDeprecations(raw)).toEqual([]);
  });

  it('reads nested key scope (schema v7 or version omitted)', () => {
    const cfg = validateConfig({ version: 8, servers: [], auth: { strategy: 'api-key', apiKeys: [{ name: 'ci', key: 'k', scope: { servers: ['github'], rateLimit: { limit: 1, windowSeconds: 1 } } }] } });
    expect(cfg.auth!.apiKeys![0]).toMatchObject({ name: 'ci', servers: ['github'], rateLimit: { limit: 1, windowSeconds: 1 } });
    expect(cfg.deprecations).toBeUndefined(); // 8.0
    expect(() => validateConfig({ servers: [], auth: { strategy: 'api-key', apiKeys: [{ key: 'k', servers: ['a'], scope: { servers: ['b'] } }] } })).toThrow(/removed in 4.0/);
    expect(() => validateConfig({ servers: [], auth: { strategy: 'api-key', apiKeys: [{ key: 'k', scope: { nope: 1 } }] } })).toThrow(/unknown key/);
    expect(() => validateConfig({ version: 9, servers: [] })).toThrow(/not supported/);
    expect(validateConfig({ servers: [] }).deprecations).toBeUndefined();
  });
});

describe('mcp-gateway migrate', () => {
  it('rewrites YAML to v4, keeping comments', () => {
    const r = migrateConfigText(V3, undefined, 4);
    expect(r.changed).toBe(true);
    expect(r.changes).toEqual([
      'version: 3 → 4',
      'auth.apiKeys[0] (ci): servers, rateLimit → scope',
      'servers[0] (search): loadBalancing.strategy least-latency → smart (latency-only score)',
    ]);
    expect(r.notes[0]).toMatch(/apiVersion: 3/);
    expect(r.text).toContain('# my gateway');
    expect(r.text).toContain('# the CI bot');
    expect(r.text).toContain('version: 4');
    expect(r.text).toContain('${CI_KEY}');
    process.env.CI_KEY = 'ci-key-value';
    // 5.x reads v5 only: finish the migration (v4 → v5).
    const cfg = validateConfig(JSON.parse(JSON.stringify(await_yaml(migrateConfigText(r.text).text))));
    expect(cfg.deprecations).toBeUndefined(); // migrated straight to v8
    expect(cfg.auth!.apiKeys![0]).toMatchObject({ servers: ['github'], rateLimit: { limit: 10, windowSeconds: 60 } });
    expect(cfg.servers[0]!.loadBalancing).toMatchObject({ strategy: 'smart', score: { latency: 1, errorRate: 0, cost: 0 } });
    // Idempotent.
    expect(migrateConfigText(r.text, undefined, 4).changed).toBe(false);
  });

  it('handles JSON and files without a version', () => {
    const { config, changes } = migrateConfigObject({ servers: [], auth: { strategy: 'api-key', apiKeys: [{ key: 'k', tools: ['a*'] }] } });
    expect(changes[0]).toBe('version: (none) → 8');
    expect(Object.keys(config)[0]).toBe('version');
    expect((config.auth as { apiKeys: Array<Record<string, unknown>> }).apiKeys[0]).toEqual({ key: 'k', scope: { tools: ['a*'] } });
    expect(() => migrateConfigText('a: [', 'yaml')).toThrow(/Cannot parse/);
    expect(() => migrateConfigText('version: 3', 'yaml', 9)).toThrow(/v4, v5, v6, v7 or v8/);
    expect(() => migrateConfigText('version: 5', 'yaml', 4)).toThrow(/downgrading/);
  });
});

import { parse as parseYaml } from 'yaml';
function await_yaml(t: string): unknown {
  return parseYaml(t);
}

describe('benchmarks', () => {
  it('summarises latencies', () => {
    expect(percentile([1, 2, 3, 4], 0.5)).toBe(2);
    expect(percentile([], 0.9)).toBe(0);
    const s = summarize('rest', [3, 1, 2, 4], 1, 1000);
    expect(s).toMatchObject({ requests: 4, errors: 1, rps: 4, meanMs: 2.5, p50Ms: 2, p99Ms: 4, maxMs: 4 });
  });

  it('runs a short in-process benchmark', async () => {
    const r = await runBenchmark({ durationMs: 300, warmupMs: 100, concurrency: 4, scenarios: ['rest', 'cache', 'mcp'] });
    expect(r.results.map((x) => x.scenario)).toEqual(['rest', 'cache', 'mcp']);
    for (const x of r.results) {
      expect(x.requests, x.scenario).toBeGreaterThan(0);
      expect(x.errors, x.scenario).toBe(0);
    }
    expect(benchMarkdown(r)).toContain('| cache |');
  }, 30_000);
});
