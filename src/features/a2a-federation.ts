/**
 * Cross-gateway A2A federation (8.2): discover remote A2A agents (other mcp-gateways with `a2a.enabled`, or any
 * A2A 0.3 agent), list their skills next to the local tools and forward agent tasks to them with one trust and audit
 * model.
 *
 * ```yaml
 * a2aFederation:
 *   refreshSeconds: 60                       # agent-card refresh
 *   timeoutMs: 15000
 *   remotes:
 *     - id: eu
 *       url: https://gw-eu.example.com       # base URL; the card is read from /.well-known/agent-card.json
 *       token: ${EU_A2A_TOKEN}               # bearer sent to the remote (optional)
 *       skills: ["search*", "echo"]          # skill-id globs exposed locally (default all)
 *       clients: ["key:ops-*", "agent:*"]    # local clients allowed to use this remote (default all)
 * ```
 *
 * - `GET  /api/v1/features/a2a-federation/skills` — remote skills the caller may use (`<skill>@<remote>`).
 * - `POST /api/v1/features/a2a-federation/send` `{ remote, skill, arguments? }` — `message/send` to the remote;
 *   returns the remote Task (`completed` / `failed` / `rejected`) plus `remote`, `durationMs`.
 * - Operators: `GET /api/v1/admin/a2a-federation` (remotes, card status, skills, recent forwarded tasks),
 *   `POST /api/v1/admin/a2a-federation/refresh`.
 *
 * Each forwarded task carries `metadata.federation = { gateway, client }` so the remote's audit log records who
 * asked; the local log keeps the last 200 forwarded tasks.
 *
 * @module features/a2a-federation
 */

import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { registerFeature, objectBody, badRequest, clientIdOf } from '../gateway/features.js';
import { globToRegExp } from '../utils/tool-filter.js';
import { VERSION } from '../utils/version.js';
import type { GatewayConfig } from '../utils/types.js';

const Remote = z
  .object({
    id: z.string().min(1).regex(/^[A-Za-z0-9._-]+$/),
    url: z.string().url(),
    token: z.string().min(1).optional(),
    skills: z.array(z.string().min(1)).default(['*']),
    clients: z.array(z.string().min(1)).default(['*']),
    enabled: z.boolean().default(true),
  })
  .strict();

export const A2aFederationSchema = z
  .object({
    enabled: z.boolean().default(true),
    gatewayId: z.string().min(1).optional(),
    refreshSeconds: z.number().int().min(5).max(86_400).default(60),
    timeoutMs: z.number().int().min(100).max(300_000).default(15_000),
    remotes: z.array(Remote).default([]),
  })
  .strict()
  .superRefine((c, ctx) => {
    const ids = new Set<string>();
    c.remotes.forEach((r, i) => {
      if (ids.has(r.id)) ctx.addIssue({ code: 'custom', path: ['remotes', i, 'id'], message: `duplicate remote id "${r.id}"` });
      ids.add(r.id);
    });
  });
export type A2aFederationConfig = z.input<typeof A2aFederationSchema>;
type Cfg = z.output<typeof A2aFederationSchema>;
type RemoteCfg = Cfg['remotes'][number];

export interface RemoteSkill {
  id: string;
  name?: string;
  description?: string;
}
export interface RemoteState {
  id: string;
  card?: { name?: string; url?: string; version?: string; protocolVersion?: string };
  skills: RemoteSkill[];
  status: 'unknown' | 'online' | 'error';
  error?: string;
  fetchedAt?: string;
}
export interface ForwardedTask {
  id: string;
  remote: string;
  skill: string;
  client?: string;
  state: string;
  durationMs: number;
  at: string;
}

const settings = (cfg: GatewayConfig): Cfg | undefined => {
  if (!cfg.a2aFederation) return undefined;
  const c = A2aFederationSchema.parse(cfg.a2aFederation);
  return c.enabled ? c : undefined;
};
const matchAny = (globs: string[], s: string) => globs.some((g) => globToRegExp(g).test(s));

/** Runtime state; exported for tests. */
export const federationState = {
  remotes: new Map<string, RemoteState>(),
  log: [] as ForwardedTask[],
  reset() {
    this.remotes.clear();
    this.log.length = 0;
  },
};

const headers = (r: RemoteCfg) => ({ 'content-type': 'application/json', accept: 'application/json', ...(r.token ? { authorization: `Bearer ${r.token}` } : {}) });

/** Fetch one remote's agent card. */
export async function refreshRemote(r: RemoteCfg, timeoutMs: number): Promise<RemoteState> {
  const st: RemoteState = { id: r.id, skills: [], status: 'unknown' };
  try {
    const res = await fetch(`${r.url.replace(/\/+$/, '')}/.well-known/agent-card.json`, { headers: headers(r), signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) throw new Error(`agent card: HTTP ${res.status}`);
    const card = (await res.json()) as { name?: string; url?: string; version?: string; protocolVersion?: string; skills?: RemoteSkill[] };
    if (!card || typeof card !== 'object' || !Array.isArray(card.skills)) throw new Error('agent card: no skills array');
    st.card = { name: card.name, url: card.url, version: card.version, protocolVersion: card.protocolVersion };
    st.skills = card.skills.filter((s) => s && typeof s.id === 'string' && matchAny(r.skills, s.id)).map((s) => ({ id: s.id, name: s.name, description: s.description }));
    st.status = 'online';
  } catch (err) {
    st.status = 'error';
    st.error = err instanceof Error ? err.message : String(err);
  }
  st.fetchedAt = new Date().toISOString();
  federationState.remotes.set(r.id, st);
  return st;
}

export async function refreshAll(c: Cfg): Promise<RemoteState[]> {
  return Promise.all(c.remotes.filter((r) => r.enabled).map((r) => refreshRemote(r, c.timeoutMs)));
}

/** Forward an agent task (A2A `message/send`) to a remote. */
export async function sendToRemote(c: Cfg, remoteId: string, skill: string, args: Record<string, unknown>, client?: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const r = c.remotes.find((x) => x.id === remoteId && x.enabled);
  if (!r) return { status: 404, body: { error: 'Not Found', message: `unknown remote "${remoteId}"` } };
  if (!matchAny(r.clients, client ?? 'anonymous')) return { status: 403, body: { error: 'Forbidden', message: `client "${client}" may not use remote "${r.id}"` } };
  if (!matchAny(r.skills, skill)) return { status: 403, body: { error: 'Forbidden', message: `skill "${skill}" is not exported from remote "${r.id}"` } };
  let st = federationState.remotes.get(r.id);
  if (!st || st.status !== 'online') st = await refreshRemote(r, c.timeoutMs);
  if (st.status !== 'online' || !st.card?.url) return { status: 502, body: { error: 'Bad Gateway', message: `remote "${r.id}" unavailable: ${st.error ?? 'no agent url'}` } };
  const started = Date.now();
  const gateway = c.gatewayId ?? `mcp-gateway/${VERSION}`;
  let state = 'failed';
  try {
    const res = await fetch(st.card.url, {
      method: 'POST',
      headers: headers(r),
      signal: AbortSignal.timeout(c.timeoutMs),
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: randomUUID(),
        method: 'message/send',
        params: { message: { kind: 'message', role: 'user', messageId: randomUUID(), parts: [{ kind: 'data', data: { skill, arguments: args } }], metadata: { federation: { gateway, client } } } },
      }),
    });
    const body = (await res.json().catch(() => ({}))) as { result?: { status?: { state?: string } } & Record<string, unknown>; error?: { code: number; message: string } };
    if (!res.ok || body.error || !body.result) {
      return { status: 502, body: { error: 'Bad Gateway', message: body.error?.message ?? `remote returned HTTP ${res.status}`, remote: r.id } };
    }
    state = body.result.status?.state ?? 'unknown';
    return { status: 200, body: { remote: r.id, skill, durationMs: Date.now() - started, task: body.result } };
  } catch (err) {
    return { status: 502, body: { error: 'Bad Gateway', message: err instanceof Error ? err.message : String(err), remote: r.id } };
  } finally {
    federationState.log.push({ id: randomUUID(), remote: r.id, skill, client, state, durationMs: Date.now() - started, at: new Date().toISOString() });
    if (federationState.log.length > 200) federationState.log.splice(0, federationState.log.length - 200);
  }
}

registerFeature({
  id: 'a2a-federation',
  since: '8.2.0',
  summary: 'Cross-gateway A2A federation: remote agent discovery (agent cards), skill catalog, task forwarding with shared audit',
  mount(router, ctx) {
    let timer: NodeJS.Timeout | undefined;
    let every = 0;
    const tick = () => {
      const c = settings(ctx.config());
      if (c) void refreshAll(c);
    };
    const schedule = () => {
      const c = settings(ctx.config());
      const want = c?.remotes.length ? c.refreshSeconds : 0;
      if (want === every) return;
      if (timer) clearInterval(timer);
      timer = undefined;
      every = want;
      if (want) {
        timer = setInterval(() => {
          tick();
          schedule();
        }, want * 1000);
        timer.unref();
        tick();
      }
    };
    schedule();
    ctx.onStop?.(() => {
      if (timer) clearInterval(timer);
      timer = undefined;
    });
    router.get('/', (_req, res) => {
      schedule();
      const c = settings(ctx.config());
      if (!c) return void res.json({ enabled: false, remotes: [], recent: [] });
      res.json({
        enabled: true,
        refreshSeconds: c.refreshSeconds,
        remotes: c.remotes.map((r) => {
          const st = federationState.remotes.get(r.id);
          return { id: r.id, url: r.url, enabled: r.enabled, skillsFilter: r.skills, clients: r.clients, status: st?.status ?? 'unknown', card: st?.card, skills: st?.skills ?? [], error: st?.error, fetchedAt: st?.fetchedAt };
        }),
        recent: federationState.log.slice(-50).reverse(),
      });
    });
    router.post('/refresh', async (_req, res) => {
      const c = settings(ctx.config());
      if (!c) return badRequest(res, 'a2aFederation is not configured');
      const out = await refreshAll(c);
      res.json({ remotes: out.map((s) => ({ id: s.id, status: s.status, skills: s.skills.length, error: s.error })) });
    });
  },
  mountClient(router, ctx) {
    router.get('/skills', async (req, res) => {
      const c = settings(ctx.config());
      if (!c) return void res.json({ skills: [] });
      const client = clientIdOf(req) ?? 'anonymous';
      const skills: Array<RemoteSkill & { remote: string; ref: string }> = [];
      for (const r of c.remotes.filter((x) => x.enabled && matchAny(x.clients, client))) {
        const st = federationState.remotes.get(r.id) ?? (await refreshRemote(r, c.timeoutMs));
        for (const s of st.skills) skills.push({ ...s, remote: r.id, ref: `${s.id}@${r.id}` });
      }
      res.json({ skills });
    });
    router.post('/send', async (req, res) => {
      const c = settings(ctx.config());
      if (!c) return void res.status(404).json({ error: 'Not Found', message: 'a2aFederation is not configured' });
      const b = objectBody(req, res);
      if (!b) return;
      if (typeof b.remote !== 'string' || typeof b.skill !== 'string') return badRequest(res, 'Body must be { "remote", "skill", "arguments"? }');
      const args = b.arguments && typeof b.arguments === 'object' && !Array.isArray(b.arguments) ? (b.arguments as Record<string, unknown>) : {};
      const r = await sendToRemote(c, b.remote, b.skill, args, clientIdOf(req) ?? 'anonymous');
      res.status(r.status).json(r.body);
    });
  },
});
