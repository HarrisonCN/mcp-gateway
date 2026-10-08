/** 8.8: chaos testing. */
import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { startFeatureGw, type FeatureGw } from './helpers/feature-gw.js';
import { validateConfig } from '../src/config/loader.js';
import { chaosState, ERR_CHAOS_INJECTED } from '../src/features/chaos.js';

let h: FeatureGw | undefined;
beforeEach(() => chaosState.reset());
afterEach(async () => {
  await h?.stop();
  h = undefined;
});
const call = async (key = 'op') => {
  const t = Date.now();
  const r = await fetch(`${h!.base}/api/v1/tools/call`, { method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: JSON.stringify({ server: 'fake', tool: 'echo', arguments: {} }) });
  return { text: JSON.stringify(await r.json()), ms: Date.now() - t };
};

describe('chaos testing (8.8)', () => {
  it('validates experiments', () => {
    expect(() => validateConfig({ servers: [], chaos: { experiments: [{ id: 'x', fault: {} }] } })).toThrow(/a fault needs/);
    expect(() => validateConfig({ servers: [], chaos: { experiments: [{ id: 'x', fault: { latencyMs: 1 } }, { id: 'x', fault: { latencyMs: 1 } }] } })).toThrow(/duplicate experiment id/);
    expect(validateConfig({ version: 8, servers: [], chaos: { experiments: [{ id: 'x', fault: { errorRate: 0.5 }, every: 'daily' }] } }).chaos).toBeDefined();
    expect(ERR_CHAOS_INJECTED).toBe(-32021);
  });

  it('injects nothing until started; latency, errors, corruption; client filter; stop', async () => {
    h = await startFeatureGw({
      chaos: { experiments: [
        { id: 'slow', fault: { latencyMs: 150 }, clients: ['key:op*', 'anonymous'] },
        { id: 'errors', fault: { errorRate: 1 } },
        { id: 'corrupt', fault: { corruptRate: 1 } },
      ] },
    } as never);
    let r = await call();
    expect(r.text).not.toContain('chaos');
    expect((await h.admin('chaos/slow/start', {})).body.state).toBe('running');
    r = await call();
    expect(r.ms).toBeGreaterThanOrEqual(140);
    await h.admin('chaos/slow/stop', {});
    await h.admin('chaos/errors/start', { durationSeconds: 60 });
    r = await call();
    expect(r.text).toContain(String(ERR_CHAOS_INJECTED));
    expect(r.text).toContain('injected error (experiment \\"errors\\")');
    await h.admin('chaos/errors/stop', {});
    await h.admin('chaos/corrupt/start', {});
    expect((await call()).text).toContain('corrupted result');
    const st = (await h.admin('chaos')).body.experiments;
    expect(st.map((e: { id: string; state: string }) => `${e.id}:${e.state}`)).toEqual(['slow:idle', 'errors:idle', 'corrupt:running']);
    expect(st[0]).toMatchObject({ injected: { latency: 1 }, calls: 1 });
    expect(st[1]).toMatchObject({ injected: { error: 1 }, errors: 1 });
    expect(st[2]).toMatchObject({ injected: { corrupt: 1 } });
    expect((await h.admin('chaos/stop-all', {})).body.stopped).toEqual(['corrupt']);
    expect((await call()).text).not.toContain('chaos');
    expect((await h.admin('chaos/nope/start', {})).status).toBe(404);
  });

  it('percent sampling, steady-state abort and duration expiry', async () => {
    h = await startFeatureGw({ chaos: { experiments: [{ id: 'half', percent: 50, fault: { errorRate: 1 }, abortIfErrorRateAbove: 0.4, minCallsForAbort: 4 }, { id: 'short', fault: { latencyMs: 1 }, durationSeconds: 1 }] } } as never);
    const seq = [0.1, 0.9, 0.2, 0.0, 0.3, 0.0];
    chaosState.random = () => seq.shift() ?? 0.99;
    await h.admin('chaos/half/start', {});
    const out = [];
    for (let i = 0; i < 4; i++) out.push((await call()).text.includes('chaos'));
    expect(out).toEqual([true, false, true, true]);
    const half = (await h.admin('chaos')).body.experiments[0];
    expect(half.state).toBe('aborted');
    expect(half.reason).toMatch(/steady-state guard: error rate 0.75 > 0.4/);
    await h.admin('chaos/short/start', { durationSeconds: 1 });
    await new Promise((r) => setTimeout(r, 1100));
    expect((await h.admin('chaos')).body.experiments[1]).toMatchObject({ state: 'idle', reason: 'duration elapsed' });
  });
});
