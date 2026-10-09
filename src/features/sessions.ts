/**
 * Agent session recording, replay and regression evals (5.5).
 *
 * A **recording** ("cassette") is an ordered list of tool calls an agent made — arguments and results — taken
 * from the replay recorder (`replay.enabled: true`) for one client and time window, or imported as JSON. Replaying
 * runs every call again through the full pipeline and grades each response against the recorded one:
 *
 * - `success` — the call must succeed again (default);
 * - `structure` — same JSON shape (keys and types), values may differ;
 * - `exact` — identical result.
 *
 * The eval report gives the pass rate, each failing step with a structural diff, and latency before / after —
 * a regression test for "does this agent's workflow still work after I upgraded that MCP server?".
 *
 * ```yaml
 * sessions:
 *   dir: ./recordings   # persist recordings as JSON (relative to the config file); in memory when omitted
 *   maxRecordings: 100
 * ```
 *
 * - `GET    /admin/sessions` — recordings (name, steps, client, created).
 * - `POST   /admin/sessions` — record `{ name, clientId?, since?, until?, tools? }` from captured calls.
 * - `PUT    /admin/sessions/:name` — import a recording `{ steps: [{ serverId, tool, arguments, result?, success }] }`.
 * - `GET    /admin/sessions/:name` — export; `DELETE` removes.
 * - `POST   /admin/sessions/:name/replay` — `{ mode?, stopOnFailure? }` → eval report.
 *
 * @module features/sessions
 */

import { mkdir, readFile, readdir, unlink, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { z } from 'zod';
import { registerFeature, objectBody, badRequest, principalOf, type FeatureContext } from '../gateway/features.js';
import { jsonDiff, type CapturedCall, type JsonChange } from '../gateway/replay.js';

export const SessionsSchema = z.object({ dir: z.string().min(1).optional(), maxRecordings: z.number().int().positive().default(100) }).strict();
export type SessionsConfig = z.input<typeof SessionsSchema>;

export interface RecordedStep {
  serverId: string;
  tool: string;
  arguments: Record<string, unknown>;
  result?: unknown;
  success: boolean;
  durationMs?: number;
}
export interface Recording {
  name: string;
  createdAt: string;
  clientId?: string;
  steps: RecordedStep[];
}
export type EvalMode = 'success' | 'structure' | 'exact';
export interface StepOutcome {
  index: number;
  serverId: string;
  tool: string;
  passed: boolean;
  reason?: string;
  durationMs: number;
  recordedMs?: number;
  diff?: JsonChange[];
}
export interface EvalReport {
  recording: string;
  mode: EvalMode;
  steps: number;
  passed: number;
  failed: number;
  skipped: number;
  passRate: number;
  latency: { recordedMs: number; replayMs: number };
  outcomes: StepOutcome[];
}

const NAME = /^[A-Za-z0-9_.-]{1,64}$/;

/** Build a recording from captured calls. Truncated captures (no arguments) are dropped. */
export function recordFrom(calls: CapturedCall[], sel: { name: string; clientId?: string; since?: string; until?: string; tools?: string[] }): Recording {
  const since = sel.since ? Date.parse(sel.since) : -Infinity;
  const until = sel.until ? Date.parse(sel.until) : Infinity;
  const steps = calls
    .filter((c) => c.kind === 'tool' && !c.replayOf && c.arguments !== undefined)
    .filter((c) => (sel.clientId === undefined || c.clientId === sel.clientId) && (!sel.tools?.length || sel.tools.includes(c.tool)))
    .filter((c) => { const t = Date.parse(c.timestamp); return t >= since && t <= until; })
    .map((c) => ({ serverId: c.serverId, tool: c.tool, arguments: c.arguments!, ...(c.result !== undefined ? { result: c.result } : {}), success: c.success, durationMs: c.durationMs }));
  return { name: sel.name, createdAt: new Date().toISOString(), ...(sel.clientId ? { clientId: sel.clientId } : {}), steps };
}

/** Keys and value types only. */
export function shapeOf(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(shapeOf);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([k, x]) => [k, shapeOf(x)]));
  return v === null ? 'null' : typeof v;
}

/** Grade one replayed step. */
export function grade(step: RecordedStep, got: { success: boolean; result?: unknown; error?: { message: string } }, mode: EvalMode): { passed: boolean; reason?: string; diff?: JsonChange[] } {
  if (step.success && !got.success) return { passed: false, reason: `failed: ${got.error?.message ?? 'error'}` };
  if (!step.success) return got.success ? { passed: false, reason: 'recorded call failed but the replay succeeded' } : { passed: true };
  if (mode === 'success' || step.result === undefined) return { passed: true };
  const diff = mode === 'exact' ? jsonDiff(step.result, got.result, 20) : jsonDiff(shapeOf(step.result), shapeOf(got.result), 20);
  return diff.length ? { passed: false, reason: mode === 'exact' ? 'result changed' : 'result shape changed', diff } : { passed: true };
}

/** Replay a recording through `invoke` and grade it. */
export async function replayRecording(rec: Recording, invoke: (serverId: string, tool: string, args: Record<string, unknown>, clientId?: string) => Promise<import('../utils/types.js').ProxyResponse>, opts: { mode?: EvalMode; stopOnFailure?: boolean } = {}): Promise<EvalReport> {
  const mode = opts.mode ?? 'success';
  const outcomes: StepOutcome[] = [];
  let stop = false;
  for (const [index, step] of rec.steps.entries()) {
    if (stop) break;
    const started = Date.now();
    let got: { success: boolean; result?: unknown; error?: { message: string } };
    try {
      got = await invoke(step.serverId, step.tool, step.arguments, `replay:${rec.name}`);
    } catch (e) {
      got = { success: false, error: { message: (e as Error).message } };
    }
    const g = grade(step, got, mode);
    outcomes.push({ index, serverId: step.serverId, tool: step.tool, ...g, durationMs: Date.now() - started, ...(step.durationMs !== undefined ? { recordedMs: step.durationMs } : {}) });
    if (!g.passed && opts.stopOnFailure) stop = true;
  }
  const passed = outcomes.filter((o) => o.passed).length;
  const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
  return {
    recording: rec.name,
    mode,
    steps: rec.steps.length,
    passed,
    failed: outcomes.length - passed,
    skipped: rec.steps.length - outcomes.length,
    passRate: rec.steps.length ? passed / rec.steps.length : 1,
    latency: { recordedMs: sum(rec.steps.map((s) => s.durationMs ?? 0)), replayMs: sum(outcomes.map((o) => o.durationMs)) },
    outcomes,
  };
}

/** Validate an imported recording body. */
export function parseSteps(raw: unknown): RecordedStep[] | string {
  if (!Array.isArray(raw)) return '"steps" must be an array';
  const out: RecordedStep[] = [];
  for (const [i, s] of raw.entries()) {
    const x = s as Partial<RecordedStep>;
    if (!x || typeof x.serverId !== 'string' || typeof x.tool !== 'string') return `steps[${i}]: "serverId" and "tool" are required`;
    if (x.arguments !== undefined && (typeof x.arguments !== 'object' || x.arguments === null || Array.isArray(x.arguments))) return `steps[${i}].arguments must be an object`;
    out.push({ serverId: x.serverId, tool: x.tool, arguments: (x.arguments as Record<string, unknown>) ?? {}, ...(x.result !== undefined ? { result: x.result } : {}), success: x.success !== false, ...(typeof x.durationMs === 'number' ? { durationMs: x.durationMs } : {}) });
  }
  return out;
}

/** Recording storage: memory, plus a JSON file per recording when `dir` is set. */
export class RecordingStore {
  private readonly mem = new Map<string, Recording>();
  private loaded?: string;

  constructor(private readonly dir: () => string | undefined, private readonly max: () => number) {}

  private async load(): Promise<void> {
    const d = this.dir();
    if (!d || this.loaded === d) return;
    this.loaded = d;
    const files = await readdir(d).catch(() => [] as string[]);
    for (const f of files.filter((x) => x.endsWith('.json'))) {
      try {
        const r = JSON.parse(await readFile(join(d, f), 'utf8')) as Recording;
        if (r && NAME.test(r.name) && Array.isArray(r.steps)) this.mem.set(r.name, r);
      } catch { /* skip unreadable */ }
    }
  }

  async list(): Promise<Recording[]> {
    await this.load();
    return [...this.mem.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async get(name: string): Promise<Recording | undefined> {
    await this.load();
    return this.mem.get(name);
  }

  async put(r: Recording): Promise<void> {
    await this.load();
    if (!this.mem.has(r.name) && this.mem.size >= this.max()) throw new Error(`recording limit reached (${this.max()})`);
    this.mem.set(r.name, r);
    const d = this.dir();
    if (d) {
      await mkdir(d, { recursive: true });
      await writeFile(join(d, `${r.name}.json`), JSON.stringify(r, null, 2) + '\n');
    }
  }

  async delete(name: string): Promise<boolean> {
    await this.load();
    const had = this.mem.delete(name);
    const d = this.dir();
    if (d) await unlink(join(d, `${name}.json`)).catch(() => undefined);
    return had;
  }
}

registerFeature({
  id: 'sessions',
  since: '5.5.0',
  summary: 'Agent session recording, replay and regression evals',
  mount: (router, ctx) => {
    const cfg = () => SessionsSchema.parse(ctx.config().sessions ?? {});
    const store = new RecordingStore(
      () => { const d = cfg().dir; return d ? resolve(ctx.config().configDir ?? process.cwd(), d) : undefined; },
      () => cfg().maxRecordings,
    );
    const summary = (r: Recording) => ({ name: r.name, createdAt: r.createdAt, clientId: r.clientId, steps: r.steps.length, tools: [...new Set(r.steps.map((s) => s.tool))] });
    const save = async (res: import('express').Response, r: Recording) => {
      try {
        await store.put(r);
        res.status(201).json(summary(r));
      } catch (e) {
        res.status(409).json({ error: 'Conflict', message: (e as Error).message });
      }
    };
    router.get('/', async (_req, res) => void res.json({ recordings: (await store.list()).map(summary), replayEnabled: ctx.config().replay?.enabled === true }));
    router.post('/', async (req, res) => {
      const b = objectBody(req, res);
      if (!b) return;
      if (typeof b.name !== 'string' || !NAME.test(b.name)) return badRequest(res, '"name" is required ([A-Za-z0-9_.-], ≤ 64)');
      if (ctx.config().replay?.enabled !== true) return void res.status(409).json({ error: 'Conflict', message: 'recording needs `replay.enabled: true` (captures arguments and results)' });
      const rec = recordFrom(ctx.capturedCalls?.() ?? [], { name: b.name, clientId: typeof b.clientId === 'string' ? b.clientId : undefined, since: typeof b.since === 'string' ? b.since : undefined, until: typeof b.until === 'string' ? b.until : undefined, tools: Array.isArray(b.tools) ? b.tools.map(String) : undefined });
      if (!rec.steps.length) return void res.status(422).json({ error: 'Unprocessable Entity', message: 'no captured tool calls match' });
      await save(res, rec);
    });
    router.put('/:name', async (req, res) => {
      const b = objectBody(req, res);
      if (!b) return;
      if (!NAME.test(req.params.name!)) return badRequest(res, 'invalid recording name');
      const steps = parseSteps(b.steps);
      if (typeof steps === 'string') return badRequest(res, steps);
      await save(res, { name: req.params.name!, createdAt: new Date().toISOString(), ...(typeof b.clientId === 'string' ? { clientId: b.clientId } : {}), steps });
    });
    router.get('/:name', async (req, res) => {
      const r = await store.get(req.params.name!);
      if (!r) return void res.status(404).json({ error: 'Not Found', message: 'no such recording' });
      res.json(r);
    });
    router.delete('/:name', async (req, res) => void res.json({ deleted: await store.delete(req.params.name!) }));
    router.post('/:name/replay', async (req, res) => {
      const r = await store.get(req.params.name!);
      if (!r) return void res.status(404).json({ error: 'Not Found', message: 'no such recording' });
      const b = (req.body ?? {}) as { mode?: unknown; stopOnFailure?: unknown };
      if (b.mode !== undefined && !['success', 'structure', 'exact'].includes(String(b.mode))) return badRequest(res, '"mode" must be success, structure or exact');
      res.json(await replayRecording(r, (s, t, a, c) => ctx.invoke(s, t, a, principalOf(req), c), { mode: b.mode as EvalMode | undefined, stopOnFailure: b.stopOnFailure === true }));
    });
  },
});
