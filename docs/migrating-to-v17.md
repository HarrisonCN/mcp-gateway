# Migrating to 17.0

> **Status: proposal until 17.0.0-rc.1.** The list below may still change; it is frozen in 17.0.0-rc.1. 17.0.0 has
> not shipped: its alphas and release candidates go to npm `canary` only, and stable 17.0.0 needs the v17 release
> gates (A/B against the previous stable major, an incremental external security review of the 17.0 changes) — see
> [release gates](release-gates.md). 16.0.0 itself is still a release candidate on `canary`.

16.9 announces every 17.0 removal one minor ahead. Run `mcp-gateway validate -c <file>` on 16.9 and check
`GET /api/v1/admin/deprecations` on a running gateway: every line marked `removed in 17.0.0` needs a change before
upgrading. The ids are listed in [deprecations](deprecations.md#planned-removals-in-1700-announced-1690-canary0).

## 17.0.0-alpha.1 (npm `canary`)

The first 17.0 prerelease enforces the list below; it is for trying the migration, not for production (`latest` stays
on 14.9.x, `next` on the 15.0 release candidate, and stable 17.0.0 needs its own gates):

- plugin API v6 only — `apiVersion: 5` is refused at load (`PLUGIN_API_MIN_VERSION` is 6), and every hook, programmatic
  plugin objects included, must return `{ action }` outcomes (anything else fails the hook, fail closed);
- no inline module plugins — `runtime: inline` and `allowInline` are configuration errors and `loadPlugin` refuses
  `runtime: inline` before importing the module; plugin objects passed through the embedding API still run in process;
- schema v13 only — `version: 12` is refused with the `config migrate --to v13` hint, and a file without `version:` is
  read as schema v13 (so the v13 rules apply to it); `config migrate --to v12 / --to v13` still read older files;
- `config migrate --to v13` targets 17.0: an inline module plugin becomes `runtime: worker` (listed under *pending*,
  because a plugin with `onRequest` / `routes` needs a person), `allowInline` is dropped (also from a 16.x v13 file), and
  a file without `version:` that already is valid v13 only gets `version: 13`.

The v13 *format* ([schema/v13](../schema/v13/config.schema.json), frozen from 16.0.0-rc.1) is unchanged: it still
describes what 16.x reads, including `allowInline`; 17.0 adds the plugin API v6 rule on top.

## 17.0.0-alpha.2 (npm `canary`)

The package's public exports get a recorded surface: every export of `.`, `./gateway`, `./edge` and `./testing` is
listed in `api/exports-surface.json` (`npx tsx scripts/sdk-surface.ts` fails when one disappears). The list is a
proposal until 17.0.0-rc.1 freezes it with the rest of the [17.0 freeze list](v17/freeze.md). Nothing to migrate.

## What changes in 17.0

| Area | 16.x | 17.0 | What to do on 16.9 |
|---|---|---|---|
| Plugin API | v5 (16.9: v5 and v6) | v6 only | declare `apiVersion: 6` — run `mcp-gateway plugin migrate --to v6 <file>` |
| Hook outcomes | `{ action }` or the v4-era shapes (`{ deny }`, `{ respond }`, `{ arguments }`, a whole response from `onResponse`) | `{ action }` only — anything else fails the hook (fail closed) | the codemod rewrites literal outcomes; change `onResponse` to `{ action: 'replace', result }` by hand |
| Module plugin runtime | `worker` (default), `process`, `inline` (schema v13: with `allowInline: true`) | `worker` or `process` only (WASM components unchanged) | move inline plugins to `runtime: worker` and drop `allowInline` |
| HTTP hooks in plugins | `onRequest` / `routes` (inline plugins only) | none in module plugins | move request handling into gateway configuration or a service in front of the gateway |
| Config schema | v13; v12 read through an in-memory migration (`schema.v12`) | v13 only; a file without `version:` is read as v13 | `mcp-gateway config migrate --to v13 --in-place -c <file>` |
| SDK / testing exports | `@winstonsayno/mcp-gateway/testing` (15.2) | frozen (additions only) | nothing |

A file without `version:` keeps working in 17.0 as long as it uses nothing that schema v13 refuses — the same things
16.x already reports as `v16.*` deprecations (removed in 17.0.0).

## Plugin API v6 (available in 16.9.0-canary.0)

v6 is v5 without the v4-era return shapes and without inline module plugins:

- `onToolCall` returns `{ action: 'continue' }`, `{ action: 'deny', reason }`, `{ action: 'respond', result }` or
  `{ action: 'rewrite', arguments }` (or nothing); `onResponse` returns `{ action: 'continue' }` or
  `{ action: 'replace', result }` (or nothing). Any other object fails the hook — the call is refused (`-32006`) unless
  the plugin's `failure` policy is `open`.
- A v6 module plugin is refused with `runtime: inline`; in a worker or a child process it has no `onRequest` / `routes`.
- Everything else of v5 stays: hook context (`secrets`, `tenant`, `state`), `onError`, `onConfigChange`, permissions,
  limits, the circuit breaker, signatures, WASM components (`component:`, WIT world `mcp-gateway:plugin@5.0.0`).

16.9 loads v5 and v6, so a plugin can move before the gateway does. A v6 plugin does not load on 16.8 or older, nor on
the 15.x / 14.x lines — keep `apiVersion: 5` for a plugin that must also run there.

## The codemod: `plugin migrate --to v6` (16.9.0-canary.0)

```bash
mcp-gateway plugin migrate --to v6 ./plugins/guard.mjs              # dry run: the changes and what needs a person
mcp-gateway plugin migrate --to v6 --in-place ./plugins/guard.mjs   # writes the file, keeps ./plugins/guard.mjs.bak
```

It rewrites `apiVersion: 5` to `6` and literal outcomes such as `return { deny: 'no rm' }` to
`return { action: 'deny', reason: 'no rm' }` (also `respond` → `{ action: 'respond', result }` and `arguments` →
`{ action: 'rewrite', arguments }`), and reports what it cannot decide from the text: `onResponse` returns,
`onRequest` / `routes`, a missing `apiVersion`. Running it again changes nothing. `--json` prints the result as JSON.

## Deprecations recorded by 16.9

| Id | When |
|---|---|
| `v17.plugins.<name>.api-v5` | a v5 module plugin is loaded |
| `v17.plugins.<name>.legacy-outcome` | a v5 module plugin hook returned a v4-era outcome |
| `v17.plugins.<name>.http-hooks` | a plugin with `onRequest` / `routes` is loaded |
| `v17.plugins.<i>.inline` | a schema v13 file has an inline module plugin (`runtime: inline`, `allowInline: true`) |
| `schema.v12`, `v16.*` | already reported by 16.x: schema v12 files and what v13 refuses are removed in 17.0.0 |
