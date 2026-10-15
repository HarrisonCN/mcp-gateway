/**
 * 16.0.0-alpha.1: config schema v13 (frozen from 16.0.0-rc.1; docs/v16/freeze.md, docs/migrating-to-v16.md).
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
 * 17.0.0-alpha.1: v13 is the only schema read (a file without `version:` is read as v13; `version: 12` is refused with
 * {@link V12_REFUSED}), and plugin API v6 removes inline module plugins: `runtime: inline` / `allowInline` are refused
 * on top of the frozen v13 format ({@link FromV13Options.release}).
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

/** 17.0.0-alpha.1: the error for an explicit `version: 12` file (16.x read it in memory and reported `schema.v12`). */
export const V12_REFUSED = 'version: config schema v12 is no longer read by 17.0.0 (16.x read it in memory and reported `schema.v12`) — rewrite the file with `mcp-gateway config migrate --to v13 --in-place -c <file>` (backup <file>.pre-v13.bak; preview with `mcp-gateway config diff --to v13 -c <file>`), see docs/migrating-to-v17.md';

export interface FromV13Options {
  /**
   * 17.0.0-alpha.1 (default): plugin API v6 runs module plugins in a worker or a child process only, so `runtime: inline`
   * and `allowInline` are refused (the v13 *format* — schema/v13, frozen from 16.0.0-rc.1 — still has them; 16.x reads
   * them). `16` checks the 16.x rules (inline needs `allowInline: true`), for the tooling that describes 16.x files.
   */
  release?: 16 | 17;
  /** Keep `version` as written (absent) instead of `12`: a file without `version:` read as v13 (17.0). */
  unversioned?: boolean;
}

/** Check a v13 file's rules; returns the v12 form (`version: 12`, `allowInline` stripped) and the errors. */
export function fromV13(raw: Record<string, unknown>, opts: FromV13Options = {}): { raw: Record<string, unknown>; errors: string[] } {
  const release = opts.release ?? 17;
  const errors: string[] = [];
  const out: Record<string, unknown> = opts.unversioned ? { ...raw } : { ...raw, version: 12 };
  if (Array.isArray(raw.plugins)) {
    out.plugins = raw.plugins.map((p, i) => {
      if (!isObj(p)) return p;
      const { allowInline, ...rest } = p;
      const isModule = typeof p.module === 'string' && p.component === undefined;
      if (isModule && (p.isolation === 'worker' || p.isolation === 'process' || p.isolation === 'inline')) {
        errors.push(`plugins.${i}.isolation: \`isolation: ${p.isolation}\` on a module plugin is not part of config schema v13 — use \`runtime: ${p.isolation}\`${p.isolation === 'inline' ? ' with `allowInline: true`' : ''} (\`mcp-gateway config migrate --to v13\` rewrites it)`);
      }
      const inline = isModule && p.runtime === 'inline';
      if (release === 17) {
        if (inline) errors.push(`plugins.${i}: \`runtime: inline\` (a module plugin in the gateway process) was removed in 17.0 — plugin API v6 module plugins run in a worker or a child process only: use \`runtime: worker\` (or \`process\`)${allowInline !== undefined ? ' and drop `allowInline`' : ''} (\`mcp-gateway config migrate --to v13\` rewrites it; docs/migrating-to-v17.md)`);
        else if (allowInline !== undefined) errors.push(`plugins.${i}.allowInline: \`allowInline\` was removed in 17.0 (inline module plugins are gone) — drop it`);
        return rest;
      }
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
