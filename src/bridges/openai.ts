/**
 * OpenAI-compatible tools proxy.
 *
 * - `GET  <path>/tools` — the caller's gateway tools as OpenAI function tools (+ name mapping).
 * - `POST <path>/tool_calls` — execute OpenAI `tool_calls` (or an assistant message carrying them) and get the
 *   `role: "tool"` messages to append to the conversation.
 * - `POST <path>/chat/completions` — when `openai.upstream` is set: forward to an OpenAI-compatible API, inject the
 *   gateway tools, execute gateway tool calls and loop until the model answers (`maxToolRounds`). Calls to tools the
 *   caller supplied itself are returned to the caller untouched. `stream: true` is forwarded as is (no tool loop).
 *
 * Tool calls go through the same checks as `POST /api/v1/tools/call` (scopes, tenants, policy, quotas, cache).
 *
 * @module bridges/openai
 */

import express, { type Request, type RequestHandler, type Response } from 'express';
import type { OpenAIBridgeConfig, ToolInfo } from '../utils/types.js';
import { toLlmToolSchemas, type LlmToolSchemas } from '../mcp/llm-schemas.js';
import { filterToolsByScope, type AccessScope } from '../auth/scopes.js';
import type { AuthedRequest } from '../auth/middleware.js';
import { CapturedResponse, type ToolCallResponse } from '../gateway/api.js';
import { logger } from '../utils/logger.js';

export interface OpenAIBridgeDeps {
  config: () => OpenAIBridgeConfig | undefined;
  tools: () => ToolInfo[];
  naming: () => 'auto' | 'prefix';
  authenticate: RequestHandler;
  runToolCall: (req: Request, body: Record<string, unknown>, res: ToolCallResponse) => Promise<void>;
  fetch?: typeof fetch;
}

interface OpenAIToolCall {
  id: string;
  type?: string;
  function: { name: string; arguments?: string };
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function schemasFor(req: Request, deps: OpenAIBridgeDeps): LlmToolSchemas {
  const scope = (req as AuthedRequest).scope as AccessScope | undefined;
  return toLlmToolSchemas(filterToolsByScope(scope, deps.tools()), 'openai', deps.naming());
}

/** Text content for a `role: "tool"` message from a gateway call outcome. */
function toolContent(status: number, body: unknown): string {
  if (status === 200 && isObj(body)) {
    const result = body.result as { content?: Array<{ type: string; text?: string }>; structuredContent?: unknown } | undefined;
    if (result?.structuredContent !== undefined) return JSON.stringify(result.structuredContent);
    const text = (result?.content ?? []).filter((c) => c.type === 'text' && typeof c.text === 'string').map((c) => c.text).join('\n');
    return text || JSON.stringify(result ?? null);
  }
  const msg = isObj(body) ? (body.message ?? body.error) : body;
  return JSON.stringify({ error: String(msg ?? `HTTP ${status}`), status });
}

export async function executeToolCalls(
  req: Request,
  calls: OpenAIToolCall[],
  schemas: LlmToolSchemas,
  run: OpenAIBridgeDeps['runToolCall'],
): Promise<Array<{ role: 'tool'; tool_call_id: string; content: string }>> {
  return Promise.all(
    calls.map(async (c) => {
      const target = schemas.mapping[c.function?.name];
      if (!target) return { role: 'tool' as const, tool_call_id: c.id, content: JSON.stringify({ error: `Unknown tool "${c.function?.name}"` }) };
      let args: unknown = {};
      try {
        args = c.function.arguments ? JSON.parse(c.function.arguments) : {};
      } catch {
        return { role: 'tool' as const, tool_call_id: c.id, content: JSON.stringify({ error: 'arguments are not valid JSON' }) };
      }
      const out = new CapturedResponse();
      await run(req, { tool: target.tool, server: target.server, arguments: args }, out);
      return { role: 'tool' as const, tool_call_id: c.id, content: toolContent(out.statusCode, out.body) };
    }),
  );
}

export function createOpenAIRouter(deps: OpenAIBridgeDeps): express.Router {
  const router = express.Router();
  const fetchImpl = deps.fetch ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
  const enabled: RequestHandler = (_req, res, next) => (!deps.config() || deps.config()?.enabled === false ? void res.status(404).json({ error: 'Not Found' }) : next());

  router.get('/tools', enabled, deps.authenticate, (req, res) => {
    res.json(schemasFor(req, deps));
  });

  router.post('/tool_calls', enabled, deps.authenticate, async (req: Request, res: Response, next) => {
    try {
      const b = (req.body ?? {}) as Record<string, unknown>;
      const calls = (Array.isArray(b.tool_calls) ? b.tool_calls : isObj(b.message) && Array.isArray(b.message.tool_calls) ? b.message.tool_calls : undefined) as OpenAIToolCall[] | undefined;
      if (!calls || !calls.every((c) => isObj(c) && typeof c.id === 'string' && isObj(c.function) && typeof c.function.name === 'string')) {
        return void res.status(400).json({ error: 'Bad Request', message: 'Body must be { "tool_calls": [{ "id", "function": { "name", "arguments" } }] }' });
      }
      res.json({ messages: await executeToolCalls(req, calls, schemasFor(req, deps), deps.runToolCall) });
    } catch (err) {
      next(err);
    }
  });

  router.post('/chat/completions', enabled, deps.authenticate, async (req: Request, res: Response, next) => {
    const cfg = deps.config() ?? {};
    const up = cfg.upstream;
    if (!up?.baseUrl) return void res.status(501).json({ error: 'Not Implemented', message: 'openai.upstream.baseUrl is not configured' });
    try {
      const body = { ...((req.body ?? {}) as Record<string, unknown>) };
      const schemas = schemasFor(req, deps);
      const ownTools = Array.isArray(body.tools) ? (body.tools as Array<{ function?: { name?: string } }>) : [];
      const ownNames = new Set(ownTools.map((t) => t.function?.name).filter(Boolean));
      if (cfg.injectTools !== false && schemas.tools.length > 0) {
        body.tools = [...ownTools, ...schemas.tools.filter((t) => !ownNames.has((t.function as { name: string }).name))];
      }
      const headers: Record<string, string> = { 'content-type': 'application/json', ...(up.headers ?? {}) };
      if (up.apiKey) headers.authorization = `Bearer ${up.apiKey}`;
      const url = `${up.baseUrl.replace(/\/+$/, '')}/chat/completions`;
      const send = (payload: unknown) => fetchImpl(url, { method: 'POST', headers, body: JSON.stringify(payload), signal: AbortSignal.timeout(up.timeoutMs ?? 120_000) });

      if (body.stream === true) {
        const r = await send(body);
        res.status(r.status);
        r.headers.forEach((v, k) => {
          if (!['content-length', 'content-encoding', 'transfer-encoding', 'connection'].includes(k)) res.setHeader(k, v);
        });
        if (!r.body) return void res.end();
        for await (const chunk of r.body as unknown as AsyncIterable<Uint8Array>) res.write(chunk);
        return void res.end();
      }

      const messages = Array.isArray(body.messages) ? [...(body.messages as unknown[])] : [];
      const rounds = cfg.maxToolRounds ?? 5;
      let executed = 0;
      for (let round = 0; ; round++) {
        const r = await send({ ...body, messages });
        const text = await r.text();
        let data: unknown;
        try {
          data = JSON.parse(text);
        } catch {
          return void res.status(502).json({ error: 'Bad Gateway', message: 'Upstream returned non-JSON', status: r.status });
        }
        if (!r.ok) return void res.status(r.status).json(data);
        const choice = isObj(data) && Array.isArray(data.choices) ? (data.choices[0] as Record<string, unknown> | undefined) : undefined;
        const msg = choice && isObj(choice.message) ? choice.message : undefined;
        const calls = (msg && Array.isArray(msg.tool_calls) ? msg.tool_calls : []) as OpenAIToolCall[];
        const mine = calls.filter((c) => schemas.mapping[c.function?.name] && !ownNames.has(c.function.name));
        // Done: no tool calls, some are the caller's own tools, or out of rounds.
        if (mine.length === 0 || mine.length !== calls.length || round >= rounds) {
          if (isObj(data)) (data as Record<string, unknown>)['x_mcp_gateway'] = { toolRounds: round, toolCallsExecuted: executed };
          return void res.status(200).json(data);
        }
        messages.push(msg);
        messages.push(...(await executeToolCalls(req, mine, schemas, deps.runToolCall)));
        executed += mine.length;
        logger.debug(`OpenAI bridge: executed ${mine.length} tool call(s), round ${round + 1}`);
      }
    } catch (err) {
      next(err);
    }
  });

  return router;
}
