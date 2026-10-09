/** 9.2: edge WASM runtime 2.0. */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { startFeatureGw, type FeatureGw } from './helpers/feature-gw.js';
import { validateConfig } from '../src/config/loader.js';
import { edgeRuntimeState, ERR_EDGE_RUNTIME } from '../src/features/edge-runtime.js';
import { respondWasm, loopWasm, counterWasm } from './fixtures/wasm-plugins.js';

let h: FeatureGw | undefined;
afterEach(async () => {
  await h?.stop();
  h = undefined;
  await edgeRuntimeState.reset();
});
const dir = mkdtempSync(join(tmpdir(), 'mgw-edge-'));
const file = (name: string, bytes: Uint8Array) => {
  const p = join(dir, name);
  writeFileSync(p, bytes);
  return p;
};
const call = async (name: string, args: unknown = {}) => {
  const r = await fetch(`${h!.base}/api/v1/features/edge-runtime/tools/${name}/call`, { method: 'POST', headers: { authorization: 'Bearer scoped', 'content-type': 'application/json' }, body: JSON.stringify({ arguments: args }) });
  return { status: r.status, body: (await r.json()) as any };
};

describe('edge WASM runtime 2.0 (9.2)', () => {
  it('validates tools', () => {
    expect(() => validateConfig({ version: 9, servers: [], edgeRuntime: { tools: [{ name: 'a', wasm: 'a.wasm', warm: 5, limits: { maxConcurrent: 2 } }] } })).toThrow(/warm must not exceed/);
    expect(() => validateConfig({ version: 9, servers: [], edgeRuntime: { tools: [{ name: 'a', wasm: 'x' }, { name: 'a', wasm: 'y' }] } })).toThrow(/duplicate edge tool/);
    expect(() => validateConfig({ version: 9, servers: [], edgeRuntime: { tools: [{ name: 'a', wasm: 'x', sha256: 'abc' }] } })).toThrow();
    expect(ERR_EDGE_RUNTIME).toBe(-32023);
  });

  it('runs a pinned WASM tool from a warm pool, reuses instances, lists tools', async () => {
    const bytes = respondWasm();
    const sha = createHash('sha256').update(bytes).digest('hex');
    h = await startFeatureGw({ edgeRuntime: { tools: [
      { name: 'hello', wasm: file('hello.wasm', bytes), sha256: sha, export: 'on_tool_call', description: 'says hi', warm: 1 },
      { name: 'count', wasm: file('count.wasm', counterWasm()), export: 'on_tool_call', warm: 0, limits: { maxConcurrent: 1 } },
    ] } } as never);
    const list = await fetch(`${h.base}/api/v1/features/edge-runtime/tools`, { headers: { authorization: 'Bearer scoped' } });
    expect(((await list.json()) as any).tools.map((t: any) => t.name)).toEqual(['hello', 'count']);
    const r = await call('hello');
    expect(r.status).toBe(200);
    expect(JSON.stringify(r.body.result)).toContain('from wasm');
    const c1 = await call('count');
    const c2 = await call('count');
    expect(c1.body.cold).toBe(true);
    expect(c2.body.cold).toBe(false);
    expect(JSON.stringify(c2.body.result)).toContain('\\"n\\":\\"2\\"'); // same instance: counter kept
    const a = await h.admin('edge-runtime');
    const hello = a.body.tools.find((t: any) => t.name === 'hello');
    expect(hello).toMatchObject({ loaded: true, pinned: true, sha256: sha, calls: 1, errors: 0 });
    expect(a.body.tools.find((t: any) => t.name === 'count')).toMatchObject({ calls: 2, coldStarts: 1 });
    expect((await call('nope')).status).toBe(404);
  });

  it('refuses a pin mismatch, times out runaway modules and replaces them', async () => {
    h = await startFeatureGw({ edgeRuntime: { tools: [
      { name: 'bad-pin', wasm: file('p.wasm', respondWasm()), sha256: 'a'.repeat(64), export: 'on_tool_call', warm: 0 },
      { name: 'loop', wasm: file('loop.wasm', loopWasm()), export: 'on_tool_call', warm: 0, limits: { timeoutMs: 80 } },
    ] } } as never);
    const p = await call('bad-pin');
    expect(p.status).toBe(502);
    expect(p.body.error.code).toBe(ERR_EDGE_RUNTIME);
    expect(p.body.error.message).toContain('sha256 mismatch');
    const l = await call('loop');
    expect(l.body.error.message).toContain('timed out after 80ms');
    expect((await call('loop')).body.error.message).toContain('timed out');
    const a = await h.admin('edge-runtime');
    expect(a.body.tools.find((t: any) => t.name === 'loop')).toMatchObject({ errors: 2, coldStarts: 2 });
    expect((await h.admin('edge-runtime/reload', {})).body.reloaded).toEqual([{ name: 'bad-pin', loaded: false, error: expect.stringContaining('sha256') }, { name: 'loop', loaded: true, error: null }]);
  });
});
