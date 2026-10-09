import { describe, it, expect, afterEach } from 'vitest';
import { WorkflowsSchema, runWorkflow, topoLayers, WorkflowRuns } from '../src/features/workflows.js';
import { validateConfig } from '../src/config/loader.js';
import type { ProxyResponse } from '../src/utils/types.js';
import { startFeatureGw, type FeatureGw } from './helpers/feature-gw.js';

const ok = (v: unknown): ProxyResponse => ({ success: true, durationMs: 1, result: { content: [{ type: 'text', text: JSON.stringify(v) }], structuredContent: v } });
const wf = (nodes: unknown[], extra: Record<string, unknown> = {}) => WorkflowsSchema.parse([{ id: 'w', nodes, ...extra }])[0]!;

let h: FeatureGw | undefined;
afterEach(async () => {
  await h?.stop();
  h = undefined;
});

describe('workflow engine (6.2)', () => {
  it('layers a DAG and rejects cycles, unknown needs and duplicates', () => {
    expect(topoLayers([{ id: 'a', needs: [] }, { id: 'b', needs: ['a'] }, { id: 'c', needs: ['a'] }, { id: 'd', needs: ['b', 'c'] }])).toEqual([['a'], ['b', 'c'], ['d']]);
    expect(topoLayers([{ id: 'a', needs: ['b'] }, { id: 'b', needs: ['a'] }])).toBeUndefined();
    expect(() => wf([{ id: 'a', tool: 's/t', needs: ['b'] }, { id: 'b', tool: 's/t', needs: ['a'] }])).toThrow(/dependency cycle/);
    expect(() => wf([{ id: 'a', tool: 's/t', needs: ['zz'] }])).toThrow(/needs unknown node zz/);
    expect(() => wf([{ id: 'a', tool: 's/t' }, { id: 'a', tool: 's/t' }])).toThrow(/duplicate node/);
    expect(() => wf([{ id: 'a', tool: 'notarget' }])).toThrow(/server\/tool/);
    expect(() => validateConfig({ servers: [], features: { workflows: [{ id: 'w', nodes: [{ id: 'a', tool: 's/t' }] }] } })).not.toThrow();
  });

  it('runs independent nodes in parallel, passes values, renders output', async () => {
    let live = 0;
    let peak = 0;
    const calls: string[] = [];
    const invoke = async (_s: string, t: string, a: Record<string, unknown>) => {
      calls.push(`${t}:${JSON.stringify(a)}`);
      live++;
      peak = Math.max(peak, live);
      await new Promise((r) => setTimeout(r, 15));
      live--;
      return ok(t === 'sum' ? { total: Number(a.x) + Number(a.y) } : { n: t.length });
    };
    const w = wf(
      [
        { id: 'a', tool: 's/aa', args: { q: '{{input.q}}' } },
        { id: 'b', tool: 's/bbb' },
        { id: 'c', tool: 's/cccc' },
        { id: 'sum', tool: 's/sum', needs: ['a', 'b'], args: { x: '{{nodes.a.structuredContent.n}}', y: '{{nodes.b.structuredContent.n}}' } },
      ],
      { output: { total: '{{nodes.sum.structuredContent.total}}' } },
    );
    const r = await runWorkflow(w, { q: 'hi' }, invoke);
    expect(r.status).toBe('succeeded');
    expect(peak).toBe(3);
    expect(r.output).toEqual({ total: 5 });
    expect(calls[0]).toBe('aa:{"q":"hi"}');
    expect(calls.at(-1)).toBe('sum:{"x":2,"y":3}');
    const r2 = await runWorkflow({ ...w, concurrency: 1 }, {}, async (s, t, a) => ((live = 0), invoke(s, t, a)));
    expect(r2.nodes.every((n) => n.status === 'succeeded')).toBe(true);
  });

  it('retries with backoff, honours if / onError, skips dependants of failures', async () => {
    const waits: number[] = [];
    let flaky = 0;
    const invoke = async (_s: string, t: string): Promise<ProxyResponse> => {
      if (t === 'flaky' && ++flaky < 3) return { success: false, durationMs: 1, error: { code: -1, message: 'try again' } };
      if (t === 'bad') return { success: false, durationMs: 1, error: { code: -1, message: 'broken' } };
      if (t === 'throw') throw new Error('boom');
      return ok({ hot: t === 'flaky' });
    };
    const sleepFn = async (ms: number) => void waits.push(ms);
    const r = await runWorkflow(
      wf([
        { id: 'f', tool: 's/flaky', retry: { attempts: 3, backoffMs: 50 } },
        { id: 'notify', tool: 's/x', needs: ['f'], if: 'nodes.f.structuredContent.hot' },
        { id: 'cold', tool: 's/x', needs: ['f'], if: 'nodes.f.structuredContent.cold' },
        { id: 'opt', tool: 's/bad', onError: 'continue' },
        { id: 'after-opt', tool: 's/x', needs: ['opt'] },
      ]),
      {},
      invoke,
      { sleepFn },
    );
    expect(waits).toEqual([50, 100]);
    expect(r.status).toBe('succeeded');
    expect(Object.fromEntries(r.nodes.map((n) => [n.id, `${n.status}/${n.attempts}`]))).toEqual({ f: 'succeeded/3', notify: 'succeeded/1', cold: 'skipped/0', opt: 'failed/1', 'after-opt': 'skipped/0' });
    const f = await runWorkflow(wf([{ id: 'x', tool: 's/throw' }, { id: 'y', tool: 's/ok', needs: ['x'] }]), {}, invoke);
    expect(f.status).toBe('failed');
    expect(f.error).toBe('node x: boom');
    expect(f.nodes[1]!.status).toBe('skipped');
  });

  it('keeps a bounded run history', () => {
    const h2 = new WorkflowRuns(2);
    for (const id of ['1', '2', '3']) h2.add({ runId: id, workflow: id === '3' ? 'b' : 'a', status: 'succeeded', startedAt: '', nodes: [] });
    expect(h2.get('1')).toBeUndefined();
    expect(h2.list().map((r) => r.runId)).toEqual(['3', '2']);
    expect(h2.list('a').map((r) => r.runId)).toEqual(['2']);
  });

  it('admin API: list, run (wait and async), history', async () => {
    h = await startFeatureGw({ workflows: [{ id: 'echo2', nodes: [{ id: 'one', tool: 'fake/echo', args: { v: '{{input.v}}' } }, { id: 'two', tool: 'fake/echo', needs: ['one'], args: { prev: '{{nodes.one.text}}' } }], output: '{{nodes.two.text}}' }] } as never);
    const l = await h.admin('workflows');
    expect(l.body.workflows[0].layers).toEqual([['one'], ['two']]);
    const r = await h.admin('workflows/run', { workflow: 'echo2', input: { v: 7 }, wait: true });
    expect(r.status).toBe(200);
    expect(r.body.status).toBe('succeeded');
    expect(JSON.parse(r.body.output)).toEqual({ prev: '{"v":7}' });
    const a = await h.admin('workflows/run', { workflow: 'echo2' });
    expect(a.status).toBe(202);
    for (let i = 0; i < 50 && (await h.admin(`workflows/runs/${a.body.runId}`)).body.status === 'running'; i++) await new Promise((x) => setTimeout(x, 20));
    expect((await h.admin(`workflows/runs/${a.body.runId}`)).body.status).toBe('succeeded');
    expect((await h.admin('workflows/runs')).body.runs).toHaveLength(2);
    expect((await h.admin('workflows/runs?workflow=zz')).body.runs).toHaveLength(0);
    expect((await h.admin('workflows/runs/nope')).status).toBe(404);
    expect((await h.admin('workflows/run', { workflow: 'nope' })).status).toBe(404);
    expect((await h.admin('workflows/run', { workflow: 'echo2', input: [] })).status).toBe(400);
    expect((await h.admin('workflows/run', [])).status).toBe(400);
  });
});
