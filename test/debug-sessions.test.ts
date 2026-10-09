/** 8.3: live collaborative debugging. */
import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { startFeatureGw, type FeatureGw } from './helpers/feature-gw.js';
import { validateConfig } from '../src/config/loader.js';
import { debugState, hits, ERR_DEBUG_ABORTED } from '../src/features/debug-sessions.js';

let h: FeatureGw | undefined;
beforeEach(() => debugState.reset());
afterEach(async () => {
  await h?.stop();
  h = undefined;
});
const callTool = (args: Record<string, unknown>) =>
  fetch(`${h!.base}/api/v1/tools/call`, { method: 'POST', headers: { authorization: 'Bearer op', 'content-type': 'application/json' }, body: JSON.stringify({ server: 'fake', tool: 'echo', arguments: args }) }).then(async (r) => (await r.json()) as any); // eslint-disable-line @typescript-eslint/no-explicit-any
const waitFor = async (fn: () => Promise<boolean>) => {
  for (let i = 0; i < 100; i++) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('timed out');
};

describe('debug sessions (8.3)', () => {
  it('config and breakpoint matching', () => {
    expect(() => validateConfig({ servers: [], features: { debugSessions: { maxSessions: 0 } } })).toThrow();
    expect(validateConfig({ version: 10, servers: [], features: { debugSessions: {} } }).debugSessions).toBeDefined();
    expect(hits({ tool: 'fake/*' }, 'fake/echo', {})).toBe(true);
    expect(hits({ tool: 'fake/echo', when: { path: 'a.b', equals: 2 } }, 'fake/echo', { a: { b: 2 } })).toBe(true);
    expect(hits({ tool: 'fake/echo', when: { path: 'a.b', equals: 2 } }, 'fake/echo', { a: { b: 3 } })).toBe(false);
    expect(ERR_DEBUG_ABORTED).toBe(-32020);
  });

  it('watch, pause, edit + resume, abort, notes, replay, collaborators', async () => {
    h = await startFeatureGw({ debugSessions: { holdTimeoutSeconds: 5 } } as never);
    const s = await h.admin('debug-sessions', { name: 'checkout bug', user: 'alice', match: { tools: ['fake/*'] }, breakpoints: [{ tool: 'fake/echo', when: { path: 'stop', equals: true } }] });
    expect(s.status).toBe(201);
    const id = s.body.id as string;
    expect((await h.admin(`debug-sessions/${id}/join`, { user: 'bob' })).body.participants).toEqual(['alice', 'bob']);
    // Unpaused call is streamed with its result.
    expect((await callTool({ x: 1 })).result).toBeDefined();
    let st = (await h.admin(`debug-sessions/${id}`)).body;
    expect(st.events.map((e: { type: string }) => e.type)).toEqual(['join', 'join', 'call', 'result']);
    const firstCall = st.events[2].callId as string;
    // Breakpoint: pause, bob edits the arguments and resumes.
    const pending = callTool({ stop: true, v: 'orig' });
    await waitFor(async () => (await h!.admin(`debug-sessions/${id}`)).body.paused.length === 1);
    st = (await h.admin(`debug-sessions/${id}`)).body;
    const pausedId = st.paused[0].callId as string;
    expect((await h.admin(`debug-sessions/${id}/calls/${pausedId}/resume`, { user: 'bob', arguments: { v: 'edited' } })).body).toEqual({ callId: pausedId, action: 'resumed' });
    const res = await pending;
    expect(JSON.stringify(res)).toContain('edited');
    // Abort → -32020.
    const aborted = callTool({ stop: true });
    await waitFor(async () => (await h!.admin(`debug-sessions/${id}`)).body.paused.length === 1);
    const pid = (await h.admin(`debug-sessions/${id}`)).body.paused[0].callId as string;
    await h.admin(`debug-sessions/${id}/calls/${pid}/abort`, { user: 'alice', reason: 'repro captured' });
    expect(JSON.stringify(await aborted)).toContain(String(ERR_DEBUG_ABORTED));
    expect((await h.admin(`debug-sessions/${id}/calls/nope/resume`, {})).status).toBe(404);
    // Notes, replay, events since.
    expect((await h.admin(`debug-sessions/${id}/notes`, { user: 'bob', text: 'arguments look wrong', callId: firstCall })).status).toBe(201);
    const replay = await h.admin(`debug-sessions/${id}/replay/${firstCall}`, {});
    expect(replay.body).toMatchObject({ replayOf: firstCall, success: true });
    const since = (await h.admin(`debug-sessions/${id}?after=${st.lastSeq}`)).body.events.map((e: { type: string; user?: string }) => `${e.type}${e.user ? ':' + e.user : ''}`);
    expect(since).toEqual(expect.arrayContaining(['resumed:bob', 'aborted:alice', 'note:bob']));
    expect(since.some((x: string) => x.startsWith('replay'))).toBe(true);
    // Breakpoints can be added and removed live.
    expect((await h.admin(`debug-sessions/${id}/breakpoints`, { tool: 'fake/other' })).body.breakpoints).toHaveLength(2);
    expect((await h.admin(`debug-sessions/${id}/breakpoints/1`, undefined, 'DELETE')).body.breakpoints).toHaveLength(1);
    // Closing resumes paused calls unchanged.
    const held = callTool({ stop: true, keep: 1 });
    await waitFor(async () => (await h!.admin(`debug-sessions/${id}`)).body.paused.length === 1);
    expect((await h.admin(`debug-sessions/${id}`, undefined, 'DELETE')).body).toEqual({ closed: id });
    expect((await held).result).toBeDefined();
    expect((await h.admin('debug-sessions')).body.sessions).toEqual([]);
  });

  it('streams events over SSE and enforces maxSessions; operators only', async () => {
    h = await startFeatureGw({ debugSessions: { maxSessions: 1 } } as never);
    const s = await h.admin('debug-sessions', {});
    expect((await h.admin('debug-sessions', {})).status).toBe(409);
    const ctl = new AbortController();
    const res = await fetch(`${h.base}/api/v1/admin/debug-sessions/${s.body.id}/events`, { headers: { authorization: 'Bearer op' }, signal: ctl.signal });
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const reader = res.body!.getReader();
    await callTool({ live: 1 });
    let text = '';
    while (!text.includes('event: result')) text += new TextDecoder().decode((await reader.read()).value);
    expect(text).toContain('event: call');
    ctl.abort();
    expect((await fetch(`${h.base}/api/v1/admin/debug-sessions`, { headers: { authorization: 'Bearer scoped' } })).status).toBe(403);
  });
});
