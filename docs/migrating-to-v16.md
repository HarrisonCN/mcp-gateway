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
| Config schema | v12 | v13; v12 files read through an in-memory migration with a warning in 16.x (17.0 refuses them) | nothing to change by hand — run the codemod below (the file stays `version: 12` on 15.x) |
| Module plugin runtime alias | `isolation: worker \| process \| inline` = `runtime` | only `runtime` | rename `isolation` to `runtime` on module plugins (WASM `isolation: tenant \| client \| shared` stays) |
| Inline module plugins | `runtime: inline` | needs `allowInline: true` on the plugin entry in schema v13 | move to `runtime: worker` (or `process`); keep inline only for plugins that need HTTP hooks |
| `/mcp` protocol revisions | 2025-11-25, 2025-06-18, 2025-03-26, 2024-11-05 | without 2024-11-05 | upgrade clients that still initialize with 2024-11-05; drop it from `mcp.protocolVersions` |
| Node.js | `>= 22` | `>= 24` (Node 22 maintenance ends 2027-04-30) | run on Node 24 LTS |

Upstream servers are not affected by the protocol change: the HTTP+SSE upstream adapter stays.

## The codemod: `config migrate --to v13` (15.9.0-canary.1)

Config schema v13 is read from 16.0.0-alpha.1 on, so on 15.9 the codemod applies only the rewrites that are valid
schema v12 and mean the same thing on 15.x, and lists the rest:

```bash
mcp-gateway config migrate --to v13 --dry-run -c mcp-gateway.yml   # plan + diff, writes nothing
mcp-gateway config diff --to v13 -c mcp-gateway.yml                # exit 3 when it would change the file
mcp-gateway config migrate --to v13 --in-place -c mcp-gateway.yml  # backup: mcp-gateway.yml.pre-v13.bak
```

- **Applied:** `isolation: worker | process | inline` on a module plugin becomes `runtime:` (comments and layout are
  kept; WASM component `isolation` is untouched). The file keeps `version: 12` and loads on 15.x as before.
- **Pending (listed, never written):** inline module plugins (16.0 needs `allowInline: true` on the entry, or move
  them to `runtime: worker`), `mcp.protocolVersions` naming 2024-11-05, Node.js 24.
- Without `--in-place` or `-o` it writes `<name>.v13-ready.<ext>` next to the file. It is idempotent: a second run
  has nothing to change. It refuses files that are not schema v12 (run `config migrate --to v12` first) and
  `isolation` / `runtime` pairs that disagree. Undo `--in-place` by copying the `.pre-v13.bak` file back.

The 16.0 freeze list is in [v16 freeze](v16/freeze.md).

## Rollback

15.9 changes no behaviour: the warnings are informational. Going back from 15.9 to 15.3 needs no config change — also after the codemod (`runtime:` is read since 14.3).
