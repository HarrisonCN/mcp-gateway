# Migrating to 15.0

15.0.0 is the "Governed AI Infrastructure" major. It removes what 14.x deprecated and changes one default; nothing
else breaks. Every change below is reported by **14.9.0** at run time, so the safe path is:

1. Upgrade to **14.9.1** or later 14.9.x (`npm i @winstonsayno/mcp-gateway@14.9.1`, image `:14.9.1`; 14.9.1 fixes the 14.9.0 memory growth).
2. Run `mcp-gateway validate -c mcp-gateway.yml` and check `GET /api/v1/admin/deprecations` on every instance.
3. Fix each reported id (table below) until both are empty.
4. Try the release candidate in staging: `npm i @winstonsayno/mcp-gateway@next` (`15.0.0-rc.2`), image
   `ghcr.io/harrisoncn/mcp-gateway:15.0.0-rc.2` (prerelease — `latest`, `:14` and `:latest` stay on 14.9).
5. Upgrade production to 15.0.0 when it ships.

## Changes

| Id | Change in 15.0.0 | Action |
|---|---|---|
| `schema.v11` | `version: 11` files are refused (14.x migrated them in memory) | `mcp-gateway config migrate --to v12 --in-place -c mcp-gateway.yml` (backup `mcp-gateway.yml.v11.bak`; preview with `config diff --to v12`) |
| `v15.plugins.<i>.runtime` | module plugins run in a `worker` by default (14.x: inline) | add `runtime: worker` in 14.9 and test; plugins that need the gateway process (shared module state, native handles) keep `runtime: inline` |
| `v15.config.unknown-key.<key>` | unknown top-level config keys are refused (14.x ignored them) | remove / fix them; a GitOps `base.yml` with `include:` is a fragment for `mcp-gateway gitops render`, not a config file |
| `schema/v12-draft` | the 13.9 alias path of the JSON schemas is removed | point `$schema` / editors at `schema/v12/config.schema.json` |

What does **not** change: REST and admin API, `/mcp`, CLI, plugin API v5, metrics, and every state format (durable
tasks, idempotency claims, DLQ, edge outbox, region revocations, gitops release record, Redis / SQLite keys) — see
the [freeze list](v15/freeze.md). 15.0 reads the state 14.x wrote without a migration step.

### What the errors look like in 15.0

- A v11 file: `version: config schema v11 is no longer read by 15.0.0 … — rewrite the file with mcp-gateway config migrate --to v12 --in-place -c <file>`.
  The file counts as v11 when it says `version: 11`, or has no `version` and uses a v11-only field (`kernel`,
  `features.genaiTelemetry`, `features.policyShadow`, `features.postQuantumTls`). `config migrate`, `config diff` and
  `config rollback` still read v11 files.
- An unknown top-level key of a `version: 12` file: `<key>: \`<key>\` is not a top-level key of config schema v12 …`
  (`$schema` is allowed).
- Module plugins: no error. A plugin without `runtime` now loads in a worker thread; `limits` and `permissions` apply
  to it without further settings. A plugin that must share the gateway process (module-level state, native handles,
  `onRequest`) needs `runtime: inline`.

## Upgrading a cluster

Instances of 14.9 and 15.0 can share one Redis / SQLite store during a rolling upgrade (same state formats). Upgrade
one instance at a time; the GitOps release record and durable runs carry over. Config files must already be schema
v12 (step 3) before the first 15.0 instance starts.

## Rolling back

- **15.0 → 14.9**: stop the 15.0 instance and start 14.9 on the same store and config — the config is v12 (14.9
  reads it) and the state formats are the same. A plugin you moved to `runtime: worker` keeps working on 14.9.
- **v12 config → v11 (back to 13.9.x)**: `mcp-gateway config rollback -c mcp-gateway.yml` restores the
  `mcp-gateway.yml.v11.bak` written by `config migrate --in-place`. Settings that exist only in v12
  (`modules.lifecycle`, `modules.capabilities`) have no v11 form; `downgradeLoss()` lists them.
- Durable runs created by 15.0 / 14.9 and paused for approval are resumed by 14.8+ (tested); 13.9.x has no durable
  execution and ignores those records.

These paths are tested in CI: `test/upgrade-14-9-0.test.ts` (13.9.5 and 14.8.0 → current and back, real SQLite and
Redis; run with `bash scripts/upgrade-test.sh`) and `test/rc-migration-14-9-0.test.ts` (every example and docs snippet
through v11 → v12, `config migrate --in-place` + `config rollback`).
