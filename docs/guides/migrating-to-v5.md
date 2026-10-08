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

## 3. Plugins

Plugin API v4 ships in 4.9: v3 plus `ctx.state`, a per-plugin key-value store with TTLs (see
[plugins](plugins.md#plugin-api-v4-49)). Declaring `apiVersion: 4` is the only change a v2 / v3 plugin needs; v3 keeps
loading in 5.x with a deprecation warning (removed in 6.0), v2 is refused by 5.0.

## 4. Upgrade

Bump to 5.0 once `validate` shows no deprecations. 5.0 refuses the removed forms with a message naming the replacement.
