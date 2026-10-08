# Migrating to 8.0

8.0 is a breaking release built around **plugin API v5** — one plugin contract for JavaScript and WebAssembly,
defined as a WIT world (`wit/mcp-gateway-plugin.wit`). A config that **7.9** loads without deprecation warnings, with
plugins that load without warnings, runs on 8.0 unchanged.

## Checklist

1. Upgrade to 7.9 and run `mcp-gateway validate` — it lists config deprecations; plugin API v4 plugins and
   `plugins[].wasm` entries are reported at startup and by `GET /api/v1/admin/deprecations`.
2. `npx @winstonsayno/mcp-gateway@7.9 migrate --write` — rewrites the config to **schema v8** (`--to 8` is the
   default; comments kept, `.bak` written). It prints a note for every plugin that needs a code change.
3. JavaScript plugins: declare `apiVersion: 5`. Nothing else is required — v4 return shapes keep working — but the
   `{ action }` outcomes are the documented contract ([plugin API v5](plugins-v5.md)).
4. WASM plugins: rebuild against `wit/mcp-gateway-plugin.wit` and load them with `component:` instead of `wasm:`.

## What changes

| 7.x | 8.0 | `migrate --to 8` |
|-----|-----|------------------|
| `version: 7` (or none) | `version: 8` — 8.0 refuses `version: 7` | ✓ |
| `plugins[].wasm` (3.3 core ABI: `alloc`, `on_tool_call` → packed i64) | `plugins[].component` (canonical ABI, WIT world `mcp-gateway:plugin@5.0.0`) | note — rebuild needed |
| plugin `apiVersion: 4` | `apiVersion: 5` | note |

7.9 reads both schema versions, loads both WASM ABIs and both plugin API versions, so you can migrate plugin by
plugin before upgrading.

## Deprecations in 7.9

| id | Removed in | Replacement |
|----|-----------|-------------|
| `schema-v7` | 8.0.0 | `version: 8` |
| `plugin-wasm-core` | 8.0.0 | `plugins[].component` |
| `plugin-api-v4` | 8.0.0 | `apiVersion: 5` |
