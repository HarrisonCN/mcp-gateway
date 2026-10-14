/**
 * 15.9.0-canary.0: the removals planned for 16.0.0, announced one minor ahead (docs/migrating-to-v16.md — the 16.0
 * list is a proposal until 16.0.0-rc.1). Nothing here changes behaviour; each use is a `DEPRECATED (removed in 16.0.0)`
 * warning, listed by `mcp-gateway validate` and `GET /api/v1/admin/deprecations`.
 *
 * - `v16.plugins.<i>.isolation` — `isolation: worker|process|inline` on a module plugin (alias of `runtime` since
 *   14.3.0); 16.0 keeps only `runtime`. WASM components keep `isolation: tenant|client|shared` (a different setting).
 * - `v16.plugins.<i>.inline` — a module plugin running in the gateway process; 16.0 (config schema v13) runs inline
 *   module plugins only with an explicit opt-in.
 * - `v16.mcp.protocol-2024-11-05` — `mcp.protocolVersions` naming `2024-11-05`, or (runtime) a downstream `/mcp`
 *   session that negotiates it; 16.0's `/mcp` no longer accepts that revision (upstream SSE servers stay supported).
 * - `v16.node.<major>` — Node.js older than 24; 16.0 needs `engines.node >= 24` (Node 22 maintenance ends 2027-04-30).
 *
 * @module config/v16-deprecations
 */

import type { Deprecation } from '../utils/deprecations.js';

/** Id families of the 16.0.0 deprecations (docs/deprecations.md). */
export const V16_DEPRECATION_IDS = ['v16.plugins.<i>.isolation', 'v16.plugins.<i>.inline', 'v16.mcp.protocol-2024-11-05', 'v16.node.<major>'] as const;

const R = '16.0.0';
const GUIDE = 'docs/migrating-to-v16.md';
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** Runtime announcement for a downstream `/mcp` session on revision 2024-11-05. */
export const MCP_2024_11_05: Deprecation = {
  id: 'v16.mcp.protocol-2024-11-05',
  message: `MCP protocol revision 2024-11-05 on /mcp: 16.0.0 no longer accepts it from downstream clients (${GUIDE})`,
  removedIn: R,
  replacement: 'use a client that speaks 2025-03-26 or newer; upstream servers on HTTP+SSE stay supported',
};

/** The 16.0.0 deprecations a raw v12 config (file object, before normalisation) uses. */
export function v16DeprecationsIn(raw: unknown): Deprecation[] {
  if (!isObj(raw)) return [];
  const out: Deprecation[] = [];
  (Array.isArray(raw.plugins) ? raw.plugins : []).forEach((p, i) => {
    if (!isObj(p) || typeof p.module !== 'string' || p.component !== undefined) return;
    const name = String(p.name ?? p.module);
    const iso = p.isolation;
    if (iso === 'worker' || iso === 'process' || iso === 'inline') {
      out.push({ id: `v16.plugins.${i}.isolation`, message: `plugins[${i}] (${name}) uses \`isolation: ${iso}\`, the 14.3 alias of \`runtime\`; 16.0.0 reads only \`runtime\` (${GUIDE})`, removedIn: R, replacement: iso === 'inline' ? 'runtime: worker (recommended) or runtime: process' : `runtime: ${iso}` });
    }
    if ((p.runtime ?? (iso === 'inline' ? 'inline' : undefined)) === 'inline') {
      out.push({ id: `v16.plugins.${i}.inline`, message: `plugins[${i}] (${name}) runs inline, in the gateway process; 16.0.0 (config schema v13) runs inline module plugins only with an explicit opt-in (${GUIDE})`, removedIn: R, replacement: 'runtime: worker or runtime: process (isolation, limits, permissions)' });
    }
  });
  const mcp = isObj(raw.mcp) ? raw.mcp : undefined;
  if (Array.isArray(mcp?.protocolVersions) && mcp.protocolVersions.includes('2024-11-05')) {
    out.push({ ...MCP_2024_11_05, message: `mcp.protocolVersions names 2024-11-05: 16.0.0 no longer accepts that revision on /mcp (${GUIDE})`, replacement: 'drop it from mcp.protocolVersions' });
  }
  return out;
}

/** The Node.js runtime announcement (`undefined` on Node 24 or newer). */
export function nodeDeprecation(version: string = process.versions.node): Deprecation | undefined {
  const major = Number(/^v?(\d+)/.exec(version)?.[1]);
  if (!Number.isFinite(major) || major >= 24) return undefined;
  return { id: `v16.node.${major}`, message: `running on Node.js ${version.replace(/^v/, '')}: 16.0.0 needs Node.js 24 or newer (${GUIDE})`, removedIn: R, replacement: 'Node.js 24 LTS' };
}
