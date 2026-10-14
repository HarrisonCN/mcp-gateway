# 16.0 freeze list (drafted in 15.9.0-canary.1, implemented in 16.0.0-alpha.1, frozen in 16.0.0-rc.1)

> **Status: frozen from 16.0.0-rc.1.** 16.0.0 has not shipped: 16.0.0-rc.N is a prerelease on npm `canary` (GHCR exact
> tag only); npm `next` stays on 15.0.0-rc.N until 15.0.0 is stable. 15.0.0 itself is not stable yet (its gates are
> open, see [v15 gates](../v15/gates.md)), and stable 16.0.0 needs its own gates (A/B against the 15.0 baseline, an
> incremental external security review). A frozen list is not a passed gate.

From 16.0.0-rc.1 until 16.0.0 ships, the surfaces below are **frozen**: no renames, no removals and no changed meaning
except the 16.0 changes listed at the end. Additions that cannot break a client (a new optional key, endpoint,
response field or enum value) stay allowed, as in the [15.0 freeze](../v15/freeze.md), and are noted in the CHANGELOG
under "Additions after the freeze". Release candidates after rc.1 only fix blocking problems.

The config part is checked mechanically: `schema/v13/frozen-surface.json` records every key path and enum value of
config schema v13 at 16.0.0-rc.1, and a test (`test/v16-freeze-16-0-0-rc1.test.ts`, also
`npx tsx scripts/v13-surface.ts`) fails when one disappears or an enum narrows.

## Kept as in 15.x

Everything frozen for 15.0 stays, unchanged, in 16.0 — the REST API under `/api/v1` and `/api/v1/admin` (paths,
methods, status codes, documented fields), `/mcp` session handling, tool naming and error codes, the top-level CLI
commands and their documented flags and exit codes, the environment (`MCP_GATEWAY_*`, `${VAR}`, `secret://`), state
formats (readable by 16.0 without migration), release artefacts, metric names and audit fields, the package root
exports — with the exceptions below.

## What 16.0.0 changes (announced in 15.9)

Each change is reported by 15.9 as `DEPRECATED (removed in 16.0.0)` — a log warning once per id, `mcp-gateway validate`
and `GET /api/v1/admin/deprecations`. Ids: [deprecations](../deprecations.md#planned-removals-in-1600-announced-1590-canary0).
Migration: [migrating to v16](../migrating-to-v16.md).

| Surface | 15.x | 16.0.0 (frozen) | `config migrate --to v13` (15.9 → 16.x) |
|---|---|---|---|
| Config file | schema v12 (`version: 12`) | schema v13 (`version: 13`, JSON Schema `schema/v13/config.schema.json`); v12 files are read through an in-memory migration with a warning in 16.x and refused by 17.0; a file without `version:` is v12 in 16.x (no warning, its `v16.*` uses reported) and v13 in 17.0 | `config rollback` restores the `.pre-v13.bak` (16.0.0-alpha.2) |
| Module plugin `isolation: worker \| process \| inline` | alias of `runtime` | removed — only `runtime` | rewritten to `runtime:` |
| Inline module plugins | `runtime: inline` | need `allowInline: true` on the plugin entry (`plugins` is a list, so the opt-in is per plugin) | 15.9: pending; 16.x: `allowInline: true` added |
| `/mcp` protocol revision `2024-11-05` | accepted from downstream clients | refused; `2025-11-25`, `2025-06-18`, `2025-03-26` stay; upstream HTTP+SSE servers stay supported | 15.9: pending; 16.x: dropped from the list (already ignored) |
| Node.js | `>= 22` | `>= 24` (Node 22 maintenance ends 2027-04-30) | reported as pending |

WASM components keep `isolation: tenant | client | shared` — a different setting, not part of the alias removal.

## Not frozen

As for 15.0: deep imports, log line format, dashboard HTML/JS, exact error message texts, the audit log's on-disk
SQLite schema, `clients/` packages (versioned separately).
