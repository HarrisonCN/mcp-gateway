# Migrating from 3.x to 4.0

4.0 removes everything 3.9 deprecated. A config or plugin that 3.9 loaded **without deprecation warnings** runs on 4.0
unchanged. Upgrade in two steps: migrate on 3.9, then bump the version.

## 1. On 3.9: find what has to change

```bash
npx @winstonsayno/mcp-gateway@3.9 validate -c mcp-gateway.yml     # "Deprecated: (removed in 4.0.0) …"
curl -H "Authorization: Bearer $OPERATOR_KEY" localhost:4000/api/v1/admin/deprecations
```

## 2. Rewrite the config

```bash
npx @winstonsayno/mcp-gateway migrate -c mcp-gateway.yml            # shows the changes + migrated file
npx @winstonsayno/mcp-gateway migrate -c mcp-gateway.yml --write    # in place, keeps mcp-gateway.yml.bak
npx @winstonsayno/mcp-gateway migrate -c mcp-gateway.yml --check    # CI: exit 3 when a migration is needed
```

`migrate` ships in 3.9 and 4.x. YAML comments and layout are kept, and 3.9 already reads the migrated file, so you
can deploy it on 3.9 before upgrading.

| Removed in 4.0 | Use instead |
|---|---|
| `version: 3` | `version: 4` (or omit `version`) |
| `auth.apiKeys[]: { key, servers, tools, rateLimit }` | `auth.apiKeys[]: { key, scope: { servers, tools, rateLimit } }` |
| `loadBalancing.strategy: least-latency` | `strategy: smart` + `score: { latency: 1, errorRate: 0, cost: 0 }` |
| Plugin API v1 (no `apiVersion`) | `apiVersion: 3` |

4.0 refuses a config that uses a removed form; each error names its replacement and points to `mcp-gateway migrate`:

```
Invalid configuration:
  - version: config schema v3 was removed in 4.0 — use `version: 4`; run `mcp-gateway migrate` (see docs/guides/migrating-to-v4.md)
  - auth.apiKeys.0: servers, rateLimit directly on an API key was removed in 4.0 — nest under `scope: { servers, tools, rateLimit }`; …
```

The admin API (`GET /api/v1/admin/config`) and `mcp-gateway diff / apply` speak schema v4 (nested `scope`).

## 3. Plugins

- **v1** (no `apiVersion`): refused at load. v1 hooks run unchanged on v3 — add `apiVersion: 3`.
- **v2**: still loads, with a deprecation warning; removed in 5.0. Change to `apiVersion: 3`.
- **v3** adds `ctx.secrets` (secrets granted in the plugin's `secrets:` config), `ctx.tenant` (caller's tenant) and the
  `onConfigChange` hook. See [Plugins](plugins.md#plugin-api-v3-40). WASM plugins are unaffected.

## 4. Embedding (`new Gateway(config)`)

Programmatic configs are not schema-validated and keep the internal shape (flat key scope). The
`loadBalancing.strategy` type no longer includes `least-latency`. Plugins passed in `options.plugins` need
`apiVersion: 2 | 3`.

## 5. Clients

The REST and `/mcp` APIs are unchanged; 2.x / 3.x JS and Kotlin clients work with 4.0.

## Checklist

- [ ] `mcp-gateway migrate --check` exits 0
- [ ] every JS plugin declares `apiVersion: 3`
- [ ] `mcp-gateway validate` prints no deprecations
- [ ] upgrade the image / package to 4.0
