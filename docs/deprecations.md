# Deprecations

Fields and forms that still work but are scheduled for removal. Each one is reported:

- at run time, as a log warning **once per field** per process (at start and when a reload introduces it):
  `DEPRECATED (removed in 14.0.0): ...`;
- by `mcp-gateway validate` and `GET /api/v1/admin/deprecations` (always, even when silenced).

Silence the log lines with `MCP_GATEWAY_SILENCE_DEPRECATIONS`: `all` (or `1`, `true`), or a comma-separated list of
deprecation ids or config paths, for example `MCP_GATEWAY_SILENCE_DEPRECATIONS=v12.kernel.modules,features.policyShadow`.

Earlier removals (schema v3 – v10, workflows, plugin API v1 – v4) are refused with an error naming the replacement;
see the migration guides in [docs/guides](guides).

## Schema v12 inventory (13.9.0, removed in 14.0.0)

Config schema v12 is a draft in 13.x ([design](design/schema-v12.md)). These v11 fields are removed or renamed by it:

| Id | v11 field | v12 field | Since | Removed in |
|---|---|---|---|---|
| `v12.kernel.modules` | `kernel.modules` | `modules.activation` | 13.9.0 | 14.0.0 |
| `v12.kernel.failurePolicy` | `kernel.failurePolicy` | `modules.failurePolicy` | 13.9.0 | 14.0.0 |
| `v12.features.genaiTelemetry` | `features.genaiTelemetry` | `features.genaiOtel` | 13.9.0 | 14.0.0 |
| `v12.features.policyShadow` | `features.policyShadow` | `features.policySim` | 13.9.0 | 14.0.0 |
| `v12.features.postQuantumTls` | `features.postQuantumTls` | `features.pqTls` | 13.9.0 | 14.0.0 |

In 13.x the v11 names are the only ones the gateway reads: do **not** rename them in a running config yet. Preview the
rewrite instead:

```bash
mcp-gateway config migrate --to v12 --dry-run --json -c mcp-gateway.yml
mcp-gateway config diff --to v12 -c mcp-gateway.yml
```

Exit codes: `config migrate` 1 when the compatibility report has errors; `config diff` 3 when the file would change,
1 on errors. Comments and layout of YAML files are kept.
