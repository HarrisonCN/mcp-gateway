# Migrating from 4.x to 5.0

5.0 removes everything 4.9 deprecates. A config or plugin that 4.9 loads **without deprecation warnings** runs on 5.0
unchanged. Upgrade in two steps: migrate on 4.9, then bump the version.

## 1. On 4.9: find what has to change

```bash
npx @winstonsayno/mcp-gateway@4.9 validate -c mcp-gateway.yml     # "! (removed in 5.0.0) …"
curl -H "Authorization: Bearer $OPERATOR_KEY" localhost:4000/api/v1/admin/deprecations
```

The gateway also logs each deprecation once at start-up (`DEPRECATED (removed in 5.0.0): …`).

## 2. Rewrite the config

```bash
npx @winstonsayno/mcp-gateway@4.9 migrate --to 5 -c mcp-gateway.yml           # shows the changes + migrated file
npx @winstonsayno/mcp-gateway@4.9 migrate --to 5 -c mcp-gateway.yml --write   # in place, keeps mcp-gateway.yml.bak
npx @winstonsayno/mcp-gateway@4.9 migrate --to 5 -c mcp-gateway.yml --check   # CI: exit 3 when a migration is needed
```

`--to 5` is the default since 4.9 and also applies the 4.0 steps, so a 3.x file goes straight to v5. YAML comments and
layout are kept, and **4.9 already reads schema v5**, so you can deploy the migrated file on 4.9 before upgrading.

| Removed in 5.0 | Use instead |
|---|---|
| `version: 4` | `version: 5` (or omit `version`) |
| `servers[].timeout` | `servers[].timeoutMs` (same meaning, milliseconds) |
| Plugin API v2 | `apiVersion: 4` |
| `normalizeV4Preview()` (library) | `normalizeApiKeyScopes()` |

On 5.0 itself `mcp-gateway migrate` still rewrites v3 / v4 files (`--to 5` is the default), so you can also migrate
after upgrading — the gateway just refuses to start until you do.

## 3. Plugins

Plugin API v4 ships in 4.9: v3 plus `ctx.state`, a per-plugin key-value store with TTLs (see
[plugins](plugins.md#plugin-api-v4-49)). Declaring `apiVersion: 4` is the only change a v2 / v3 plugin needs; v3 keeps
loading in 5.x with a deprecation warning (removed in 6.0), v2 is refused by 5.0.

## 4. Upgrade

Bump to 5.0 once `validate` shows no deprecations. 5.0 refuses the removed forms with a message naming the replacement:

```
Invalid configuration:
  - version: config schema v4 was removed in 5.0 — use `version: 5`; run `mcp-gateway migrate` (see docs/guides/migrating-to-v5.md)
  - servers.0.timeout: removed in 5.0 — use `timeoutMs`; run `mcp-gateway migrate` (see docs/guides/migrating-to-v5.md)
```

## What else changes in 5.0

- The admin API (`GET /api/v1/admin/config`) and the dashboard's Config tab use `timeoutMs`.
- `PLUGIN_API_MIN_VERSION` is 3; v3 plugins log `DEPRECATED (removed in 6.0.0)` once.
- Library embedders: the in-memory `McpServerConfig` passed to `new Gateway()` keeps its `timeout` field (it is the
  internal shape, not the file schema); `validateConfig()` / `loadConfig()` map `timeoutMs` onto it.
- Unchanged: REST / MCP / edge APIs, the JS / Kotlin / Python / Go / Swift clients (no client upgrade needed), Docker
  base image (Node 22), dashboard CSP.

## Deprecated in 5.0 (removed in 6.0)

- Plugin API v3 — declare `apiVersion: 4`.
