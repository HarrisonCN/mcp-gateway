# Deprecations

Fields and forms that still work but are scheduled for removal. Each one is reported:

- at run time, as a log warning **once per field** per process (at start and when a reload introduces it):
  `DEPRECATED (removed in 15.0.0): ...`;
- by `mcp-gateway validate` and `GET /api/v1/admin/deprecations` (always, even when silenced).

Silence the log lines with `MCP_GATEWAY_SILENCE_DEPRECATIONS`: `all` (or `1`, `true`), or a comma-separated list of
deprecation ids or config paths, for example `MCP_GATEWAY_SILENCE_DEPRECATIONS=v12.kernel.modules,features.policyShadow`.

Earlier removals (schema v3 – v10, workflows, plugin API v1 – v4) are refused with an error naming the replacement;
see the migration guides in [docs/guides](guides).

## Config schema v11 fields (announced 13.9.0; not in schema v12 since 14.0.0; v11 files read until 15.0.0)

Config schema v12 is the runtime schema since 14.0.0 ([design](design/schema-v12.md), [upgrade guide](migration/v13-to-v14.md)).
These v11 fields are not part of it. A `version: 12` file that uses them is refused; a `version: 11` file (or an
unversioned file using one of them) is migrated in memory with one warning per field and one startup notice — until
15.0.0, which stops reading v11 files:

| Id | v11 field | v12 field | Since | Removed in |
|---|---|---|---|---|
| `v12.kernel.modules` | `kernel.modules` | `modules.activation` | 13.9.0 | 15.0.0 (14.0.0: removed from schema v12) |
| `v12.kernel.failurePolicy` | `kernel.failurePolicy` | `modules.failurePolicy` | 13.9.0 | 15.0.0 (14.0.0: removed from schema v12) |
| `v12.features.genaiTelemetry` | `features.genaiTelemetry` | `features.genaiOtel` | 13.9.0 | 15.0.0 (14.0.0: removed from schema v12) |
| `v12.features.policyShadow` | `features.policyShadow` | `features.policySim` | 13.9.0 | 15.0.0 (14.0.0: removed from schema v12) |
| `v12.features.postQuantumTls` | `features.postQuantumTls` | `features.pqTls` | 13.9.0 | 15.0.0 (14.0.0: removed from schema v12) |

On 13.x the v11 names are the only ones the gateway reads. On 14.x rewrite the file:

```bash
mcp-gateway config migrate --to v12 --in-place -c mcp-gateway.yml   # backup: mcp-gateway.yml.v11.bak
mcp-gateway config diff --to v12 -c mcp-gateway.yml                 # preview only
```

Exit codes: `config migrate` 1 when the compatibility report has errors; `config diff` 3 when the file would change,
1 on errors. Comments and layout of YAML files are kept.

## Planned removals in 16.0.0 (announced 15.9.0-canary.0)

The 16.0 list is a **proposal** until 16.0.0-rc.1 ([migrating to v16](migrating-to-v16.md)). 15.x keeps working
exactly as before; each use below is reported as `DEPRECATED (removed in 16.0.0)`:

| Id | What | Instead | Since |
|---|---|---|---|
| `v16.plugins.<i>.isolation` | `isolation: worker \| process \| inline` on a module plugin (the 14.3 alias of `runtime`) | `runtime: worker` / `runtime: process` (WASM components keep `isolation: tenant \| client \| shared`) | 15.9.0-canary.0 |
| `v16.plugins.<i>.inline` | a module plugin running inline, in the gateway process | `runtime: worker` or `runtime: process`; 16.0 (config schema v13) runs inline module plugins only with an explicit opt-in | 15.9.0-canary.0 |
| `v16.mcp.protocol-2024-11-05` | `mcp.protocolVersions` naming `2024-11-05`, or a downstream `/mcp` session that negotiates it (runtime) | a client on 2025-03-26 or newer (upstream HTTP+SSE servers stay supported) | 15.9.0-canary.0 |
| `v16.node.<major>` | running on Node.js older than 24 (runtime) | Node.js 24 LTS (`engines.node >= 24` in 16.0) | 15.9.0-canary.0 |

`mcp-gateway config migrate --to v13` (15.9.0-canary.1) rewrites the `isolation` alias and lists the rest
([migrating to v16](migrating-to-v16.md#the-codemod-config-migrate---to-v13-1590-canary1)); the 16.0 freeze list is in [v16 freeze](v16/freeze.md).

## Removed in 15.0.0 (announced 14.9.0)

14.9.0 lists these for every config it loads (log warning once per id, `mcp-gateway validate`,
`GET /api/v1/admin/deprecations`). The full freeze list is [docs/v15/freeze.md](v15/freeze.md); the upgrade steps are
in [migrating to v15](migrating-to-v15.md).

| Id | What 14.x does | What 15.0.0 does | Do this now |
|---|---|---|---|
| `schema.v11` | reads `version: 11` files, migrated in memory (the `v12.*` ids above) | refuses them | `mcp-gateway config migrate --to v12 --in-place -c mcp-gateway.yml` |
| `v15.plugins.<i>.runtime` | runs a module plugin without `runtime` / `isolation` inline, in the gateway process | runs it in a `worker` (own heap, `limits`, `permissions`, crash isolation) | set `runtime: worker` and test it, or `runtime: inline` to keep the 14.x behaviour |
| `v15.config.unknown-key.<key>` | ignores a top-level key that is not part of schema v12 (`include:` of a GitOps fragment, a typo such as `servrs:`) | refuses the file | remove or fix the key; render GitOps directories with `mcp-gateway gitops render` |

The `schema/v12-draft/` alias (the 13.9 path of the v12 JSON schemas) is removed in 15.0.0 as well; use
`schema/v12/config.schema.json`.
