/**
 * A2A (Agent2Agent) bridge: publishes the gateway's tools as an A2A agent.
 *
 * - `GET /.well-known/agent-card.json` (and the older `/.well-known/agent.json`): the Agent Card — one skill per
 *   gateway tool the caller could see (anonymous callers see the card only when `a2a.public` is true or auth is off).
 * - `POST <a2a.path>` (default `/a2a`): JSON-RPC 2.0 with `message/send` and `tasks/get`. A message selects a tool
 *   with a data part `{ "kind": "data", "data": { "skill": "<skill id>", "arguments": { … } } }` (or message
 *   `metadata.skill` + a data part with the arguments). The tool runs through the regular REST checks; the reply is
 *   a completed (or failed) Task whose artifact carries the tool result as text and data parts.
 *
 * Tasks are kept in memory for `a2a.taskRetentionSeconds` (600).
 *
 * @module bridges/a2a
 */

import express, { type Request, type RequestHandler } from 'express';
import { randomUUID } from 'crypto';
import type { A2ABridgeConfig, ToolInfo } from '../utils/types.js';
import { toLlmToolSchemas } from '../mcp/llm-schemas.js';
import { filterToolsByScope, type AccessScope } from '../auth/scopes.js';
import type { AuthedRequest } from '../auth/middleware.js';
import { CapturedResponse, type ToolCallResponse } from '../gateway/api.js';
import { VERSION } from '../utils/version.js';
import { DEPRECATIONS, deprecate } from '../utils/deprecations.js';

export const A2A_PROTOCOL_VERSION = '0.3.0';

export interface A2ABridgeDeps {
  config: () => A2ABridgeConfig | undefined;
  tools: () => ToolInfo[];
  naming: () => 'auto' | 'prefix';
  authenticate: RequestHandler;
  authRequired: () => boolean;
  runToolCall: (req: Request, body: Record<string, unknown>, res: ToolCallResponse) => Promise<void>;
}

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);

interface Task {
  kind: 'task';
  id: string;
  contextId: string;
  status: { state: 'completed' | 'failed' | 'rejected'; timestamp: string; message?: Json };
  artifacts?: Json[];
  history?: Json[];
  metadata?: Json;
}

function skillsFor(scope: AccessScope | undefined, deps: A2ABridgeDeps) {
  const tools = filterToolsByScope(scope, deps.tools());
  const schemas = toLlmToolSchemas(tools, 'openai', deps.naming());
  const byTarget = new Map(tools.map((t) => [`${t.serverId}\u0000${t.name}`, t]));
  return Object.entries(schemas.mapping).map(([id, target]) => {
    const t = byTarget.get(`${target.server}\u0000${target.tool}`);
    return {
      id,
      name: t?.title ?? target.tool,
      description: t?.description ?? `${target.tool} on ${target.server}`,
      tags: [target.server, 'mcp-tool'],
      inputModes: ['application/json'],
      outputModes: ['application/json', 'text/plain'],
      target,
      inputSchema: t?.inputSchema,
    };
  });
}

export function createA2ARouter(deps: A2ABridgeDeps): express.Router {
  const router = express.Router();
  const tasks = new Map<string, { task: Task; expires: number }>();
  const path = () => deps.config()?.path ?? '/a2a';
  const enabled = () => deps.config()?.enabled === true;

  const prune = () => {
    const now = Date.now();
    for (const [k, v] of tasks) if (v.expires <= now) tasks.delete(k);
  };

  const card = (req: Request) => {
    const cfg = deps.config() ?? {};
    const base = cfg.url ?? `${req.protocol}://${req.get('host')}`;
    const skills = skillsFor((req as AuthedRequest).scope, deps).map(({ target: _t, inputSchema: _s, ...s }) => s);
    return {
      protocolVersion: A2A_PROTOCOL_VERSION,
      name: cfg.name ?? 'mcp-gateway',
      description: cfg.description ?? 'MCP tools exposed as A2A skills by mcp-gateway',
      url: `${base.replace(/\/+$/, '')}${path()}`,
      preferredTransport: 'JSONRPC',
      version: VERSION,
      provider: cfg.provider,
      capabilities: { streaming: false, pushNotifications: false, stateTransitionHistory: false },
      defaultInputModes: ['application/json'],
      defaultOutputModes: ['application/json', 'text/plain'],
      ...(deps.authRequired() ? { securitySchemes: { bearer: { type: 'http', scheme: 'bearer' } }, security: [{ bearer: [] }] } : {}),
      skills,
    };
  };

  // Agent card: authenticated when auth is on and the card is not public (skills reflect the caller's scope).
  const cardAuth: RequestHandler = (req, res, next) => {
    if (!enabled()) return void res.status(404).json({ error: 'Not Found' });
    if (deps.config()?.public && !req.headers.authorization) return next();
    return deps.authenticate(req, res, next);
  };
  router.get(['/.well-known/agent-card.json', '/.well-known/agent.json'], cardAuth, (req, res) => {
    if (req.path === '/.well-known/agent.json') {
      deprecate(DEPRECATIONS.agentJson);
      res.set('Deprecation', 'true').set('Link', '</.well-known/agent-card.json>; rel="successor-version"');
    }
    res.set('Cache-Control', 'no-store').json(card(req));
  });

  router.post('*', (req, res, next) => {
    if (!enabled() || req.path !== path()) return next();
    deps.authenticate(req, res, async () => {
      const msg = (req.body ?? {}) as Json;
      const id = (msg.id ?? null) as string | number | null;
      const reply = (body: Json) => res.json({ jsonrpc: '2.0', id, ...body });
      const error = (code: number, message: string) => reply({ error: { code, message } });
      if (msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') return error(-32600, 'Invalid Request');
      prune();
      try {
        if (msg.method === 'tasks/get') {
          const tid = isObj(msg.params) ? msg.params.id : undefined;
          const t = typeof tid === 'string' ? tasks.get(tid) : undefined;
          if (!t) return error(-32001, 'Task not found');
          return reply({ result: t.task });
        }
        if (msg.method === 'tasks/cancel') return error(-32002, 'Task cannot be canceled (tasks complete synchronously)');
        if (msg.method !== 'message/send') return error(-32601, `Method not found: ${msg.method}`);
        const params = isObj(msg.params) ? msg.params : {};
        const message = isObj(params.message) ? params.message : undefined;
        const parts = message && Array.isArray(message.parts) ? (message.parts as unknown[]).filter(isObj) : [];
        if (!message || parts.length === 0) return error(-32602, 'params.message with parts is required');
        const data = parts.find((p) => p.kind === 'data' && isObj(p.data))?.data as Json | undefined;
        const meta = isObj(message.metadata) ? message.metadata : {};
        const skillId = typeof data?.skill === 'string' ? data.skill : typeof meta.skill === 'string' ? meta.skill : undefined;
        const skills = skillsFor((req as AuthedRequest).scope, deps);
        const skill = skillId ? skills.find((s) => s.id === skillId) : skills.length === 1 ? skills[0] : undefined;
        const contextId = typeof message.contextId === 'string' ? message.contextId : randomUUID();
        const task: Task = { kind: 'task', id: randomUUID(), contextId, status: { state: 'completed', timestamp: new Date().toISOString() }, history: [message] };
        if (!skill) {
          task.status = {
            state: 'rejected',
            timestamp: new Date().toISOString(),
            message: { kind: 'message', role: 'agent', messageId: randomUUID(), parts: [{ kind: 'text', text: skillId ? `Unknown skill "${skillId}"` : 'Choose a skill: send a data part { "skill": "<id>", "arguments": {…} }' }] },
          };
        } else {
          const args = isObj(data?.arguments) ? data!.arguments : isObj(data) && !('skill' in data) ? data : {};
          const out = new CapturedResponse();
          await deps.runToolCall(req, { tool: skill.target.tool, server: skill.target.server, arguments: args }, out);
          const body = isObj(out.body) ? out.body : {};
          if (out.statusCode === 200) {
            const result = body.result as { content?: Array<{ type: string; text?: string }>; structuredContent?: unknown; isError?: boolean } | undefined;
            const text = (result?.content ?? []).filter((c) => c.type === 'text').map((c) => c.text ?? '').join('\n');
            task.artifacts = [
              {
                artifactId: randomUUID(),
                name: `${skill.id} result`,
                parts: [...(text ? [{ kind: 'text', text }] : []), { kind: 'data', data: (result?.structuredContent ?? result ?? null) as Json }],
              },
            ];
            if (result?.isError) task.status = { state: 'failed', timestamp: new Date().toISOString() };
          } else {
            task.status = {
              state: out.statusCode === 403 || out.statusCode === 429 ? 'rejected' : 'failed',
              timestamp: new Date().toISOString(),
              message: { kind: 'message', role: 'agent', messageId: randomUUID(), parts: [{ kind: 'text', text: String(body.message ?? body.error ?? `HTTP ${out.statusCode}`) }], metadata: { httpStatus: out.statusCode, code: body.code } },
            };
          }
          task.metadata = { skill: skill.id, server: skill.target.server, tool: skill.target.tool };
        }
        tasks.set(task.id, { task, expires: Date.now() + (deps.config()?.taskRetentionSeconds ?? 600) * 1000 });
        return reply({ result: task });
      } catch (err) {
        return error(-32603, err instanceof Error ? err.message : String(err));
      }
    });
  });

  return router;
}
