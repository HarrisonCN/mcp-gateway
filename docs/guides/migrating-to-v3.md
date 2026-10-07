# Migrating from 2.x to 3.0

3.0 removes what 2.9 deprecated, settles the config schema at **v3** and introduces **plugin API v2**. Most
2.9 configurations that start without deprecation warnings run unchanged.

## Before you upgrade

On 2.9, check for deprecation warnings:

```bash
npx @winstonsayno/mcp-gateway@2.9 validate -c mcp-gateway.yml     # prints "Deprecated (removed in 3.0)"
curl -H "Authorization: Bearer $OPERATOR_KEY" localhost:4000/api/v1/admin/deprecations
```

## Breaking changes

| Change | What to do |
|---|---|
| **`corsOrigins` removed** | Use `cors: { origins: [...] }`. The old key is a validation error naming the replacement. |
| **`healthCheckIntervalMs` removed** | Use `health: { intervalMs: ... }`. |
| **Config schema v3**: `version`, when present, must be `3` (2.9 accepted `version: 2`). | Set `version: 3` or remove the key. |
| **`/.well-known/agent.json` removed** (A2A bridge) | Use `/.well-known/agent-card.json`. |
| **Plugin API v2** (`PLUGIN_API_VERSION = 2`): hooks receive a hook context as their last argument; new `onError` hook. | Add `apiVersion: 2` to your plugins. v1 plugins still load with a deprecation warning until 4.0. |
| `GatewayConfig.corsOrigins` / `healthCheckIntervalMs` removed from the TypeScript types. | Embedders: use `cors.origins` / `health.intervalMs`. |
| `GET /api/v1/admin/deprecations` no longer has a top-level `removedIn`; each entry carries its own. | Read `removedIn` per entry. |

Runtime requirements are unchanged: Node.js 22+, Docker image `node:22-alpine`.

## Config: before / after

```yaml
# 2.x
corsOrigins: ["https://app.example.com"]
healthCheckIntervalMs: 15000
```

```yaml
# 3.0
version: 3
cors:
  origins: ["https://app.example.com"]
health:
  intervalMs: 15000
```

## Plugins: before / after

```js
// 2.x (plugin API v1)
export default { name: 'audit', onResponse(call, result) { return result; } };

// 3.0 (plugin API v2)
export default {
  name: 'audit',
  apiVersion: 2,
  onResponse(call, result, hook) { hook.logger.debug(`${call.name} ok`); return result; },
  onError(call, error, hook) { hook.logger.warn(`${call.name}: ${error.message}`); },
};
```

## Clients

The REST API stays at `/api/v1` and the `/mcp` endpoint is unchanged; the JS (`@winstonsayno/mcp-gateway-client`) and
Kotlin clients 2.x keep working against 3.0.

## Rolling out with `apply`

With `admin.configApi: true` on the new gateway you can roll out the migrated file without a restart:

```bash
mcp-gateway diff  -c mcp-gateway.yml --url https://gw.internal:4000 --key $OPERATOR_KEY
mcp-gateway apply -c mcp-gateway.yml --url https://gw.internal:4000 --key $OPERATOR_KEY
```

## Checklist

1. On 2.9: `mcp-gateway validate` shows no deprecations.
2. Rename `corsOrigins` → `cors.origins`, `healthCheckIntervalMs` → `health.intervalMs`; set `version: 3` (optional).
3. Point A2A clients at `/.well-known/agent-card.json`.
4. Add `apiVersion: 2` to your plugins.
5. Upgrade: `npm i @winstonsayno/mcp-gateway@3` or `ghcr.io/harrisoncn/mcp-gateway:3.0.0`.
6. `mcp-gateway validate -c mcp-gateway.yml`.

See also: [Roadmap](../ROADMAP.md).
