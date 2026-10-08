# Migrating to 6.0

6.0 is a breaking release. A config or plugin that **5.9** loads without deprecation warnings runs on 6.0 unchanged.

## Checklist

1. Upgrade to 5.9 and run `mcp-gateway validate` — it lists every deprecation (`GET /api/v1/admin/deprecations` does
   the same at runtime).
2. `npx @winstonsayno/mcp-gateway@5.9 migrate --write` — rewrites the config to **schema v6** in place (comments and
   layout kept, `.bak` copy written). `--check` exits 3 when a file still needs migrating (CI).
3. Plugins: declare `apiVersion: 4`.
4. Node.js 22 or newer (already the baseline since 5.0; 6.0 makes it a hard requirement in the CLI too).

## What changes

| 5.x | 6.0 | `migrate --to 6` |
|-----|-----|------------------|
| `version: 5` (or none) | `version: 6` — 6.0 refuses `version: 5` | ✓ |
| `compliance.pii` | `dlp` (5.6) | ✓ converts it |
| Plugin API v3 | refused — declare `apiVersion: 4` (adds `ctx.state`) | note only |

### `compliance.pii` → `dlp`

| `compliance.pii` | `dlp` |
|------------------|-------|
| `action: redact` | `default: { clearance: public, strategy: redact }` |
| `action: block` | `default: { clearance: public, strategy: block }` — error code **-32013** (was -32012) |
| `action: tag` | `default: { clearance: restricted }` (detected and counted, nothing masked) |
| `scope` (default `both`) | `scope` (set explicitly: DLP defaults to `results`) |
| `servers` | `servers` |
| `categories: [...]` | built-ins not listed get `levels: { <category>: public }` |
| `enabled: false` | `enabled: false` |

`compliance.residency` is unchanged. After migrating you can use what DLP adds: per-tenant clearance, `mask` /
`hash` strategies and custom detectors — see [DLP](dlp.md).
