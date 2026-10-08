# Migrating from 3.x to 4.0

> **Status:** 3.9 ships every v4 form (and warns about the v3 ones), so you can migrate *before* upgrading.
> This guide is finalised in the 4.0 release.

## 1. On 3.9: find what has to change

```bash
npx @winstonsayno/mcp-gateway@3.9 validate -c mcp-gateway.yml     # "Deprecated: (removed in 4.0.0) …"
curl -H "Authorization: Bearer $OPERATOR_KEY" localhost:4000/api/v1/admin/deprecations
```

## 2. Rewrite the config

```bash
npx @winstonsayno/mcp-gateway@3.9 migrate -c mcp-gateway.yml            # shows the changes + migrated file
npx @winstonsayno/mcp-gateway@3.9 migrate -c mcp-gateway.yml --write    # in place, keeps mcp-gateway.yml.bak
npx @winstonsayno/mcp-gateway@3.9 migrate -c mcp-gateway.yml --check    # CI: exit 3 when a migration is needed
```

YAML comments and layout are kept. 3.9 reads the migrated file, so you can deploy it on 3.9 first.

| v3 | v4 |
|---|---|
| `version: 3` | `version: 4` |
| `auth.apiKeys[]: { key, servers, tools, rateLimit }` | `auth.apiKeys[]: { key, scope: { servers, tools, rateLimit } }` |
| `loadBalancing.strategy: least-latency` | `strategy: smart` + `score: { latency: 1, errorRate: 0, cost: 0 }` |

## 3. Plugins

Plugins without `apiVersion` (plugin API v1) stop loading in 4.0. Add `apiVersion: 2` (3.x) — see
[Plugins](plugins.md#plugin-api-v2-30).
