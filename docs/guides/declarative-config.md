# Declarative config: admin API, `mcp-gateway diff` and `apply`

Manage a running gateway from a config file in git: review the change, then apply it without a restart.

## Admin REST API

Operators only (an API key / token without server, tool or tenant restrictions). Read-only endpoints are always on;
changes need `controlPlane.configApi: true`.

```yaml
controlPlane:
  configApi: true
```

| Endpoint | Description |
|----------|-------------|
| `GET  /api/v1/admin/config` | Running config, secrets shown as `<redacted>` |
| `POST /api/v1/admin/config/validate` | `{ valid, errors? , deprecations? }` for a config body |
| `POST /api/v1/admin/config/diff` | `{ changes: [{ path, change, restart?, before?, after? }] }` |
| `PUT  /api/v1/admin/config[?dryRun=true]` | Validate, diff and hot-apply (needs `controlPlane.configApi`) |
| `POST /api/v1/admin/reload` | Re-read the config file (CLI-started gateways; needs `controlPlane.configApi`) |
| `GET  /api/v1/admin/deprecations` | Deprecated config keys and runtime usages (removed in 3.0) |

- A body is a full config (JSON). Values left as `<redacted>` keep the running value, so `GET` → edit → `PUT` works
  without ever sending secrets back.
- `port` and `host` always come from the running process. Changes to restart-only sections (`audit`, `state`,
  `observability`, `dashboard`, `health`, …) are listed with `restart: true` and take effect after a restart.
- `policy.files` in a body resolve against the running gateway's config directory (the CLI merges them locally).

## CLI

```bash
export MCP_GATEWAY_URL=https://gateway.internal:4000
export MCP_GATEWAY_ADMIN_KEY=...            # operator key

mcp-gateway diff  -c mcp-gateway.yml          # what would change (exit 3 when there are changes)
mcp-gateway diff  -c new.yml --against old.yml  # two files, no gateway needed
mcp-gateway apply -c mcp-gateway.yml --dry-run
mcp-gateway apply -c mcp-gateway.yml          # hot-apply
```

Output:

```
+ servers.github
~ rateLimit: {"windowSeconds":60,"limit":100} → {"windowSeconds":60,"limit":200}
~ audit (restart): …
```

`--json` prints machine-readable output for CI (e.g. post the diff on a pull request, apply on merge).
