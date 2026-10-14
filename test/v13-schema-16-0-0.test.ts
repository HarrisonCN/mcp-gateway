/**
 * 16.0.0-alpha.1 (development prerelease; the 16.0 list is a proposal until 16.0.0-rc.1, docs/v16/freeze.md):
 *
 *  S1 config schema v13 (`version: 13`) loads; `config.schemaVersion` is 13.
 *  S2 v13 refuses the module-plugin `isolation` alias (only `runtime`); WASM component `isolation` stays.
 *  S3 v13 runs an inline module plugin only with `allowInline: true` on its entry; `allowInline` elsewhere is an error.
 *  S4 v13 refuses `mcp.protocolVersions` naming 2024-11-05; a v12 file naming it still loads (the revision is ignored, reported).
 *  S5 an explicit `version: 12` file loads (in-memory migration) and reports `schema.v12` (removed in 17.0.0); an
 *     unversioned file is read as v12 without that notice (decided in alpha.2: v12 in 16.x, v13 in 17.0 — test/v13-tooling-16-0-2.test.ts J6).
 *  S6 /mcp no longer negotiates 2024-11-05 (a client asking for it gets the newest revision); 2025-03-26 is still
 *     honoured; the upstream side (adapting results for 2024-11-05 servers) is unchanged.
 *  S7 `config migrate --to v13` writes `version: 13`: `isolation` → `runtime`, `allowInline: true` on inline module
 *     plugins, 2024-11-05 dropped from `mcp.protocolVersions`; the result loads as v13; idempotent.
 *  S8 package.json `engines.node` is `>=24`.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { validateConfig } from '../src/config/loader.js';
import { planV13 } from '../src/config/v13-prep.js';
import { adaptToolResult, PROTOCOL_VERSIONS } from '../src/mcp/compat.js';
import { DOWNSTREAM_PROTOCOL_VERSIONS } from '../src/mcp/endpoint.js';
import { startFeatureGw, op, type FeatureGw } from './helpers/feature-gw.js';

/* eslint-disable @typescript-eslint/no-explicit-any */
const ROOT = join(__dirname, '..');
const err = (raw: unknown): string => {
  try {
    validateConfig(raw);
    return '';
  } catch (e) {
    return (e as Error).message;
  }
};
const ids = (c: any): string[] => (c.deprecations ?? []).map((d: any) => d.id).sort();
let h: FeatureGw | undefined;
afterEach(async () => {
  await h?.stop();
  h = undefined;
});

describe('config schema v13 (16.0.0-alpha.1)', () => {
  it('S1 a version: 13 file loads as schema v13', () => {
    const c = validateConfig({ version: 13, plugins: [{ module: './a.mjs', runtime: 'worker' }] }) as any;
    expect(c.schemaVersion).toBe(13);
    expect(c.plugins[0].runtime).toBe('worker');
    expect(ids(c)).toEqual([]);
  });

  it('S2 v13 refuses the module-plugin isolation alias; WASM component isolation stays', () => {
    expect(err({ version: 13, plugins: [{ module: './a.mjs', isolation: 'worker' }] })).toMatch(/plugins\.0\.isolation.*schema v13.*runtime: worker/s);
    expect(err({ version: 13, plugins: [{ component: './w.wasm', isolation: 'tenant' }] })).toBe('');
  });

  it('S3 v13 inline module plugins need allowInline: true on the entry', () => {
    expect(err({ version: 13, plugins: [{ module: './a.mjs', runtime: 'inline' }] })).toMatch(/plugins\.0.*allowInline: true/s);
    expect(err({ version: 13, plugins: [{ module: './a.mjs', runtime: 'inline', allowInline: true }] })).toBe('');
    expect(err({ version: 13, plugins: [{ module: './a.mjs', runtime: 'worker', allowInline: true }] })).toMatch(/plugins\.0\.allowInline.*runtime: inline/s);
  });

  it('S4 v13 refuses /mcp revision 2024-11-05; a v12 file naming it still loads and reports it', () => {
    expect(err({ version: 13, mcp: { protocolVersions: ['2025-06-18', '2024-11-05'] } })).toMatch(/mcp\.protocolVersions.*2024-11-05/s);
    const c = validateConfig({ version: 12, mcp: { protocolVersions: ['2025-06-18', '2024-11-05'] } }) as any;
    expect(ids(c)).toContain('v16.mcp.protocol-2024-11-05');
  });

  it('S5 an explicit v12 file reports schema.v12 (removed in 17.0.0); an unversioned file does not', () => {
    const c = validateConfig({ version: 12 }) as any;
    expect(c.schemaVersion).toBe(12);
    const d = (c.deprecations ?? []).find((x: any) => x.id === 'schema.v12');
    expect(d?.removedIn).toBe('17.0.0');
    expect(d?.message).toMatch(/config migrate --to v13/);
    expect(ids(validateConfig({}))).toEqual([]);
  });

  it('S6 /mcp no longer negotiates 2024-11-05; upstream adaptation is unchanged', async () => {
    expect(DOWNSTREAM_PROTOCOL_VERSIONS).toEqual(['2025-11-25', '2025-06-18', '2025-03-26']);
    expect(PROTOCOL_VERSIONS).toContain('2024-11-05'); // upstream servers (HTTP+SSE) stay supported
    expect(adaptToolResult({ content: [], structuredContent: { a: 1 } }, '2024-11-05')).not.toHaveProperty('structuredContent');
    h = await startFeatureGw({});
    const init = async (v: string) => {
      const r = await fetch(`${h!.base}/mcp`, { method: 'POST', headers: { ...op, accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: v, capabilities: {}, clientInfo: { name: 't', version: '1' } } }) });
      const text = await r.text();
      const body = JSON.parse(text.startsWith('{') ? text : text.split('\n').find((l) => l.startsWith('data:'))!.slice(5));
      return body.result.protocolVersion as string;
    };
    expect(await init('2024-11-05')).toBe('2025-11-25');
    expect(await init('2025-03-26')).toBe('2025-03-26');
  });

  it('S7 config migrate --to v13 writes a v13 file that loads, and is idempotent', () => {
    const src = `version: 12
plugins:
  - module: ./a.mjs   # keep me
    isolation: worker
  - module: ./b.mjs
    runtime: inline
  - component: ./w.wasm
    isolation: tenant
mcp:
  protocolVersions: ['2025-06-18', '2024-11-05']
`;
    const r = planV13(src, 'yaml');
    expect(r.ok).toBe(true);
    expect(r.text).toMatch(/^version: 13$/m);
    expect(r.text).toContain('# keep me');
    const out = parse(r.text);
    expect(out.plugins[0]).toEqual({ module: './a.mjs', runtime: 'worker' });
    expect(out.plugins[1]).toEqual({ module: './b.mjs', runtime: 'inline', allowInline: true });
    expect(out.plugins[2]).toEqual({ component: './w.wasm', isolation: 'tenant' });
    expect(out.mcp.protocolVersions).toEqual(['2025-06-18']);
    const c = validateConfig(out) as any;
    expect(c.schemaVersion).toBe(13);
    expect(ids(c)).toEqual([]);
    const again = planV13(r.text, 'yaml');
    expect(again.ok).toBe(true);
    expect(again.changes).toEqual([]);
    expect(again.text).toBe(r.text);
    // a list that only named 2024-11-05 is removed (all supported revisions are accepted again)
    const only = parse(planV13('version: 12\nmcp:\n  protocolVersions: [\'2024-11-05\']\n', 'yaml').text);
    expect(only.mcp?.protocolVersions).toBeUndefined();
  });

  it('S8 engines.node >= 24', () => {
    expect(JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).engines.node).toBe('>=24.0.0');
  });
});
