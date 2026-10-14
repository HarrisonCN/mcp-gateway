# Migrating to 16.0 (draft)

> **Status: proposal.** 16.0.0 has not shipped; its alphas go to npm `canary` only. The list below may still change
> until 16.0.0-rc.1. Stable 16.0.0 also needs the v16 release gates (A/B against the 15.0 baseline, an incremental
> external security review) — see [release gates](release-gates.md) and [v15 gates](v15/gates.md).

15.9 announces every 16.0 removal one minor ahead. Run `mcp-gateway validate -c <file>` on 15.9 and check
`GET /api/v1/admin/deprecations` on a running gateway: every line marked `removed in 16.0.0` needs a change before
upgrading. The ids are listed in [deprecations](deprecations.md#planned-removals-in-1600-announced-1590-canary0).

## What changes in 16.0 (proposal)

| Area | 15.x | 16.0 | What to do on 15.9 |
|---|---|---|---|
| Config schema | v12 | v13; v12 files read through an in-memory migration with a warning in 16.x (17.0 refuses them) | nothing yet — a `config migrate --to v13` codemod follows in 15.9.0-canary.1 |
| Module plugin runtime alias | `isolation: worker \| process \| inline` = `runtime` | only `runtime` | rename `isolation` to `runtime` on module plugins (WASM `isolation: tenant \| client \| shared` stays) |
| Inline module plugins | `runtime: inline` | needs an explicit opt-in in schema v13 | move to `runtime: worker` (or `process`); keep inline only for plugins that need HTTP hooks |
| `/mcp` protocol revisions | 2025-11-25, 2025-06-18, 2025-03-26, 2024-11-05 | without 2024-11-05 | upgrade clients that still initialize with 2024-11-05; drop it from `mcp.protocolVersions` |
| Node.js | `>= 22` | `>= 24` (Node 22 maintenance ends 2027-04-30) | run on Node 24 LTS |

Upstream servers are not affected by the protocol change: the HTTP+SSE upstream adapter stays.

## Rollback

15.9 changes no behaviour: the warnings are informational. Going back from 15.9 to 15.3 needs no config change.
