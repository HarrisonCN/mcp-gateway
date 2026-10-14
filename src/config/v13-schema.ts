/**
 * 16.0.0-alpha.2: the config schema v13 JSON Schema (draft-07), written to schema/v13/config.schema.json by
 * scripts/gen-schema-v13.ts. Derived from the v12 schema ({@link buildV12ConfigSchema}) with the 16.0 rules that
 * {@link fromV13} (config/v13.ts) checks at load time:
 *
 * - `version: 13`;
 * - module plugins take `runtime` only — `isolation` stays for WASM components (`tenant | client | shared`);
 * - a module plugin with `runtime: inline` needs `allowInline: true`; `allowInline` is allowed on such entries only;
 * - `mcp.protocolVersions` must not name `2024-11-05`.
 *
 * Kept out of the loader's import graph (the kernel startup bench): only the generator, docs-check and tests load it.
 * The feature-module declaration schema is unchanged in 16.0 (schema/v12/module.schema.json).
 *
 * @module config/v13-schema
 */

import { buildV12ConfigSchema } from './v12.js';

const V13_BASE = 'https://github.com/HarrisonCN/mcp-gateway/blob/main/schema/v13/';
/** Revisions `/mcp` accepts in 16.0 (src/mcp/endpoint.ts DOWNSTREAM_PROTOCOL_VERSIONS). */
const REMOVED_REVISION = '2024-11-05';

type Obj = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

/** The v13 config JSON Schema (draft-07). */
export function buildV13ConfigSchema(): Record<string, unknown> {
  const s = JSON.parse(JSON.stringify(buildV12ConfigSchema())) as Obj;
  s.$id = V13_BASE + 'config.schema.json';
  s.title = 'MCP Gateway config schema v13 (16.0, proposal until 16.0.0-rc.1)';
  s.description =
    'Config schema v13 = schema v12 with the 16.0 rules: module plugins take only `runtime`, an inline module plugin needs `allowInline: true`, `/mcp` no longer accepts revision 2024-11-05. 16.x also reads v12 files (in-memory, reported as `schema.v12`); 14.x / 15.x refuse v13. See docs/migrating-to-v16.md.';
  s.properties.version = { const: 13 };

  const plugins = s.properties.plugins as Obj | undefined;
  if (plugins) {
    plugins.description = 'Plugins in configuration order (schema v13: `runtime` only for module plugins; inline needs `allowInline: true`). See docs/guides/plugin-security.md.';
    const item = plugins.items as Obj;
    item.properties.isolation = { enum: ['tenant', 'client', 'shared'], description: 'WASM components only: sandbox per tenant | client | shared (v13: module plugins use `runtime`)' };
    item.properties.runtime = { enum: ['inline', 'worker', 'process'], default: 'worker', description: 'module plugins: where the plugin runs (worker is the default since 15.0); inline needs `allowInline: true`' };
    item.properties.allowInline = { type: 'boolean', description: 'NEW in v13: explicit opt-in for a module plugin with `runtime: inline` (runs in the gateway process)' };
    item.allOf = [
      // `isolation` is a component setting in v13
      { if: { required: ['isolation'] }, then: { required: ['component'] } },
      // runtime: inline on a module plugin → allowInline: true
      { if: { required: ['module', 'runtime'], properties: { runtime: { const: 'inline' } } }, then: { required: ['allowInline'], properties: { allowInline: { const: true } } } },
      // allowInline only on module plugins with runtime: inline
      { if: { required: ['allowInline'] }, then: { required: ['module', 'runtime'], properties: { runtime: { const: 'inline' } } } },
    ];
  }

  s.properties.mcp = {
    $comment: 'unchanged from schema v12 except protocolVersions (validated by the runtime schema)',
    type: 'object',
    properties: {
      protocolVersions: {
        type: 'array',
        description: 'v13: 2024-11-05 is not accepted on /mcp by 16.0',
        items: { type: 'string', not: { const: REMOVED_REVISION } },
      },
    },
  };
  return s;
}
