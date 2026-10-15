# 17.0 freeze list (listed in 17.0.0-alpha.2, frozen in 17.0.0-rc.1)

> **Status: frozen from 17.0.0-rc.1; shipped in 17.0.0** (npm `latest`, 2026-10-15). 17.0.0 was released by owner decision; external security review and dedicated-hardware soak not yet performed:
> the owner decided the release while the v17 gates (A/B against the previous stable major, an incremental external
> security review of the 17.0 changes) were open, and 15.0.0 / 16.0.0 never shipped as stable releases (see
> [v15 gates](../v15/gates.md)). A frozen list is not a passed gate, and none of the gates is closed; stable 17.0.0
> shipped without its gates by owner decision ([release gates](../release-gates.md)).

From 17.0.0-rc.1 the surfaces below are **frozen** (and from 17.0.0 on they follow semantic versioning within 17.x): no renames, no removals and no changed
meaning. Additions that cannot break a caller (a new optional key, export, endpoint, response field or enum value)
stay allowed and are noted in the CHANGELOG under "Additions after the freeze".

## What 17.0.0 changes (announced in 16.9, enforced from 17.0.0-alpha.1)

| Surface | 16.x | 17.0.0 |
|---|---|---|
| Plugin contract | plugin API v5 and v6 (16.9) | **plugin API v6** only — `{ action }` outcomes for every hook; v5 refused at load (`mcp-gateway plugin migrate --to v6`) |
| Module plugin runtime | `worker`, `process`, `inline` (with `allowInline: true`) | `worker` (default) or `process`; `runtime: inline` and `allowInline` are configuration errors |
| Config file | **schema v13** (`version: 13`); v12 read in memory with a warning; unversioned = v12 | **schema v13** only; `version: 12` refused (`config migrate --to v13`); unversioned = v13 |

Migration: [migrating to v17](../migrating-to-v17.md).

## Frozen surfaces (checked mechanically)

- **Config schema v13** — `schema/v13/frozen-surface.json` (recorded at 16.0.0-rc.1, `scripts/v13-surface.ts`); 17.0
  keeps it and adds the plugin API v6 rule on top.
- **Plugin API v6** — the hook names and outcome shapes in `src/plugins/index.ts` (`PLUGIN_API_VERSION` 6,
  `PLUGIN_API_MIN_VERSION` 6) and the plugin compatibility table.
- **SDK exports** — every export (value or type) of the package entry points `.`, `./gateway`, `./edge` and
  `./testing` is recorded in `api/exports-surface.json` by `scripts/sdk-surface.ts` (first recorded at
  17.0.0-alpha.2, re-recorded at 17.0.0-rc.1 as the frozen list). `npx tsx scripts/sdk-surface.ts` fails
  when a recorded export disappears; `test/v17-sdk-surface-17-0-0.test.ts` also checks the record against what each
  entry point exports at runtime.

## Kept as in 16.x

The REST API under `/api/v1` and `/api/v1/admin`, `/mcp` (both eras), tool naming and error codes, the top-level CLI
commands and their documented flags and exit codes, the environment, state formats (readable by 17.0 without
migration), release artefacts, metric names and audit fields.

## Not frozen

Deep imports (anything not reachable through `package.json` `exports`), log line format, dashboard HTML/JS, exact
error message texts, the audit log's on-disk SQLite schema, `clients/` packages (versioned separately).
