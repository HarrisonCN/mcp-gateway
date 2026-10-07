/**
 * Tool naming for the downstream MCP endpoint.
 *
 * Several upstream servers may expose tools with the same name. MCP clients
 * see one flat list, so the gateway gives every tool a unique *exposed* name:
 *
 * - `auto` (default): a tool keeps its own name when no other server exposes
 *   that name; every copy of a colliding name becomes `<serverId>__<tool>`.
 * - `prefix`: every tool is `<serverId>__<tool>`.
 *
 * The result is deterministic: tools are ordered by server id, then tool
 * name, independent of connection order. In `auto` mode the prefixed form is
 * also accepted by `tools/call` as an alias, so clients can always pin a
 * server. If an exposed name is still taken (e.g. a tool literally called
 * `a__b`), the first one in that order wins and later ones are skipped.
 *
 * @module mcp/naming
 */

import type { ToolInfo, ToolNaming } from '../utils/types.js';

export const TOOL_NAME_SEPARATOR = '__';

export interface ExposedTool {
  /** Name shown to MCP clients. */
  name: string;
  tool: ToolInfo;
}

export interface ToolIndex {
  /** Exposed tools in deterministic order. */
  list: ExposedTool[];
  /** Exposed name (and, in `auto` mode, prefixed alias) → upstream tool. */
  byName: Map<string, ToolInfo>;
}

export function prefixedName(serverId: string, toolName: string): string {
  return `${serverId}${TOOL_NAME_SEPARATOR}${toolName}`;
}

const compare = (a: ToolInfo, b: ToolInfo): number =>
  a.serverId < b.serverId ? -1 : a.serverId > b.serverId ? 1 : a.name < b.name ? -1 : a.name > b.name ? 1 : 0;

export function buildToolIndex(tools: readonly ToolInfo[], naming: ToolNaming = 'auto'): ToolIndex {
  const sorted = [...tools].sort(compare);
  const counts = new Map<string, number>();
  for (const t of sorted) counts.set(t.name, (counts.get(t.name) ?? 0) + 1);

  const list: ExposedTool[] = [];
  const byName = new Map<string, ToolInfo>();
  for (const tool of sorted) {
    const name =
      naming === 'prefix' || (counts.get(tool.name) ?? 0) > 1 ? prefixedName(tool.serverId, tool.name) : tool.name;
    if (byName.has(name)) continue;
    byName.set(name, tool);
    list.push({ name, tool });
  }
  if (naming === 'auto') {
    for (const { tool } of list) {
      const alias = prefixedName(tool.serverId, tool.name);
      if (!byName.has(alias)) byName.set(alias, tool);
    }
  }
  return { list, byName };
}

/** MCP `Tool` object for an exposed tool. */
export function toMcpTool({ name, tool }: ExposedTool): Record<string, unknown> {
  const out: Record<string, unknown> = {
    name,
    inputSchema: tool.inputSchema ?? { type: 'object' },
  };
  if (tool.title !== undefined) out.title = tool.title;
  if (tool.description !== undefined) out.description = tool.description;
  if (tool.outputSchema !== undefined) out.outputSchema = tool.outputSchema;
  if (tool.annotations !== undefined) out.annotations = tool.annotations;
  return out;
}
