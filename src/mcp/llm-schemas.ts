/**
 * Export the gateway's tools as LLM function-calling schemas.
 *
 * - `openai`: Chat Completions `tools` entries
 *   (`{ type: "function", function: { name, description, parameters } }`).
 * - `openai-responses`: Responses API entries
 *   (`{ type: "function", name, description, parameters }`).
 * - `anthropic`: Messages API `tools` entries (`{ name, description, input_schema }`).
 *
 * Both providers require names matching `^[a-zA-Z0-9_-]{1,64}$`, so exposed
 * names (the `/mcp` naming, e.g. `github__create_issue`) are sanitised and
 * de-duplicated; `mapping` tells the caller which server / tool each name is,
 * so a model's tool call can be forwarded to `POST /api/v1/tools/call`.
 *
 * @module mcp/llm-schemas
 */

import { createHash } from 'crypto';
import type { ToolInfo, ToolNaming } from '../utils/types.js';
import { buildToolIndex } from './naming.js';

export const LLM_SCHEMA_FORMATS = ['openai', 'openai-responses', 'anthropic'] as const;
export type LlmSchemaFormat = (typeof LLM_SCHEMA_FORMATS)[number];

export interface LlmToolSchemas {
  format: LlmSchemaFormat;
  /** Pass this array as the provider's `tools` parameter. */
  tools: Array<Record<string, unknown>>;
  /** LLM tool name → gateway target (`{ server, tool }` for `POST /tools/call`). */
  mapping: Record<string, { server: string; tool: string }>;
  total: number;
}

const MAX_NAME = 64;

/** Make a name valid for OpenAI / Anthropic (`^[a-zA-Z0-9_-]{1,64}$`). */
export function sanitizeToolName(name: string): string {
  let n = name.replace(/[^a-zA-Z0-9_-]/g, '_');
  if (n.length === 0) n = 'tool';
  if (n.length > MAX_NAME) {
    const h = createHash('sha256').update(name).digest('hex').slice(0, 8);
    n = `${n.slice(0, MAX_NAME - 9)}_${h}`;
  }
  return n;
}

/** JSON Schema for function parameters: always an object schema, without `$schema`. */
export function toParameters(schema: Record<string, unknown> | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = { ...(schema ?? {}) };
  delete out.$schema;
  if (out.type === undefined) out.type = 'object';
  if (out.type === 'object' && out.properties === undefined) out.properties = {};
  return out;
}

export function toLlmToolSchemas(
  tools: readonly ToolInfo[],
  format: LlmSchemaFormat,
  naming: ToolNaming = 'auto',
): LlmToolSchemas {
  const index = buildToolIndex(tools, naming);
  const mapping: LlmToolSchemas['mapping'] = {};
  const out: Array<Record<string, unknown>> = [];
  for (const { name: exposed, tool } of index.list) {
    let name = sanitizeToolName(exposed);
    for (let i = 2; mapping[name]; i++) {
      const suffix = `_${i}`;
      name = sanitizeToolName(exposed).slice(0, MAX_NAME - suffix.length) + suffix;
    }
    mapping[name] = { server: tool.serverId, tool: tool.name };
    const description = tool.description ?? tool.title ?? '';
    const parameters = toParameters(tool.inputSchema);
    switch (format) {
      case 'openai':
        out.push({ type: 'function', function: { name, description, parameters } });
        break;
      case 'openai-responses':
        out.push({ type: 'function', name, description, parameters });
        break;
      case 'anthropic':
        out.push({ name, description, input_schema: parameters });
        break;
    }
  }
  return { format, tools: out, mapping, total: out.length };
}
