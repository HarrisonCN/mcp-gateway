# Migrating to 9.0

9.0 is a breaking release built around an **event-sourced state store** and **config schema v9**. A config that
**8.9** loads without deprecation warnings runs on 9.0 unchanged.

## Checklist

1. Upgrade to 8.9 and run `mcp-gateway validate` — it lists the config deprecations (also at startup and at
   `GET /api/v1/admin/deprecations`).
2. `npx @winstonsayno/mcp-gateway@8.9 migrate --write` — rewrites the config to **schema v9** (`--to 9` is the
   default; comments kept, `.bak` written).
3. Embedders: nothing changes in code — `GatewayConfig.state` stays the internal name; only the file schema changes.

## What changes

| 8.x | 9.0 | `migrate --to 9` |
|-----|-----|------------------|
| `version: 8` (or none) | `version: 9` — 9.0 refuses `version: 8` | ✓ |
| `state: { store: memory \| redis, redis, failureMode }` | `store: { backend: memory \| redis \| eventlog, redis, failureMode }` | ✓ (`state.store` → `store.backend`) |

8.9 reads both schema versions: `version: 8` with `state`, or `version: 9` with `store` (a v9 file must not use
`state`, and `store` needs `version: 9`). 9.0 adds `backend: eventlog` — an append-only event log with snapshots that
keeps rate-limit windows, lockouts, sessions and runtime overrides across restarts.

## Deprecations in 8.9

| id | Removed in | Replacement |
|----|-----------|-------------|
| `schema-v8` | 9.0.0 | `version: 9` |
| `state-block` | 9.0.0 | `store` |
