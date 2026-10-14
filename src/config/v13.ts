/**
 * 16.0.0-alpha.1: config schema v13 (proposal until 16.0.0-rc.1; docs/v16/freeze.md, docs/migrating-to-v16.md).
 *
 * v13 is schema v12 with the 16.0 changes enforced:
 * - module plugins take only `runtime` (the 14.3 `isolation: worker | process | inline` alias is refused; WASM
 *   components keep `isolation: tenant | client | shared`);
 * - an inline module plugin (`runtime: inline`) needs `allowInline: true` on its entry (`plugins` is a list, so the
 *   opt-in is per plugin); `allowInline` on anything else is an error;
 * - `mcp.protocolVersions` must not name `2024-11-05` (16.0's `/mcp` no longer accepts it).
 * {@link fromV13} checks those rules on the raw file and returns the v12 form the loader validates further.
 *
 * Schema v12 files are read in 16.x (in-memory, as before) and reported once as `schema.v12` (17.0.0 refuses them).
 *
 * @module config/v13
 */

import type { Deprecation } from '../utils/deprecations.js';

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** Notice for an explicit `version: 12` file read by 16.x. */
export const SCHEMA_V12_NOTICE: Deprecation = {
  id: 'schema.v12',
  message: 'config schema v12 (`version: 12`) is read by 16.x and refused by 17.0.0 — run `mcp-gateway config migrate --to v13 --in-place` (docs/migrating-to-v16.md)',
  removedIn: '17.0.0',
  replacement: 'version: 13',
};

/** Check a `version: 13` file's v13 rules; returns the v12 form (`version: 12`, `allowInline` stripped) and the errors. */
export function fromV13(raw: Record<string, unknown>): { raw: Record<string, unknown>; errors: string[] } {
  const errors: string[] = [];
  const out: Record<string, unknown> = { ...raw, version: 12 };
  if (Array.isArray(raw.plugins)) {
    out.plugins = raw.plugins.map((p, i) => {
      if (!isObj(p)) return p;
      const { allowInline, ...rest } = p;
      const isModule = typeof p.module === 'string' && p.component === undefined;
      if (isModule && (p.isolation === 'worker' || p.isolation === 'process' || p.isolation === 'inline')) {
        errors.push(`plugins.${i}.isolation: \`isolation: ${p.isolation}\` on a module plugin is not part of config schema v13 — use \`runtime: ${p.isolation}\`${p.isolation === 'inline' ? ' with `allowInline: true`' : ''} (\`mcp-gateway config migrate --to v13\` rewrites it)`);
      }
      const inline = isModule && p.runtime === 'inline';
      if (allowInline !== undefined && (typeof allowInline !== 'boolean' || !inline)) {
        errors.push(`plugins.${i}.allowInline: \`allowInline\` applies to module plugins with \`runtime: inline\` only (and must be true or false)`);
      } else if (inline && allowInline !== true) {
        errors.push(`plugins.${i}: an inline module plugin (\`runtime: inline\`, in the gateway process) needs \`allowInline: true\` in config schema v13 — or move it to \`runtime: worker\` / \`process\``);
      }
      return rest;
    });
  }
  const mcp = isObj(raw.mcp) ? raw.mcp : undefined;
  if (Array.isArray(mcp?.protocolVersions) && mcp.protocolVersions.includes('2024-11-05')) {
    errors.push('mcp.protocolVersions: MCP revision 2024-11-05 is not accepted on /mcp by 16.0 — remove it (supported: 2025-11-25, 2025-06-18, 2025-03-26)');
  }
  return { raw: out, errors };
}
