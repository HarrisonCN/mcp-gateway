/**
 * Natural-language config assistant (8.7): describe a change in plain words, get a validated config patch and its diff
 * (dry run), then apply it.
 *
 * ```yaml
 * configAssistant:
 *   llm:                                   # optional — without it only the built-in phrasebook is used
 *     baseUrl: https://api.openai.com/v1   # any OpenAI-compatible chat-completions endpoint
 *     model: gpt-4o-mini
 *     apiKey: ${OPENAI_API_KEY}
 * ```
 *
 * Built-in phrasebook (no LLM, deterministic), one instruction per sentence / line:
 * - `rate limit [to] 50 [requests] per minute|second|hour`
 * - `block|deny <server/tool glob> [for <client glob>]`, `allow <glob> [for <client>]`,
 *   `require approval for <glob> [for <client>]`
 * - `cache <glob> for 5 minutes|seconds|hours`
 * - `add [http] server <id> at <url>`, `remove server <id>`
 * - `enable|disable audit`, `set log level [to] debug|info|warn|error`
 *
 * - `POST /admin/config-assistant/plan` `{ text }` → `{ steps, patch, changes, valid, errors?, unparsed }` (dry run;
 *   the plan is kept for 10 minutes under `planId`).
 * - `POST /admin/config-assistant/apply` `{ planId }` → applies the planned config (refuses when the running config
 *   changed since planning).
 *
 * @module features/config-assistant
 */

import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { registerFeature, objectBody, badRequest } from '../gateway/features.js';
import { portableConfig } from '../gateway/admin.js';
import type { GatewayConfig } from '../utils/types.js';

export const ConfigAssistantSchema = z
  .object({
    enabled: z.boolean().default(true),
    llm: z.object({ baseUrl: z.string().url(), model: z.string().min(1), apiKey: z.string().min(1).optional(), timeoutMs: z.number().int().min(1000).max(120_000).default(30_000) }).strict().optional(),
  })
  .strict();
export type ConfigAssistantConfig = z.input<typeof ConfigAssistantSchema>;
type Cfg = z.output<typeof ConfigAssistantSchema>;

type Raw = Record<string, unknown>;
export interface Step {
  /** The sentence this step came from. */
  text: string;
  /** What it does, in words. */
  summary: string;
  source: 'phrasebook' | 'llm';
  apply: (cfg: Raw) => void;
}

const settings = (cfg: GatewayConfig): Cfg | undefined => {
  if (!cfg.configAssistant) return undefined;
  const c = ConfigAssistantSchema.parse(cfg.configAssistant);
  return c.enabled ? c : undefined;
};
const UNIT: Record<string, number> = { second: 1, seconds: 1, sec: 1, minute: 60, minutes: 60, min: 60, hour: 3600, hours: 3600 };
const policyRules = (cfg: Raw) => {
  const p = (cfg.policy ??= {}) as Raw;
  return ((p.rules as Raw[] | undefined) ?? (p.rules = [])) as Raw[];
};
const splitTool = (glob: string): { servers?: string[]; tools: string[] } => {
  const i = glob.indexOf('/');
  return i > 0 ? { servers: [glob.slice(0, i)], tools: [glob.slice(i + 1)] } : { tools: [glob] };
};

/** Parse one instruction with the phrasebook. */
export function parseInstruction(text: string): Step | undefined {
  const t = text.trim().replace(/[.!]+$/, '');
  let m: RegExpMatchArray | null;
  if ((m = t.match(/^rate[- ]?limit(?: to)? (\d+)(?: requests| calls)? (?:per|a|\/) ?(second|minute|hour)$/i))) {
    const limit = Number(m[1]);
    const windowSeconds = UNIT[m[2]!.toLowerCase()]!;
    return { text, source: 'phrasebook', summary: `rate limit ${limit} per ${windowSeconds}s per key`, apply: (c) => void (c.rateLimit = { ...((c.rateLimit as Raw) ?? {}), limit, windowSeconds }) };
  }
  if ((m = t.match(/^(block|deny|allow|require approval for)\s+(\S+)(?:\s+for\s+(\S+))?$/i))) {
    const verb = m[1]!.toLowerCase();
    const effect = verb === 'allow' ? 'allow' : verb.startsWith('require') ? 'approve' : 'deny';
    const target = splitTool(m[2]!);
    const clients = m[3] ? [m[3]] : undefined;
    const rule = { name: `assistant: ${effect} ${m[2]}${clients ? ` for ${clients[0]}` : ''}`, effect, ...target, ...(clients ? { clients } : {}) };
    return { text, source: 'phrasebook', summary: `policy rule: ${effect} ${m[2]}${clients ? ` for ${clients[0]}` : ''} (first in order)`, apply: (c) => void policyRules(c).unshift(rule) };
  }
  if ((m = t.match(/^cache\s+(\S+)\s+for\s+(\d+)\s*(seconds?|secs?|minutes?|mins?|hours?)$/i))) {
    const unit = m[3]!.toLowerCase().replace(/s$/, '');
    const ttlSeconds = Number(m[2]) * (UNIT[unit] ?? UNIT[`${unit}s`] ?? 1);
    const target = splitTool(m[1]!);
    return {
      text,
      source: 'phrasebook',
      summary: `cache ${m[1]} for ${ttlSeconds}s`,
      apply: (c) => {
        const cache = ((c.cache as Raw) ??= {}) as Raw;
        cache.enabled = true;
        ((cache.rules as Raw[] | undefined) ?? (cache.rules = [])) && (cache.rules as Raw[]).push({ ...target, ttlSeconds });
      },
    };
  }
  if ((m = t.match(/^add (?:(?:streamable[- ])?https?\s+)?server\s+([A-Za-z0-9._-]+)\s+at\s+(https?:\/\/\S+)$/i))) {
    const id = m[1]!;
    const url = m[2]!;
    return {
      text,
      source: 'phrasebook',
      summary: `add server "${id}" (streamable-http, ${url})`,
      apply: (c) => {
        const servers = ((c.servers as Raw[] | undefined) ?? (c.servers = [])) as Raw[];
        if (servers.some((s) => s.id === id)) throw new Error(`server "${id}" already exists`);
        servers.push({ id, name: id, transport: 'streamable-http', url });
      },
    };
  }
  if ((m = t.match(/^remove server\s+([A-Za-z0-9._-]+)$/i))) {
    const id = m[1]!;
    return {
      text,
      source: 'phrasebook',
      summary: `remove server "${id}"`,
      apply: (c) => {
        const servers = (c.servers as Raw[] | undefined) ?? [];
        if (!servers.some((s) => s.id === id)) throw new Error(`no server "${id}"`);
        c.servers = servers.filter((s) => s.id !== id);
      },
    };
  }
  if ((m = t.match(/^(enable|disable) audit(?: log(?:ging)?)?$/i))) {
    const on = m[1]!.toLowerCase() === 'enable';
    return { text, source: 'phrasebook', summary: `${on ? 'enable' : 'disable'} the audit log`, apply: (c) => void (c.audit = { ...((c.audit as Raw) ?? {}), enabled: on }) };
  }
  if ((m = t.match(/^set log level(?: to)? (debug|info|warn|error)$/i))) {
    const level = m[1]!.toLowerCase();
    return { text, source: 'phrasebook', summary: `log level ${level}`, apply: (c) => void (c.logLevel = level) };
  }
  return undefined;
}

const sentences = (text: string) => text.split(/\n|(?<=[.;!])\s+|\s+and then\s+|;\s*/i).map((s) => s.trim()).filter(Boolean);

/** Ask an OpenAI-compatible model for a JSON merge patch for the instructions the phrasebook did not understand. */
export async function llmPatch(c: NonNullable<Cfg['llm']>, current: Raw, instructions: string[]): Promise<{ patch?: Raw; error?: string }> {
  const system =
    'You edit mcp-gateway YAML configs (schema version 8). Reply with ONLY a JSON object: an RFC 7386 JSON merge patch to apply to the current config ' +
    '(arrays are replaced whole). Never include secrets you were not given. If an instruction is unclear, reply {"error":"<question>"}.';
  try {
    const res = await fetch(`${c.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(c.apiKey ? { authorization: `Bearer ${c.apiKey}` } : {}) },
      signal: AbortSignal.timeout(c.timeoutMs),
      body: JSON.stringify({ model: c.model, temperature: 0, response_format: { type: 'json_object' }, messages: [{ role: 'system', content: system }, { role: 'user', content: `Current config:\n${JSON.stringify(current)}\n\nInstructions:\n${instructions.map((i) => `- ${i}`).join('\n')}` }] }),
    });
    if (!res.ok) return { error: `LLM: HTTP ${res.status}` };
    const body = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const text = body.choices?.[0]?.message?.content ?? '';
    const json = JSON.parse(text.replace(/^```(?:json)?\s*|\s*```$/g, '')) as Raw;
    if (typeof json.error === 'string') return { error: `LLM: ${json.error}` };
    if (!json || typeof json !== 'object' || Array.isArray(json)) return { error: 'LLM: reply is not a JSON object' };
    return { patch: json };
  } catch (err) {
    return { error: `LLM: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/** RFC 7386 JSON merge patch. */
export function mergePatch(target: unknown, patch: unknown): unknown {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return patch;
  const out: Raw = target && typeof target === 'object' && !Array.isArray(target) ? { ...(target as Raw) } : {};
  for (const [k, v] of Object.entries(patch as Raw)) {
    if (v === null) delete out[k];
    else out[k] = mergePatch(out[k], v);
  }
  return out;
}

const SECRET = /key|token|secret|password/i;
/** Drop secret-looking values before sending the config to an LLM. */
export const withoutSecrets = (v: unknown): unknown =>
  Array.isArray(v) ? v.map(withoutSecrets) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v as Raw).map(([k, x]) => [k, SECRET.test(k) && typeof x === 'string' ? '<redacted>' : withoutSecrets(x)])) : v;

const hash = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
const plans = new Map<string, { config: Raw; base: string; expires: number }>();

registerFeature({
  id: 'config-assistant',
  since: '8.7.0',
  summary: 'Natural-language config assistant: plain-words changes → validated config patch, diff (dry run), apply',
  mount(router, ctx) {
    router.post('/plan', async (req, res) => {
      const c = settings(ctx.config());
      if (!c) return badRequest(res, 'configAssistant is not configured');
      if (!ctx.applyConfig) return badRequest(res, 'config changes are not available on this gateway');
      const b = objectBody(req, res);
      if (!b) return;
      if (typeof b.text !== 'string' || !b.text.trim() || b.text.length > 10_000) return badRequest(res, 'Body must be { "text": "<what to change>" }');
      const current = portableConfig(ctx.config());
      const base = hash(current);
      let next = JSON.parse(JSON.stringify(current)) as Raw;
      const steps: Array<{ text: string; summary: string; source: string }> = [];
      const errors: string[] = [];
      const unparsed: string[] = [];
      for (const s of sentences(b.text)) {
        const step = parseInstruction(s);
        if (!step) {
          unparsed.push(s);
          continue;
        }
        try {
          step.apply(next);
          steps.push({ text: step.text, summary: step.summary, source: step.source });
        } catch (err) {
          errors.push(`${s}: ${(err as Error).message}`);
        }
      }
      if (unparsed.length && c.llm) {
        const r = await llmPatch(c.llm, withoutSecrets(next) as Raw, unparsed);
        if (r.patch) {
          next = mergePatch(next, r.patch) as Raw;
          steps.push({ text: unparsed.join(' '), summary: `LLM patch: ${Object.keys(r.patch).join(', ')}`, source: 'llm' });
          unparsed.length = 0;
        } else errors.push(r.error!);
      }
      let changes: unknown[] = [];
      if (steps.length && !errors.length) {
        try {
          changes = (await ctx.applyConfig(next, true)).changes;
        } catch (err) {
          errors.push((err as Error).message);
        }
      }
      const valid = steps.length > 0 && errors.length === 0;
      let planId: string | undefined;
      if (valid) {
        for (const [k, p] of plans) if (p.expires < Date.now()) plans.delete(k);
        planId = randomUUID();
        plans.set(planId, { config: next, base, expires: Date.now() + 600_000 });
      }
      res.json({ valid, planId, steps, changes, unparsed, ...(errors.length ? { errors } : {}) });
    });
    router.post('/apply', async (req, res) => {
      const b = objectBody(req, res);
      if (!b) return;
      const p = typeof b.planId === 'string' ? plans.get(b.planId) : undefined;
      if (!p || p.expires < Date.now()) return void res.status(404).json({ error: 'Not Found', message: 'unknown or expired planId — plan again' });
      if (hash(portableConfig(ctx.config())) !== p.base) return void res.status(409).json({ error: 'Conflict', message: 'the running config changed since this plan was made — plan again' });
      try {
        const { changes } = await ctx.applyConfig!(p.config, false);
        plans.delete(b.planId as string);
        res.json({ applied: true, changes });
      } catch (err) {
        res.status(400).json({ error: 'Bad Request', message: (err as Error).message });
      }
    });
  },
});
