/**
 * Aggregated resources, resource templates and prompts across servers.
 *
 * - Resources keep their original URIs. When two servers list the same URI,
 *   the one with the lowest server id wins (deterministic) and the other copy
 *   is hidden; `resources/read` routes by exact URI, then by resource
 *   template, then — if only one server offers resources at all — to it.
 * - Prompt names are made unique like tool names (`mcp.toolNaming`).
 *
 * @module mcp/catalog
 */

import type { PromptInfo, ResourceInfo, ResourceTemplateInfo, ToolNaming } from '../utils/types.js';
import { buildNameIndex, type NameIndex } from './naming.js';

const byServer = <T extends { serverId: string }>(a: T, b: T) => (a.serverId < b.serverId ? -1 : a.serverId > b.serverId ? 1 : 0);

/** Resources with duplicate URIs removed (lowest server id wins), in a stable order. */
export function dedupeResources(resources: readonly ResourceInfo[]): ResourceInfo[] {
  const seen = new Set<string>();
  const out: ResourceInfo[] = [];
  for (const r of [...resources].sort((a, b) => byServer(a, b) || (a.uri < b.uri ? -1 : a.uri > b.uri ? 1 : 0))) {
    if (seen.has(r.uri)) continue;
    seen.add(r.uri);
    out.push(r);
  }
  return out;
}

const templateCache = new Map<string, RegExp>();

/** Match a URI against an RFC 6570 template (levels 1–3, enough for routing). */
export function matchesUriTemplate(template: string, uri: string): boolean {
  let re = templateCache.get(template);
  if (!re) {
    let src = '';
    let last = 0;
    for (const m of template.matchAll(/\{([+#./;?&]?)([^}]*)\}/g)) {
      src += template.slice(last, m.index).replace(/[\\^$.|+()[\]{}*?]/g, '\\$&');
      const op = m[1];
      if (op === '+' || op === '#') src += '.*';
      else if (op === '?' || op === '&') src += '(?:[?&][^#]*)?';
      else if (op === '/') src += '(?:/[^?#]*)?';
      else if (op === '.') src += '(?:\\.[^/?#]*)?';
      else if (op === ';') src += '(?:;[^/?#]*)?';
      else src += '[^/?#]+';
      last = (m.index ?? 0) + m[0].length;
    }
    src += template.slice(last).replace(/[\\^$.|+()[\]{}*?]/g, '\\$&');
    re = new RegExp(`^${src}$`, 's');
    templateCache.set(template, re);
  }
  return re.test(uri);
}

/** Server that should answer `resources/read` for `uri`, or undefined. */
export function routeResource(
  uri: string,
  resources: readonly ResourceInfo[],
  templates: readonly ResourceTemplateInfo[],
  serversWithResources: readonly string[],
): string | undefined {
  const exact = dedupeResources(resources).find((r) => r.uri === uri);
  if (exact) return exact.serverId;
  const tpl = [...templates].sort(byServer).find((t) => matchesUriTemplate(t.uriTemplate, uri));
  if (tpl) return tpl.serverId;
  const unique = [...new Set(serversWithResources)];
  return unique.length === 1 ? unique[0] : undefined;
}

export function buildPromptIndex(prompts: readonly PromptInfo[], naming: ToolNaming = 'auto'): NameIndex<PromptInfo> {
  return buildNameIndex(prompts, naming);
}

const strip = <T extends { serverId: string; serverName: string }>(x: T) => {
  const { serverId: _s, serverName: _n, ...rest } = x;
  return rest;
};

/** MCP wire objects (gateway bookkeeping fields removed). */
export const toMcpResource = (r: ResourceInfo) => strip(r);
export const toMcpResourceTemplate = (t: ResourceTemplateInfo) => strip(t);
export const toMcpPrompt = (name: string, p: PromptInfo) => ({ ...strip(p), name });
