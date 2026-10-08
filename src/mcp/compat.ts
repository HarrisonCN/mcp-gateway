/**
 * MCP protocol negotiation and per-version shaping (4.1).
 *
 * The gateway speaks several MCP revisions at once: each downstream session negotiates its own version at
 * `initialize`, and upstream servers answer with theirs. Newer features are passed through to clients that
 * understand them and downgraded for older ones:
 *
 *  - structured tool output (`outputSchema` / `structuredContent`, 2025-06-18) — older clients get the JSON as a
 *    text block (and a text block is added for new clients when an upstream only sent `structuredContent`);
 *  - resource links (`content[].type: "resource_link"`, 2025-06-18) — older clients get a text block with the URI;
 *  - tool `title` (2025-06-18) and tool annotations (`readOnlyHint`, `destructiveHint`, …, 2025-03-26) — passed
 *    through, stripped for clients older than the revision that introduced them.
 *
 * @module mcp/compat
 */

/** Downstream revisions the gateway speaks, newest first. */
export const PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'] as const;

export type ProtocolFeature = 'annotations' | 'structuredContent' | 'outputSchema' | 'resourceLink' | 'toolTitle' | 'elicitation';

const INTRODUCED: Record<ProtocolFeature, string> = {
  annotations: '2025-03-26',
  structuredContent: '2025-06-18',
  outputSchema: '2025-06-18',
  resourceLink: '2025-06-18',
  toolTitle: '2025-06-18',
  elicitation: '2025-06-18',
};

/** Does a session on `version` understand `feature`? (Revisions are ISO dates, so they compare as strings.) */
export function supports(version: string | undefined, feature: ProtocolFeature): boolean {
  return (version ?? PROTOCOL_VERSIONS[0]) >= INTRODUCED[feature];
}

/**
 * Pick the session's revision: the requested one when allowed; otherwise the newest allowed (the client decides
 * whether it can continue, as the spec says).
 */
export function negotiateVersion(requested: unknown, allowed: readonly string[] = PROTOCOL_VERSIONS): string {
  const list = allowed.length ? allowed : PROTOCOL_VERSIONS;
  if (typeof requested === 'string' && list.includes(requested)) return requested;
  return [...list].sort().reverse()[0]!;
}

/** Validate a configured `mcp.protocolVersions` list (unknown revisions are refused). */
export function unknownVersions(list: readonly string[] | undefined): string[] {
  return (list ?? []).filter((v) => !(PROTOCOL_VERSIONS as readonly string[]).includes(v));
}

/** Shape an MCP `Tool` object for a session's revision. */
export function adaptTool(tool: Record<string, unknown>, version: string | undefined): Record<string, unknown> {
  const out = { ...tool };
  if (!supports(version, 'outputSchema')) delete out.outputSchema;
  if (!supports(version, 'toolTitle')) delete out.title;
  if (!supports(version, 'annotations')) delete out.annotations;
  return out;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Shape a `tools/call` result for a session's revision. */
export function adaptToolResult(result: unknown, version: string | undefined): unknown {
  if (!isObj(result)) return result;
  const out: Record<string, unknown> = { ...result };
  let content = Array.isArray(out.content) ? [...(out.content as unknown[])] : [];
  const structured = out.structuredContent;
  if (structured !== undefined && !content.some((c) => isObj(c) && c.type === 'text')) {
    // Spec: a tool returning structured content SHOULD also return it serialized in a text block.
    content.push({ type: 'text', text: JSON.stringify(structured) });
  }
  if (!supports(version, 'structuredContent')) delete out.structuredContent;
  if (!supports(version, 'resourceLink')) {
    content = content.map((c) =>
      isObj(c) && c.type === 'resource_link'
        ? { type: 'text', text: `${typeof c.title === 'string' ? c.title : typeof c.name === 'string' ? c.name : 'Resource'}: ${String(c.uri)}` }
        : c,
    );
  }
  if (!supports(version, 'annotations')) content = content.map((c) => (isObj(c) && 'annotations' in c ? (({ annotations: _a, ...rest }) => rest)(c) : c));
  out.content = content;
  return out;
}

/** Summary of how a result was shaped (for tests / the REST `?protocol=` preview). */
export function featuresOf(version: string): Record<ProtocolFeature, boolean> {
  return Object.fromEntries((Object.keys(INTRODUCED) as ProtocolFeature[]).map((f) => [f, supports(version, f)])) as Record<ProtocolFeature, boolean>;
}
