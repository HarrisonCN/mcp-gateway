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

type Named = { serverId: string; name: string };

const compare = (a: Named, b: Named): number =>
  a.serverId < b.serverId ? -1 : a.serverId > b.serverId ? 1 : a.name < b.name ? -1 : a.name > b.name ? 1 : 0;

export interface NameIndex<T extends Named> {
  list: Array<{ name: string; item: T }>;
  byName: Map<string, T>;
}

/**
 * Unique exposed names for items (tools, prompts) that several servers may
 * share by name; see the module comment for the rules.
 */
export function buildNameIndex<T extends Named>(items: readonly T[], naming: ToolNaming = 'auto'): NameIndex<T> {
  const sorted = [...items].sort(compare);
  const counts = new Map<string, number>();
  for (const t of sorted) counts.set(t.name, (counts.get(t.name) ?? 0) + 1);

  const list: Array<{ name: string; item: T }> = [];
  const byName = new Map<string, T>();
  for (const item of sorted) {
    const name =
      naming === 'prefix' || (counts.get(item.name) ?? 0) > 1 ? prefixedName(item.serverId, item.name) : item.name;
    if (byName.has(name)) continue;
    byName.set(name, item);
    list.push({ name, item });
  }
  if (naming === 'auto') {
    for (const { item } of list) {
      const alias = prefixedName(item.serverId, item.name);
      if (!byName.has(alias)) byName.set(alias, item);
    }
  }
  return { list, byName };
}

export function buildToolIndex(tools: readonly ToolInfo[], naming: ToolNaming = 'auto'): ToolIndex {
  const { list, byName } = buildNameIndex(tools, naming);
  return { list: list.map(({ name, item }) => ({ name, tool: item })), byName };
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
