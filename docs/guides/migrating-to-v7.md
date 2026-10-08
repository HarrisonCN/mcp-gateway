# Migrating to 7.0

7.0 is a breaking release built around the **control-plane / data-plane split**. A config that **6.9** loads without
deprecation warnings runs on 7.0 unchanged. 7.0 refuses `version: 6` and the top-level `admin` / `dashboard`
sections with a validation error that names the replacement.

## Checklist

1. Upgrade to 6.9 and run `mcp-gateway validate` — it lists every deprecation (`GET /api/v1/admin/deprecations`
   does the same at runtime).
2. `npx @winstonsayno/mcp-gateway@6.9 migrate --write` — rewrites the config to **schema v7** in place (comments and
   layout kept, `.bak` copy written; `--to 7` is the default). `--check` exits 3 when a file still needs migrating.
3. Nothing changes for plugins (plugin API v4 stays supported in 7.x) or for the Node.js baseline (22+).

## What changes

| 6.x | 7.0 | `migrate --to 7` |
|-----|-----|------------------|
| `version: 6` (or none) | `version: 7` — 7.0 refuses `version: 6` | ✓ |
| `admin: { configApi: true }` | `controlPlane: { configApi: true }` | ✓ moves it |
| `dashboard: { enabled: false }` | `controlPlane: { dashboard: false }` | ✓ moves it |

6.9 reads both forms (but not both at once), so a migrated file works before and after upgrading. 7.0 reads only `version: 7`.

### Why `controlPlane`

In 7.0 a gateway runs in one of three roles: `all` (default — what every 6.x gateway is), `control` (admin API,
dashboard, config distribution) or `data` (serves tool traffic only and pulls its config from a control plane).
Everything that belongs to the control plane — the config API and the dashboard — lives under `controlPlane`, next
to the new `role`, `url` and `token` settings. With the default role nothing else changes. See the
[control plane guide](control-plane.md) to split a deployment.

## Removed in 7.0

| Removed | Use instead |
|---------|-------------|
| `version: 6` | `version: 7` |
| `admin.configApi` | `controlPlane.configApi` |
| `dashboard.enabled` | `controlPlane.dashboard` |
| `AdminConfig` type, `normalizeControlPlane()` | `ControlPlaneConfig` (`controlPlane` on `GatewayConfig`) |

Embedders that build a `GatewayConfig` in code: replace `admin: { configApi }` with `controlPlane: { configApi }` and
`dashboard: { enabled }` with `controlPlane: { dashboard }`.

## Deprecations in 6.9

| id | Removed in | Replacement |
|----|-----------|-------------|
| `schema-v6` | 7.0.0 | `version: 7` |
| `admin-section` | 7.0.0 | `controlPlane.configApi` |
| `dashboard-section` | 7.0.0 | `controlPlane.dashboard` |
