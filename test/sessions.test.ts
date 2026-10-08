import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { recordFrom, replayRecording, grade, shapeOf, parseSteps, RecordingStore, type Recording } from '../src/features/sessions.js';
import type { CapturedCall } from '../src/gateway/replay.js';
import { startFeatureGw, op, type FeatureGw } from './helpers/feature-gw.js';

let h: FeatureGw | undefined;
const dirs: string[] = [];
afterEach(async () => {
  await h?.stop();
  h = undefined;
  dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true }));
});

const call = (over: Partial<CapturedCall>): CapturedCall => ({ id: 'x', timestamp: '2026-01-01T00:00:00.000Z', serverId: 's', tool: 't', kind: 'tool', via: 'rest', durationMs: 5, success: true, arguments: {}, ...over });

describe('session recording and evals (5.5)', () => {
  it('records from captured calls with filters', () => {
    const calls = [
      call({ clientId: 'a', tool: 'one', result: { ok: 1 } }),
      call({ clientId: 'b', tool: 'two' }),
      call({ clientId: 'a', tool: 'three', arguments: undefined, truncated: true }),
      call({ clientId: 'a', tool: 'four', replayOf: 'z' }),
      call({ clientId: 'a', tool: 'five', kind: 'resource' }),
      call({ clientId: 'a', tool: 'six', timestamp: '2026-02-01T00:00:00.000Z' }),
    ];
    expect(recordFrom(calls, { name: 'r', clientId: 'a' }).steps.map((s) => s.tool)).toEqual(['one', 'six']);
    expect(recordFrom(calls, { name: 'r', until: '2026-01-15T00:00:00Z' }).steps.map((s) => s.tool)).toEqual(['one', 'two']);
    expect(recordFrom(calls, { name: 'r', since: '2026-01-15T00:00:00Z', tools: ['six'] }).steps).toHaveLength(1);
  });

  it('grades success / structure / exact', () => {
    const step = { serverId: 's', tool: 't', arguments: {}, result: { a: 1, b: ['x'] }, success: true };
    expect(grade(step, { success: false, error: { message: 'boom' } }, 'success')).toEqual({ passed: false, reason: 'failed: boom' });
    expect(grade(step, { success: true, result: { a: 2, b: ['y'] } }, 'structure').passed).toBe(true);
    expect(grade(step, { success: true, result: { a: '2', b: ['y'] } }, 'structure')).toMatchObject({ passed: false, reason: 'result shape changed' });
    expect(grade(step, { success: true, result: { a: 2, b: ['x'] } }, 'exact')).toMatchObject({ passed: false, diff: [{ path: 'a' }] });
    expect(grade({ ...step, success: false }, { success: true }, 'success').passed).toBe(false);
    expect(grade({ ...step, success: false }, { success: false }, 'exact').passed).toBe(true);
    expect(shapeOf({ b: null, a: [1] })).toEqual({ a: ['number'], b: 'null' });
  });

  it('replays with stopOnFailure and survives a throwing invoker', async () => {
    const rec: Recording = { name: 'r', createdAt: '', steps: [{ serverId: 's', tool: 'a', arguments: {}, success: true, durationMs: 3 }, { serverId: 's', tool: 'b', arguments: {}, success: true }, { serverId: 's', tool: 'c', arguments: {}, success: true }] };
    const inv = async (_s: string, t: string) => { if (t === 'b') throw new Error('down'); return { success: true, durationMs: 1 }; };
    const r = await replayRecording(rec, inv, { stopOnFailure: true });
    expect(r).toMatchObject({ steps: 3, passed: 1, failed: 1, skipped: 1, latency: { recordedMs: 3 } });
    expect(r.outcomes[1]!.reason).toBe('failed: down');
    expect((await replayRecording({ ...rec, steps: [] }, inv)).passRate).toBe(1);
  });

  it('validates imported steps', () => {
    expect(parseSteps('x')).toMatch(/array/);
    expect(parseSteps([{ tool: 't' }])).toMatch(/steps\[0\]/);
    expect(parseSteps([{ serverId: 's', tool: 't', arguments: [] }])).toMatch(/arguments must be an object/);
    expect(parseSteps([{ serverId: 's', tool: 't', success: false, durationMs: 2 }])).toEqual([{ serverId: 's', tool: 't', arguments: {}, success: false, durationMs: 2 }]);
  });

  it('persists recordings to a directory and enforces the limit', async () => {
    const d = mkdtempSync(join(tmpdir(), 'mgw-rec-'));
    dirs.push(d);
    const s1 = new RecordingStore(() => d, () => 1);
    await s1.put({ name: 'a', createdAt: '1', steps: [] });
    await expect(s1.put({ name: 'b', createdAt: '2', steps: [] })).rejects.toThrow(/limit/);
    const s2 = new RecordingStore(() => d, () => 5);
    expect((await s2.list()).map((r) => r.name)).toEqual(['a']);
    expect(await s2.delete('a')).toBe(true);
    expect(existsSync(join(d, 'a.json'))).toBe(false);
  });

  it('records a live session, replays it and catches a regression', async () => {
    h = await startFeatureGw({ replay: { enabled: true } } as never);
    expect((await h.admin('sessions', { name: 'nope' })).status).toBe(422);
    for (const hello of ['one', 'two']) {
      const r = await fetch(`${h.base}/api/v1/tools/call`, { method: 'POST', headers: op, body: JSON.stringify({ tool: 'echo', server: 'fake', arguments: { hello } }) });
      expect(r.status).toBe(200);
    }
    const rec = await h.admin('sessions', { name: 'flow', clientId: undefined });
    expect(rec.status).toBe(201);
    expect(rec.body.steps).toBe(2);
    expect((await h.admin('sessions')).body.recordings[0]).toMatchObject({ name: 'flow', tools: ['echo'] });
    const ok = await h.admin('sessions/flow/replay', { mode: 'exact' });
    expect(ok.body).toMatchObject({ passed: 2, failed: 0, passRate: 1 });
    // an imported recording with a stale expectation fails in exact mode, passes in structure mode
    const exp = (await h.admin('sessions/flow')).body as Recording;
    (exp.steps[0]!.result as any).content[0].text = 'stale';
    expect((await h.admin('sessions/old', { steps: exp.steps }, 'PUT')).status).toBe(201);
    expect((await h.admin('sessions/old/replay', { mode: 'exact' })).body.failed).toBe(1);
    expect((await h.admin('sessions/old/replay', { mode: 'structure' })).body.failed).toBe(0);
    expect((await h.admin('sessions/old/replay', { mode: 'bogus' })).status).toBe(400);
    expect((await h.admin('sessions/bad name', { steps: [] }, 'PUT')).status).toBe(400);
    expect((await h.admin('sessions/x', { steps: 1 }, 'PUT')).status).toBe(400);
    expect((await h.admin('sessions/old', undefined, 'DELETE')).body.deleted).toBe(true);
    expect((await h.admin('sessions/old')).status).toBe(404);
    expect((await h.admin('sessions/old/replay', {})).status).toBe(404);
    expect((await h.admin('sessions', { name: '' })).status).toBe(400);
  });

  it('refuses to record without replay capture', async () => {
    h = await startFeatureGw();
    expect((await h.admin('sessions', { name: 'x' })).status).toBe(409);
    expect((await h.admin('sessions')).body.replayEnabled).toBe(false);
  });
});
