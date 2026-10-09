// 11.0: schema v11 only, lazy modular kernel by default, workflows removed; `migrate --to 11` from v10 configs.
import { describe, it, expect, afterEach } from 'vitest';
import { parse } from 'yaml';
import { validateConfig, generateDefaultConfig } from '../src/config/loader.js';
import { configDeprecations, removedConfigKeys, DEPRECATIONS } from '../src/utils/deprecations.js';
import { migrateConfigText, workflowToTaskGraph } from '../src/config/migrate.js';
import { isFeatureActive, moduleMode, FEATURE_ACTIVATION, FEATURE_CONFIG_KEYS } from '../src/gateway/features.js';
import { distributedConfig } from '../src/gateway/control-plane.js';
import { listFeatures } from '../src/features/index.js';
import { taskRuns } from '../src/features/task-graphs.js';
import { resetJournal } from '../src/features/time-travel.js';
import * as root from '../src/index.js';
import { startFeatureGw, type FeatureGw } from './helpers/feature-gw.js';
import type { GatewayConfig } from '../src/utils/types.js';

let fx: FeatureGw | undefined;
afterEach(async () => {
  await fx?.stop();
  fx = undefined;
  taskRuns.reset();
  resetJournal();
});

const WF = `version: 10
servers: []
features:
  # enrichment pipeline
  workflows:
    - id: enrich
      concurrency: 2
      nodes:
        - { id: a, tool: fake/echo, args: { q: "{{input.q}}" }, retry: { attempts: 3, backoffMs: 100 } }
        - { id: b, tool: fake/echo, needs: [a], args: { from: "{{nodes.a.text}}" }, onError: continue }
      output: "{{nodes.b.text}}"
  chaos: { enabled: false }
`;

describe('11.0: schema v11 only', () => {
  it('refuses schema v10 and workflows with a message naming migrate --to 11; nothing is deprecated', () => {
    expect(() => validateConfig({ version: 10, servers: [] })).toThrow(/version: config schema v10 was removed in 11.0 — use `version: 11`; run `mcp-gateway migrate --to 11`/);
    expect(() => validateConfig({ version: 11, servers: [], features: { workflows: [] } })).toThrow(/features.workflows: removed in 11.0 — use `features.taskGraphs`; run `mcp-gateway migrate --to 11`/);
    expect(removedConfigKeys({ features: { workflows: [] } })).toEqual([expect.stringMatching(/^features.workflows: removed in 11.0/)]);
    expect(() => validateConfig({ version: 9, servers: [] })).toThrow(/use `version: 11`/);
    expect(() => validateConfig({ version: 12, servers: [] })).toThrow(/11.0 reads `version: 11`/);
    expect(validateConfig({ version: 11, servers: [] }).deprecations).toBeUndefined();
    expect(validateConfig({ servers: [] }).deprecations).toBeUndefined(); // no version = v11
    expect(configDeprecations({})).toEqual([]);
    expect(DEPRECATIONS).toEqual({});
    expect(parse(generateDefaultConfig()).version).toBe(11);
    expect(distributedConfig({ servers: [], port: 1 }).version).toBe(11);
  });

  it('the workflow engine is gone: no module, no config key, no root exports; topoLayers moved to task graphs', () => {
    expect(listFeatures().map((f) => f.id)).not.toContain('workflows');
    expect((FEATURE_CONFIG_KEYS as readonly string[]).includes('workflows')).toBe(false);
    expect(FEATURE_ACTIVATION.workflows).toBeUndefined();
    const r = root as Record<string, unknown>;
    expect(r.runWorkflow).toBeUndefined();
    expect(r.WorkflowsSchema).toBeUndefined();
    expect((r.topoLayers as (n: unknown[]) => string[][])([{ id: 'a', needs: [] }, { id: 'b', needs: ['a'] }])).toEqual([['a'], ['b']]);
  });
});

describe('11.0: lazy modular kernel', () => {
  it('lazy by default, kernel.modules: eager restores 10.x; every keyed module maps to a real section', () => {
    expect(moduleMode({ servers: [] } as GatewayConfig)).toBe('lazy');
    expect(moduleMode({ version: 11, servers: [] } as GatewayConfig)).toBe('lazy');
    expect(moduleMode({ version: 11, kernel: { modules: 'eager' }, servers: [] } as GatewayConfig)).toBe('eager');
    const lazy = { version: 11, servers: [], timeTravel: {} } as unknown as GatewayConfig;
    expect(isFeatureActive(lazy, 'time-travel')).toBe(true);
    expect(isFeatureActive(lazy, 'chaos')).toBe(false);
    expect(isFeatureActive(lazy, 'kernel')).toBe(true); // core
    expect(isFeatureActive(lazy, 'some-plugin-hook')).toBe(true);
    const ids = new Set(listFeatures().map((f) => f.id));
    for (const [id, keys] of Object.entries(FEATURE_ACTIVATION)) {
      expect(ids.has(id), id).toBe(true);
      for (const k of keys) expect((FEATURE_CONFIG_KEYS as readonly string[]).includes(k as string), `${id}: ${String(k)}`).toBe(true);
    }
  });

  it('unconfigured modules answer 404 (after auth), configured ones work, reload mounts and unmounts', async () => {
    fx = await startFeatureGw({ version: 11, timeTravel: {} } as never);
    expect((await fx.admin('time-travel')).status).toBe(200);
    const off = await fx.admin('realtime-budgets');
    expect(off.status).toBe(404);
    expect(off.body.message).toMatch(/kernel.modules is lazy and features.realtimeBudgets is not configured/);
    expect((await fx.admin('realtime-budgets', undefined, 'GET', {})).status).toBe(401); // auth runs first
    expect((await fx.admin('kernel')).status).toBe(200);
    const list = await fx.admin('features');
    expect(list.body.modules).toBe('lazy');
    expect(list.body.features.find((f: { id: string }) => f.id === 'chaos').active).toBe(false);
    await fetch(`${fx.base}/api/v1/tools/call`, { method: 'POST', headers: { authorization: 'Bearer op', 'content-type': 'application/json' }, body: JSON.stringify({ server: 'fake', tool: 'echo', arguments: {} }) });
    expect((await fx.admin('time-travel')).body.calls).toBe(1);
    await fx.gw.reload({ ...(fx.gw as any).config, realtimeBudgets: { budgets: [{ name: 'b', metric: 'cost', limit: 1 }] } } as never); // eslint-disable-line @typescript-eslint/no-explicit-any
    expect((await fx.admin('realtime-budgets')).status).toBe(200);
    await fx.gw.reload({ ...(fx.gw as any).config, realtimeBudgets: undefined } as never); // eslint-disable-line @typescript-eslint/no-explicit-any
    expect((await fx.admin('realtime-budgets')).status).toBe(404);
  });

  it('kernel.modules: eager mounts every module (10.x behaviour)', async () => {
    fx = await startFeatureGw({ version: 11, kernel: { modules: 'eager' } } as never);
    expect((await fx.admin('realtime-budgets')).status).toBe(400); // mounted, "not configured"
    expect((await fx.admin('features')).body.modules).toBe('eager');
  });
});

describe('11.0: migrate --to 11 (from a 10.x config)', () => {
  it('sets version 11, converts workflows into task graphs, keeps other comments, notes API and activation changes', () => {
    const r = migrateConfigText(WF, 'yaml');
    expect(r.changes).toEqual(['version: 10 → 11', 'features.workflows (1) → features.taskGraphs.graphs']);
    expect(r.notes.join('\n')).toMatch(/POST \/api\/v1\/admin\/task-graphs\/run/);
    expect(r.notes.join('\n')).toMatch(/kernel: \{ modules: eager \}/);
    expect(r.text).toContain('# enrichment pipeline');
    const cfg = validateConfig(parse(r.text));
    expect(cfg.version).toBe(11);
    expect(cfg.deprecations).toBeUndefined();
    expect(cfg.chaos).toBeDefined();
    const g = (cfg.taskGraphs as { graphs: Array<Record<string, any>> }).graphs[0]!; // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(g).toMatchObject({ id: 'enrich', concurrency: 2, output: '{{nodes.b.text}}' });
    expect(g.nodes[0]).toMatchObject({ id: 'a', tool: 'fake/echo', retry: { attempts: 3, backoffMs: 100, factor: 2 } });
    expect(g.nodes[1]).toMatchObject({ needs: ['a'], onError: 'continue' });
    expect(migrateConfigText(r.text, 'yaml', 11).changed).toBe(false); // idempotent
    expect(migrateConfigText('version: 11\nservers: []\n', 'yaml', 11).changed).toBe(false);
  });

  it('does not overwrite an existing task graph with the same id; JSON files', () => {
    const r = migrateConfigText(JSON.stringify({ version: 10, servers: [], features: { workflows: [{ id: 'x', nodes: [{ id: 'n', tool: 's/t' }] }], taskGraphs: { graphs: [{ id: 'x', nodes: [{ id: 'm', tool: 's/u' }] }] } } }), 'json');
    expect(r.notes.join(' ')).toMatch(/task graph "x" already exists/);
    const out = JSON.parse(r.text);
    expect(out.version).toBe(11);
    expect(out.features.taskGraphs.graphs).toHaveLength(1);
    expect(workflowToTaskGraph({ id: 'w', nodes: [{ id: 'n', tool: 's/t' }] })).toEqual({ id: 'w', nodes: [{ id: 'n', tool: 's/t' }] });
  });

  it('a converted workflow runs as a task graph', async () => {
    const r = migrateConfigText(WF.replace('version: 10\nservers: []\n', 'version: 10\n'), 'yaml', 11);
    const migrated = validateConfig({ ...parse(r.text), servers: [] });
    fx = await startFeatureGw({ version: 11, taskGraphs: migrated.taskGraphs } as never);
    const run = await fx.admin('task-graphs/run', { graph: 'enrich', input: { q: 'hi' }, wait: true });
    expect(run.body.status).toBe('succeeded');
    expect(run.body.output).toBe('{"from":"{\\"q\\":\\"hi\\"}"}');
  });
});
