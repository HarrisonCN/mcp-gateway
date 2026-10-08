/**
 * Tool chains and multi-agent orchestration (4.2).
 *
 * A chain is a named, declarative pipeline of tool calls that runs inside the gateway:
 *
 * ```yaml
 * chains:
 *   - name: triage
 *     description: Search issues, summarise each hit with the LLM agent, file a report
 *     steps:
 *       - id: hits
 *         tool: github/search_issues
 *         args: { q: "{{input.query}}" }
 *       - id: summaries                 # fan-out: one call per item (agents in parallel)
 *         forEach: "steps.hits.structuredContent.items"
 *         concurrency: 4
 *         tool: agent/summarise
 *         args: { text: "{{item.body}}" }
 *       - parallel:                     # independent steps at once
 *           - { id: a, tool: search/web, args: { q: "{{input.query}}" } }
 *           - { id: b, tool: docs/search, args: { q: "{{input.query}}" } }
 *       - id: report
 *         when: "input.file"            # skipped when falsy
 *         tool: github/create_issue
 *         args: { title: "Triage: {{input.query}}", body: "{{steps.summaries}}" }
 * ```
 *
 * Templates: `{{path}}` reads `input.*`, `steps.<id>.*` (a step's MCP result; `structuredContent` / `text` shortcuts)
 * and `item` / `index` inside `forEach`. A string that is exactly one `{{path}}` keeps the value's type. Every step
 * runs through the normal invoker (scopes, policy, plugins, quotas, audit) as the calling client; a step outside the
 * caller's scope fails the chain before anything runs.
 *
 * @module orchestration/chains
 */

import type { ProxyResponse } from '../utils/types.js';

export interface ChainStep {
  id?: string;
  /** `server/tool`. */
  tool?: string;
  args?: Record<string, unknown>;
  /** Path that must be truthy for the step to run. Prefix with `!` to negate. */
  when?: string;
  /** Path of an array: the step runs once per item (`{{item}}`, `{{index}}`). */
  forEach?: string;
  /** Parallel calls for `forEach` (default 4). */
  concurrency?: number;
  /** Steps run concurrently (each with its own id). */
  parallel?: ChainStep[];
  /** Keep going when this step fails (its result is `{ error }`). */
  continueOnError?: boolean;
}

export interface ChainConfig {
  name: string;
  description?: string;
  /** JSON Schema of the chain input (advertised as the tool's `inputSchema`). */
  inputSchema?: Record<string, unknown>;
  steps: ChainStep[];
  /** Template of the chain result (default: the last step's result). */
  output?: unknown;
  /** Upper bound for the whole run (default 60 s). */
  timeoutMs?: number;
}

export interface ChainsConfig {
  /** Expose chains as MCP / REST tools named `<toolPrefix><name>` (default `chain_`). */
  toolPrefix?: string;
  chains?: ChainConfig[];
}

export interface ChainStepRecord {
  id: string;
  tool?: string;
  status: 'ok' | 'error' | 'skipped';
  durationMs: number;
  calls: number;
  error?: string;
}

export interface ChainRunResult {
  chain: string;
  success: boolean;
  output: unknown;
  steps: ChainStepRecord[];
  durationMs: number;
  error?: string;
}

export type ChainInvoke = (serverId: string, tool: string, args: Record<string, unknown>) => Promise<ProxyResponse>;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Split `server/tool`. */
export function parseTarget(t: string): { serverId: string; tool: string } | undefined {
  const i = t.indexOf('/');
  if (i <= 0 || i === t.length - 1) return undefined;
  return { serverId: t.slice(0, i), tool: t.slice(i + 1) };
}

/** Read a dotted path (`a.b.0.c`). */
export function readPath(scope: Record<string, unknown>, path: string): unknown {
  let cur: unknown = scope;
  for (const part of path.trim().split('.')) {
    if (part === '') continue;
    if (Array.isArray(cur)) cur = part === 'length' ? cur.length : cur[Number(part)];
    else if (isObj(cur)) cur = cur[part];
    else return undefined;
  }
  return cur;
}

const ONE = /^\{\{\s*([^}]+?)\s*\}\}$/;
const ANY = /\{\{\s*([^}]+?)\s*\}\}/g;

/** Render a template value against a scope. */
export function render(tpl: unknown, scope: Record<string, unknown>): unknown {
  if (typeof tpl === 'string') {
    const one = tpl.match(ONE);
    if (one) return readPath(scope, one[1]!);
    return tpl.replace(ANY, (_m, p: string) => {
      const v = readPath(scope, p);
      return v === undefined || v === null ? '' : typeof v === 'string' ? v : JSON.stringify(v);
    });
  }
  if (Array.isArray(tpl)) return tpl.map((x) => render(x, scope));
  if (isObj(tpl)) return Object.fromEntries(Object.entries(tpl).map(([k, v]) => [k, render(v, scope)]));
  return tpl;
}

/** Shape an MCP result for templates: the raw result plus `text` / `structuredContent` shortcuts. */
export function stepValue(result: unknown): Record<string, unknown> {
  const r = isObj(result) ? result : { value: result };
  const text = Array.isArray(r.content)
    ? (r.content as unknown[]).filter((c) => isObj(c) && c.type === 'text').map((c) => String((c as { text?: unknown }).text ?? '')).join('\n')
    : undefined;
  return { ...r, ...(text !== undefined ? { text } : {}) };
}

/** Every `server/tool` a chain calls (for scope checks and validation). */
export function chainTargets(steps: readonly ChainStep[]): string[] {
  const out: string[] = [];
  for (const s of steps) {
    if (s.tool) out.push(s.tool);
    if (s.parallel) out.push(...chainTargets(s.parallel));
  }
  return [...new Set(out)];
}

/** Static validation (ids unique, every step has a tool or parallel group, targets well-formed). */
export function validateChains(cfg: ChainsConfig | undefined): string[] {
  const errors: string[] = [];
  const names = new Set<string>();
  for (const [ci, c] of (cfg?.chains ?? []).entries()) {
    if (names.has(c.name)) errors.push(`chains.chains.${ci}.name: duplicate chain "${c.name}"`);
    names.add(c.name);
    const ids = new Set<string>();
    const walk = (steps: ChainStep[], path: string) =>
      steps.forEach((s, i) => {
        const p = `${path}.${i}`;
        if (!!s.tool === !!s.parallel) errors.push(`${p}: a step needs exactly one of "tool" or "parallel"`);
        if (s.tool && !parseTarget(s.tool)) errors.push(`${p}.tool: must be "server/tool"`);
        if (s.parallel && s.forEach) errors.push(`${p}: "forEach" cannot be combined with "parallel"`);
        if (s.id) {
          if (ids.has(s.id)) errors.push(`${p}.id: duplicate step id "${s.id}"`);
          ids.add(s.id);
        }
        if (s.parallel) walk(s.parallel, `${p}.parallel`);
      });
    walk(c.steps, `chains.chains.${ci}.steps`);
  }
  return errors;
}

async function pool<T, R>(items: T[], n: number, fn: (x: T, i: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(n, items.length)) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]!, i);
      }
    }),
  );
  return out;
}

class StepError extends Error {}

/** Run one chain. */
export async function runChain(chain: ChainConfig, input: Record<string, unknown>, invoke: ChainInvoke, opts: { now?: () => number } = {}): Promise<ChainRunResult> {
  const now = opts.now ?? Date.now;
  const started = now();
  const steps: Record<string, unknown> = {};
  const records: ChainStepRecord[] = [];
  let last: unknown;
  const deadline = started + (chain.timeoutMs ?? 60_000);

  const call = async (target: string, args: Record<string, unknown>): Promise<unknown> => {
    if (now() > deadline) throw new StepError(`chain timed out after ${chain.timeoutMs ?? 60_000}ms`);
    const t = parseTarget(target)!;
    const r = await invoke(t.serverId, t.tool, args);
    if (!r.success) throw new StepError(r.error?.message ?? 'call failed');
    const res = r.result as { isError?: boolean } | undefined;
    if (res?.isError) throw new StepError(`${target} returned an error: ${String(stepValue(res).text ?? '').slice(0, 200)}`);
    return stepValue(r.result);
  };

  const runStep = async (s: ChainStep, idx: number): Promise<void> => {
    const id = s.id ?? `step${idx}`;
    const t0 = now();
    const scope = { input, steps };
    if (s.when) {
      const neg = s.when.startsWith('!');
      const v = readPath(scope, neg ? s.when.slice(1) : s.when);
      if (neg ? !!v : !v) {
        records.push({ id, tool: s.tool, status: 'skipped', durationMs: 0, calls: 0 });
        return;
      }
    }
    if (s.parallel) {
      await Promise.all(s.parallel.map((p, j) => runStep(p, idx * 100 + j)));
      return;
    }
    let calls = 0;
    try {
      let value: unknown;
      if (s.forEach) {
        const list = readPath(scope, s.forEach);
        if (!Array.isArray(list)) throw new StepError(`forEach "${s.forEach}" is not an array`);
        value = await pool(list, s.concurrency ?? 4, async (item, index) => {
          calls++;
          return call(s.tool!, render(s.args ?? {}, { ...scope, item, index }) as Record<string, unknown>);
        });
      } else {
        calls++;
        value = await call(s.tool!, render(s.args ?? {}, scope) as Record<string, unknown>);
      }
      steps[id] = value;
      last = value;
      records.push({ id, tool: s.tool, status: 'ok', durationMs: now() - t0, calls });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      records.push({ id, tool: s.tool, status: 'error', durationMs: now() - t0, calls, error: message });
      if (!s.continueOnError) throw new StepError(`step "${id}" failed: ${message}`);
      steps[id] = { error: message };
    }
  };

  try {
    for (const [i, s] of chain.steps.entries()) await runStep(s, i);
    const output = chain.output !== undefined ? render(chain.output, { input, steps }) : last;
    return { chain: chain.name, success: true, output, steps: records, durationMs: now() - started };
  } catch (err) {
    return { chain: chain.name, success: false, output: undefined, steps: records, durationMs: now() - started, error: err instanceof Error ? err.message : String(err) };
  }
}

/** MCP tool result for a chain run. */
export function chainToolResult(r: ChainRunResult): Record<string, unknown> {
  if (!r.success) return { content: [{ type: 'text', text: `Chain "${r.chain}" failed: ${r.error}` }], isError: true, structuredContent: { steps: r.steps } };
  const out = r.output;
  const text = isObj(out) && typeof out.text === 'string' ? out.text : typeof out === 'string' ? out : JSON.stringify(out ?? null);
  return { content: [{ type: 'text', text }], structuredContent: { output: isObj(out) && 'structuredContent' in out ? out.structuredContent : (out ?? null), steps: r.steps } };
}
