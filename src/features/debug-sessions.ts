/**
 * Live collaborative debugging (8.3): shared debug sessions in which several operators watch matching tool calls
 * live, pause them at breakpoints, edit arguments, resume or abort them, annotate, and replay captured calls.
 *
 * ```yaml
 * debugSessions:
 *   maxSessions: 10
 *   holdTimeoutSeconds: 60     # a paused call is aborted (-32020) when nobody resumes it in time
 *   maxEvents: 500             # events kept per session
 * ```
 *
 * Sessions are created at runtime (operators):
 * - `POST /admin/debug-sessions` `{ name?, match?: { servers?, tools?, clients? }, breakpoints?: [{ tool, when? }] }`
 *   → session (`id`); the creator joins as `owner` (header `x-debug-user`, default the client id).
 * - `POST /admin/debug-sessions/:id/join` `{ user }`, `GET /admin/debug-sessions/:id` (participants, paused calls,
 *   events since `?after=<seq>`), `GET /admin/debug-sessions/:id/events` (Server-Sent Events, live).
 * - `POST /admin/debug-sessions/:id/calls/:callId/resume` `{ arguments?, user? }` / `…/abort` `{ reason?, user? }`.
 * - `POST /admin/debug-sessions/:id/breakpoints` `{ tool, when? }`, `DELETE /admin/debug-sessions/:id/breakpoints/:n`.
 * - `POST /admin/debug-sessions/:id/notes` `{ text, callId?, user? }`, `POST /admin/debug-sessions/:id/replay/:callId`.
 * - `DELETE /admin/debug-sessions/:id` — closes the session and resumes every paused call unchanged.
 *
 * Arguments and results are redacted (secrets, tokens) in events. Paused calls hold their caller's request; aborted
 * or timed-out calls fail with JSON-RPC **-32020**.
 *
 * @module features/debug-sessions
 */

import { randomUUID } from 'node:crypto';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { registerFeature, objectBody, badRequest, clientIdOf } from '../gateway/features.js';
import { registerCallHook } from '../gateway/hooks.js';
import { globToRegExp } from '../utils/tool-filter.js';
import { redactValue } from '../security/redact.js';
import type { GatewayConfig, ProxyResponse } from '../utils/types.js';

/** JSON-RPC error: a call paused at a debug breakpoint was aborted or timed out (8.3). */
export const ERR_DEBUG_ABORTED = -32020;

export const DebugSessionsSchema = z
  .object({
    enabled: z.boolean().default(true),
    maxSessions: z.number().int().min(1).max(100).default(10),
    holdTimeoutSeconds: z.number().int().min(1).max(3600).default(60),
    maxEvents: z.number().int().min(10).max(10_000).default(500),
  })
  .strict();
export type DebugSessionsConfig = z.input<typeof DebugSessionsSchema>;
type Cfg = z.output<typeof DebugSessionsSchema>;

const Match = z.object({ servers: z.array(z.string()).optional(), tools: z.array(z.string()).optional(), clients: z.array(z.string()).optional() }).strict();
const Breakpoint = z.object({ tool: z.string().min(1), when: z.object({ path: z.string().min(1), equals: z.unknown() }).strict().optional() }).strict();
const CreateBody = z.object({ name: z.string().max(200).optional(), match: Match.optional(), breakpoints: z.array(Breakpoint).max(50).optional() }).strict();
export type DebugBreakpoint = z.infer<typeof Breakpoint>;

export interface DebugEvent {
  seq: number;
  at: string;
  type: 'call' | 'paused' | 'resumed' | 'aborted' | 'result' | 'note' | 'join' | 'breakpoint' | 'replay';
  callId?: string;
  user?: string;
  data?: Record<string, unknown>;
}

interface Paused {
  callId: string;
  tool: string;
  client?: string;
  args: Record<string, unknown>;
  since: number;
  resolve: (v: { args?: Record<string, unknown>; abort?: string }) => void;
  timer: NodeJS.Timeout;
}

export interface DebugSession {
  id: string;
  name: string;
  createdAt: string;
  owner: string;
  participants: Set<string>;
  match: z.infer<typeof Match>;
  breakpoints: DebugBreakpoint[];
  events: DebugEvent[];
  seq: number;
  paused: Map<string, Paused>;
  captured: Map<string, { serverId: string; tool: string; args: Record<string, unknown> }>;
  listeners: Set<(e: DebugEvent) => void>;
}

const settings = (cfg: GatewayConfig): Cfg | undefined => {
  if (!cfg.debugSessions) return undefined;
  const c = DebugSessionsSchema.parse(cfg.debugSessions);
  return c.enabled ? c : undefined;
};
const any = (globs: string[] | undefined, s: string | undefined) => !globs?.length || (s !== undefined && globs.some((g) => globToRegExp(g).test(s)));
const at = (obj: unknown, path: string): unknown => path.split('.').reduce<unknown>((o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined), obj);

/** Runtime state; exported for tests. */
export const debugState = {
  sessions: new Map<string, DebugSession>(),
  pending: new WeakMap<object, Array<{ session: DebugSession; callId: string; started: number }>>(),
  reset() {
    for (const s of this.sessions.values()) closeSession(s);
    this.sessions.clear();
  },
};

function emit(s: DebugSession, max: number, e: Omit<DebugEvent, 'seq' | 'at'>): DebugEvent {
  const ev: DebugEvent = { seq: ++s.seq, at: new Date().toISOString(), ...e };
  s.events.push(ev);
  if (s.events.length > max) s.events.splice(0, s.events.length - max);
  for (const l of s.listeners) l(ev);
  return ev;
}

export function createSession(c: Cfg, owner: string, body: z.infer<typeof CreateBody>): DebugSession {
  if (debugState.sessions.size >= c.maxSessions) throw new Error(`at most ${c.maxSessions} debug sessions (debugSessions.maxSessions)`);
  const s: DebugSession = {
    id: randomUUID().slice(0, 8),
    name: body.name ?? 'debug session',
    createdAt: new Date().toISOString(),
    owner,
    participants: new Set([owner]),
    match: body.match ?? {},
    breakpoints: body.breakpoints ?? [],
    events: [],
    seq: 0,
    paused: new Map(),
    captured: new Map(),
    listeners: new Set(),
  };
  debugState.sessions.set(s.id, s);
  emit(s, c.maxEvents, { type: 'join', user: owner, data: { role: 'owner' } });
  return s;
}

export function closeSession(s: DebugSession): void {
  for (const p of s.paused.values()) {
    clearTimeout(p.timer);
    p.resolve({});
  }
  s.paused.clear();
  for (const l of s.listeners) l({ seq: s.seq + 1, at: new Date().toISOString(), type: 'aborted', data: { closed: true } });
  s.listeners.clear();
}

/** Does a breakpoint stop this call? */
export function hits(b: DebugBreakpoint, name: string, args: Record<string, unknown>): boolean {
  if (!globToRegExp(b.tool).test(name)) return false;
  if (!b.when) return true;
  return JSON.stringify(at(args, b.when.path)) === JSON.stringify(b.when.equals);
}

const view = (s: DebugSession) => ({
  id: s.id,
  name: s.name,
  createdAt: s.createdAt,
  owner: s.owner,
  participants: [...s.participants],
  match: s.match,
  breakpoints: s.breakpoints,
  paused: [...s.paused.values()].map((p) => ({ callId: p.callId, tool: p.tool, client: p.client, arguments: redactValue(p.args), pausedForMs: Date.now() - p.since })),
  lastSeq: s.seq,
});

registerCallHook({
  id: 'debug-sessions',
  async before(call, cfg) {
    const c = settings(cfg);
    if (!c || !debugState.sessions.size) return;
    const name = `${call.serverId}/${call.tool}`;
    let args = call.args;
    const tracked: Array<{ session: DebugSession; callId: string; started: number }> = [];
    for (const s of debugState.sessions.values()) {
      if (!any(s.match.servers, call.serverId) || !any(s.match.tools, name) || !any(s.match.clients, call.clientId)) continue;
      const callId = randomUUID().slice(0, 8);
      s.captured.set(callId, { serverId: call.serverId, tool: call.tool, args });
      if (s.captured.size > c.maxEvents) s.captured.delete(s.captured.keys().next().value!);
      emit(s, c.maxEvents, { type: 'call', callId, data: { tool: name, client: call.clientId, arguments: redactValue(args) } });
      const bp = s.breakpoints.find((b) => hits(b, name, args));
      if (bp) {
        emit(s, c.maxEvents, { type: 'paused', callId, data: { tool: name, breakpoint: bp.tool } });
        const decision = await new Promise<{ args?: Record<string, unknown>; abort?: string }>((resolve) => {
          const timer = setTimeout(() => {
            s.paused.delete(callId);
            emit(s, c.maxEvents, { type: 'aborted', callId, data: { reason: `not resumed within ${c.holdTimeoutSeconds}s` } });
            resolve({ abort: `Paused at a debug breakpoint and not resumed within ${c.holdTimeoutSeconds}s` });
          }, c.holdTimeoutSeconds * 1000);
          timer.unref();
          s.paused.set(callId, { callId, tool: name, client: call.clientId, args, since: Date.now(), resolve, timer });
        });
        if (decision.abort !== undefined) return { refuse: { code: ERR_DEBUG_ABORTED, message: decision.abort, data: { session: s.id, callId } } };
        if (decision.args) args = decision.args;
      }
      tracked.push({ session: s, callId, started: Date.now() });
    }
    if (!tracked.length) return;
    if (args === call.args) args = { ...args }; // fresh object: the after hook finds its calls by identity
    debugState.pending.set(args, tracked);
    return { args };
  },
  after(call, result: ProxyResponse, cfg) {
    const c = settings(cfg);
    const tracked = debugState.pending.get(call.args);
    if (!c || !tracked) return;
    debugState.pending.delete(call.args);
    for (const t of tracked) {
      if (!debugState.sessions.has(t.session.id)) continue;
      emit(t.session, c.maxEvents, { type: 'result', callId: t.callId, data: { success: result.success, durationMs: Date.now() - t.started, ...(result.success ? { result: redactValue(result.result) } : { error: result.error }) } });
    }
  },
});

const userOf = (req: Request, b?: Record<string, unknown>) => (typeof b?.user === 'string' && b.user) || req.get('x-debug-user') || clientIdOf(req) || 'operator';

registerFeature({
  id: 'debug-sessions',
  since: '8.3.0',
  summary: 'Live collaborative debugging: shared sessions, live call stream (SSE), breakpoints, edit/resume/abort, notes, replay',
  mount(router, ctx) {
    ctx.onStop?.(() => debugState.reset());
    const cfgOr404 = (res: Response) => {
      const c = settings(ctx.config());
      if (!c) res.status(404).json({ error: 'Not Found', message: 'debugSessions is not configured' });
      return c;
    };
    const sessionOr404 = (req: Request, res: Response) => {
      const s = debugState.sessions.get(String(req.params.id));
      if (!s) res.status(404).json({ error: 'Not Found', message: `no debug session "${req.params.id}"` });
      return s;
    };
    router.get('/', (_req, res) => {
      const c = settings(ctx.config());
      res.json({ enabled: !!c, sessions: [...debugState.sessions.values()].map(view) });
    });
    router.post('/', (req, res) => {
      const c = cfgOr404(res);
      if (!c) return;
      const b = objectBody(req, res);
      if (!b) return;
      const { user: _u, ...rest } = b;
      const parsed = CreateBody.safeParse(rest);
      if (!parsed.success) return badRequest(res, parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
      try {
        res.status(201).json(view(createSession(c, userOf(req, b), parsed.data)));
      } catch (err) {
        res.status(409).json({ error: 'Conflict', message: (err as Error).message });
      }
    });
    router.get('/:id', (req, res) => {
      const s = sessionOr404(req, res);
      if (!s) return;
      const after = Number(req.query.after ?? 0) || 0;
      res.json({ ...view(s), events: s.events.filter((e) => e.seq > after) });
    });
    router.get('/:id/events', (req, res) => {
      const s = sessionOr404(req, res);
      if (!s) return;
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
      const send = (e: DebugEvent) => res.write(`id: ${e.seq}\nevent: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
      const after = Number(req.get('last-event-id') ?? req.query.after ?? 0) || 0;
      for (const e of s.events) if (e.seq > after) send(e);
      s.listeners.add(send);
      req.on('close', () => s.listeners.delete(send));
    });
    router.delete('/:id', (req, res) => {
      const s = sessionOr404(req, res);
      if (!s) return;
      closeSession(s);
      debugState.sessions.delete(s.id);
      res.json({ closed: s.id });
    });
    router.post('/:id/join', (req, res) => {
      const c = cfgOr404(res);
      const s = c && sessionOr404(req, res);
      if (!c || !s) return;
      const b = objectBody(req, res);
      if (!b) return;
      const user = userOf(req, b);
      s.participants.add(user);
      emit(s, c.maxEvents, { type: 'join', user });
      res.json(view(s));
    });
    const decide = (abort: boolean) => (req: Request, res: Response) => {
      const c = cfgOr404(res);
      const s = c && sessionOr404(req, res);
      if (!c || !s) return;
      const b = objectBody(req, res);
      if (!b) return;
      const p = s.paused.get(String(req.params.callId));
      if (!p) return void res.status(404).json({ error: 'Not Found', message: `call "${req.params.callId}" is not paused in this session` });
      if (!abort && b.arguments !== undefined && (!b.arguments || typeof b.arguments !== 'object' || Array.isArray(b.arguments))) return badRequest(res, '"arguments" must be an object');
      clearTimeout(p.timer);
      s.paused.delete(p.callId);
      const user = userOf(req, b);
      if (abort) {
        const reason = typeof b.reason === 'string' && b.reason ? b.reason : 'aborted from a debug session';
        emit(s, c.maxEvents, { type: 'aborted', callId: p.callId, user, data: { reason } });
        p.resolve({ abort: `Aborted at a debug breakpoint by ${user}: ${reason}` });
      } else {
        const edited = b.arguments as Record<string, unknown> | undefined;
        emit(s, c.maxEvents, { type: 'resumed', callId: p.callId, user, data: edited ? { arguments: redactValue(edited), edited: true } : { edited: false } });
        p.resolve({ args: edited });
      }
      res.json({ callId: p.callId, action: abort ? 'aborted' : 'resumed' });
    };
    router.post('/:id/calls/:callId/resume', decide(false));
    router.post('/:id/calls/:callId/abort', decide(true));
    router.post('/:id/breakpoints', (req, res) => {
      const c = cfgOr404(res);
      const s = c && sessionOr404(req, res);
      if (!c || !s) return;
      const b = objectBody(req, res);
      if (!b) return;
      const { user: _u, ...rest } = b;
      const bp = Breakpoint.safeParse(rest);
      if (!bp.success) return badRequest(res, 'Body must be { "tool": "<server/tool glob>", "when"?: { "path", "equals" } }');
      s.breakpoints.push(bp.data);
      emit(s, c.maxEvents, { type: 'breakpoint', user: userOf(req, b), data: { added: bp.data } });
      res.status(201).json({ breakpoints: s.breakpoints });
    });
    router.delete('/:id/breakpoints/:n', (req, res) => {
      const c = cfgOr404(res);
      const s = c && sessionOr404(req, res);
      if (!c || !s) return;
      const n = Number(req.params.n);
      if (!Number.isInteger(n) || n < 0 || n >= s.breakpoints.length) return void res.status(404).json({ error: 'Not Found', message: `no breakpoint ${req.params.n}` });
      const [removed] = s.breakpoints.splice(n, 1);
      emit(s, c.maxEvents, { type: 'breakpoint', user: userOf(req), data: { removed } });
      res.json({ breakpoints: s.breakpoints });
    });
    router.post('/:id/notes', (req, res) => {
      const c = cfgOr404(res);
      const s = c && sessionOr404(req, res);
      if (!c || !s) return;
      const b = objectBody(req, res);
      if (!b) return;
      if (typeof b.text !== 'string' || !b.text.trim() || b.text.length > 4000) return badRequest(res, 'Body must be { "text": "<1-4000 chars>", "callId"? }');
      res.status(201).json(emit(s, c.maxEvents, { type: 'note', user: userOf(req, b), callId: typeof b.callId === 'string' ? b.callId : undefined, data: { text: b.text } }));
    });
    router.post('/:id/replay/:callId', async (req, res) => {
      const c = cfgOr404(res);
      const s = c && sessionOr404(req, res);
      if (!c || !s) return;
      const cap = s.captured.get(String(req.params.callId));
      if (!cap) return void res.status(404).json({ error: 'Not Found', message: `call "${req.params.callId}" was not captured by this session` });
      const user = userOf(req);
      emit(s, c.maxEvents, { type: 'replay', callId: String(req.params.callId), user, data: { tool: `${cap.serverId}/${cap.tool}` } });
      const r = await ctx.invoke(cap.serverId, cap.tool, cap.args, `debug:${s.id}`);
      res.json({ replayOf: req.params.callId, ...r });
    });
  },
});
