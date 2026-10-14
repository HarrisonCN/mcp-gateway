/**
 * 15.9.0-canary.0 (v16 preparation): every removal planned for 16.0.0 (docs/migrating-to-v16.md; proposal) is announced
 * one minor ahead — a `DEPRECATED (removed in 16.0.0)` warning, listed by `mcp-gateway validate` (config.deprecations)
 * and `GET /api/v1/admin/deprecations` — and nothing changes in behaviour:
 *
 *  D1 `plugins[].isolation: worker|process|inline` on a module plugin (alias of `runtime`; 16.0 keeps only `runtime`).
 *     WASM components keep `isolation: tenant|client|shared` (that is not the alias).
 *  D2 module plugins with `runtime: inline` (16.0: an explicit opt-in in config schema v13).
 *  D3 `mcp.protocolVersions` naming `2024-11-05`, and (runtime) a downstream `/mcp` session that negotiates it.
 *  D4 Node.js older than 24 (16.0: `engines.node >= 24`).
 *  D5 the loader lists the config ones for every v12 file; the gateway records them (and D3 / D4) at start.
 */
import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { v16DeprecationsIn, nodeDeprecation, V16_DEPRECATION_IDS } from '../src/config/v16-deprecations.js';
import { validateConfig } from '../src/config/loader.js';
import { resetDeprecations, runtimeDeprecations } from '../src/utils/deprecations.js';
import { startFeatureGw, type FeatureGw } from './helpers/feature-gw.js';

/* eslint-disable @typescript-eslint/no-explicit-any */
let h: FeatureGw | undefined;
beforeEach(() => resetDeprecations());
afterEach(async () => {
  await h?.stop();
  h = undefined;
});
const ids = (list: Array<{ id: string }>) => list.map((d) => d.id).sort();

describe('16.0 removals announced in 15.9 (15.9.0-canary.0)', () => {
  it('D1 the module-plugin `isolation` alias is deprecated; WASM component isolation is not', () => {
    const raw = {
      version: 12,
      plugins: [
        { name: 'a', module: './a.mjs', isolation: 'worker' },
        { name: 'b', module: './b.mjs', isolation: 'process' },
        { name: 'c', module: './c.mjs', runtime: 'worker' },
        { name: 'w', component: './w.wasm', isolation: 'tenant' },
      ],
    };
    const d = v16DeprecationsIn(raw);
    expect(ids(d)).toEqual(['v16.plugins.0.isolation', 'v16.plugins.1.isolation']);
    for (const x of d) {
      expect(x.removedIn).toBe('16.0.0');
      expect(x.replacement).toMatch(/runtime: (worker|process)/);
    }
  });

  it('D2 inline module plugins are announced (runtime: inline or isolation: inline)', () => {
    const d = v16DeprecationsIn({ version: 12, plugins: [{ name: 'i', module: './i.mjs', runtime: 'inline' }, { name: 'j', module: './j.mjs', isolation: 'inline' }, { name: 'k', module: './k.mjs' }] });
    expect(ids(d)).toEqual(['v16.plugins.0.inline', 'v16.plugins.1.inline', 'v16.plugins.1.isolation']);
    expect(d.find((x) => x.id === 'v16.plugins.0.inline')!.message).toMatch(/in the gateway process/);
  });

  it('D3 mcp.protocolVersions naming 2024-11-05 is announced', () => {
    expect(ids(v16DeprecationsIn({ version: 12, mcp: { protocolVersions: ['2025-06-18', '2024-11-05'] } }))).toEqual(['v16.mcp.protocol-2024-11-05']);
    expect(v16DeprecationsIn({ version: 12, mcp: { protocolVersions: ['2025-06-18'] } })).toEqual([]);
    expect(v16DeprecationsIn({ version: 12 })).toEqual([]);
    expect(v16DeprecationsIn(null)).toEqual([]);
  });

  it('D4 Node.js < 24 is announced, 24+ is not', () => {
    expect(nodeDeprecation('22.23.3')).toMatchObject({ id: 'v16.node.22', removedIn: '16.0.0' });
    expect(nodeDeprecation('v23.1.0')).toMatchObject({ id: 'v16.node.23' });
    expect(nodeDeprecation('24.0.0')).toBeUndefined();
    expect(nodeDeprecation('26.1.0')).toBeUndefined();
  });

  it('D5 validateConfig lists the config deprecations (what `mcp-gateway validate` prints); behaviour unchanged', () => {
    const cfg = validateConfig({ version: 12, servers: [], mcp: { protocolVersions: ['2024-11-05', '2025-06-18'] }, plugins: [{ name: 'a', module: './a.mjs', isolation: 'worker' }] });
    expect(ids(cfg.deprecations ?? [])).toEqual(['v16.mcp.protocol-2024-11-05', 'v16.plugins.0.isolation']);
    expect(cfg.mcp?.protocolVersions).toEqual(['2024-11-05', '2025-06-18']);
    expect(validateConfig({ version: 12, servers: [] }).deprecations).toBeUndefined();
    // every id family is documented
    expect([...V16_DEPRECATION_IDS].sort()).toEqual(['v16.mcp.protocol-2024-11-05', 'v16.node.<major>', 'v16.plugins.<i>.inline', 'v16.plugins.<i>.isolation'].sort());
  });

  it('D6 a /mcp session on 2024-11-05 records the runtime deprecation once; newer revisions do not', async () => {
    h = await startFeatureGw({ mcp: { enabled: true } } as never);
    const init = (v: string) =>
      fetch(`${h!.base}/mcp`, {
        method: 'POST',
        headers: { authorization: 'Bearer op', 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: v, capabilities: {}, clientInfo: { name: 't', version: '1' } } }),
      });
    expect((await init('2025-06-18')).status).toBe(200);
    expect(runtimeDeprecations().map((d) => d.id)).not.toContain('v16.mcp.protocol-2024-11-05');
    expect((await init('2024-11-05')).status).toBe(200);
    expect((await init('2024-11-05')).status).toBe(200);
    const rt = runtimeDeprecations().filter((d) => d.id === 'v16.mcp.protocol-2024-11-05');
    expect(rt).toHaveLength(1);
    const api = (await (await fetch(`${h.base}/api/v1/admin/deprecations`, { headers: { authorization: 'Bearer op' } })).json()) as any;
    expect(api.runtime.map((d: any) => d.id)).toContain('v16.mcp.protocol-2024-11-05');
    // on Node < 24 the start also recorded the runtime announcement
    const major = Number(process.versions.node.split('.')[0]);
    expect(api.runtime.some((d: any) => d.id === `v16.node.${major}`)).toBe(major < 24);
  });
});
