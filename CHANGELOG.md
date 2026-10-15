# Changelog

All notable changes to mcp-gateway will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [Unreleased]

## [17.0.0-alpha.2] - 2026-10-15

**Development prerelease — 17.0 SDK surface** (npm dist-tag `canary`, image `:17.0.0-alpha.2` only — not for production; `latest` stays on 14.9.x and `next` on the 15.0 release candidate). The 17.0 list is a **proposal** until 17.0.0-rc.1 ([17.0 freeze list, draft](docs/v17/freeze.md)). 15.0.0 has not shipped (gates A / B / C open, [v15 gates](docs/v15/gates.md)); stable 17.0.0 needs its own gates — **17.0.0 GA is blocked while A / B / C are open.**

### Added

- **SDK export surface record**: `api/exports-surface.json` lists every export (value or type) of the package entry points `.`, `./gateway`, `./edge` and `./testing` (705 at 17.0.0-alpha.2: 389 values, 316 types), computed from the TypeScript sources by `scripts/sdk-surface.ts` (compiler API). `npx tsx scripts/sdk-surface.ts` exits 1 when a recorded export disappears (the surface may only grow); `--record [--at <version>]` re-records it at a freeze point. Recorded as a proposal; 17.0.0-rc.1 re-records it as the frozen list.
- `docs/v17/freeze.md` (draft): the 17.0 changes (plugin API v6 only, no inline module plugins, schema v13 only), the mechanically checked surfaces (config schema v13, plugin API v6, SDK exports), what stays as in 16.x and what is not frozen (deep imports among them).

### Tests

- `test/v17-sdk-surface-17-0-0.test.ts` (written first; failing-before: module missing → `sdk1702-failing-before`): E1 the record covers every `package.json` export, sorted, with its version; E2 only growth, a removed export is reported (exit 1); E3 recorded value exports equal the runtime exports of each entry point; E4 `./testing` carries the plugin-author surface; E5 the freeze doc.

## [17.0.0-alpha.1] - 2026-10-15

**Development prerelease — first 17.0 breaking prerelease** (npm dist-tag `canary`, image `:17.0.0-alpha.1` only — not for production; `latest` stays on 14.9.x and `next` on the 15.0 release candidate). The removals announced by 16.9.0-canary.0 take effect; the 17.0 list is a **proposal** until 17.0.0-rc.1 ([migrating to v17](docs/migrating-to-v17.md#1700-alpha1-npm-canary)). 15.0.0 has not shipped (gates A / B / C open, [v15 gates](docs/v15/gates.md)); 16.0.0 and 17.0.0 stable need their own gates — **17.0.0 GA is blocked while A / B / C are open.**

### Breaking (17.0)

- **Plugin API v6 only.** `PLUGIN_API_MIN_VERSION` is 6: an `apiVersion: 5` plugin (module or programmatic) is refused at load with the `mcp-gateway plugin migrate --to v6 <file>` hint. Every hook — programmatic plugin objects included — must return `{ action }` outcomes; a v4-era shape (`{ deny }`, `{ respond }`, `{ arguments }`, a whole response from `onResponse`) fails the hook (fail closed, `-32006` unless `failure: open`). `definePlugin` and the `plugin init` template write `apiVersion: 6`. Plugin compatibility table: 17.0 loads v6 only.
- **No inline module plugins.** `runtime: inline` (with or without `allowInline`) and a stray `allowInline` are configuration errors; `loadPlugin` refuses `runtime: inline` before importing the module. Module plugins run in a `worker` (default) or `process`. Plugin objects passed through the embedding API still run in process.
- **Config schema v13 only.** `version: 12` is refused with the `config migrate --to v13 --in-place` hint (v11 keeps its own message). A file without `version:` is read as schema v13. `CONFIG_SCHEMA_VERSION` is 13; `init`, the desktop profile, portable / distributed configs, the Helm chart, the Kubernetes / Compose / Docker examples and every file under `examples/` are `version: 13`. The migration tooling (`config migrate / diff --to v12 | v13`, `config rollback`, docs-check) still reads older files.
- The 17.0 config deprecations (`v17.plugins.<i>.inline`, `v17.plugins.<name>.api-v5` / `legacy-outcome`, `schema.v12`) are gone — they are errors now.

### Changed

- `config migrate --to v13` targets 17.0: an inline module plugin becomes `runtime: worker` and is listed under *pending* (`v17.plugins.<i>.inline` — a plugin with `onRequest` / `routes` needs a person), `allowInline` is dropped (also from a 16.x v13 file), and an unversioned file that already is valid v13 only gets `version: 13`.
- `schema/v13/config.schema.json` (frozen from 16.0.0-rc.1) is unchanged: it describes the 16.x v13 format, including `allowInline`; 17.0 adds the plugin API v6 rule on top (one listed exception in `test/v13-tooling-16-0-2.test.ts` J3).
- `examples/plugins/tool-quota`: `pluginTrust` moved under `features` (the example did not validate as v13).

### Tests

- `test/v17-core-17-0-0.test.ts` (written first; failing-before 6/7 → `v17core-failing-before`; K7 is a guard that already held): K1 v6 only, K2 no inline module plugins, K3 v6 outcomes for every plugin, K4 v12 refused / tooling reads v12, K5 unversioned = v13, K6 codemod, K7 no 17.0 deprecations left.
- Expected churn in older tests (exploratory full run: 206 failed in 66 files before the fixture work): 41 files' fixtures `version: 12` → 13, 7 files' plugins `apiVersion: 5` → 6. History tests (v13-schema, v16-prep, v15-changes, v14-prep, rc-migration, core-v2, fuzz, plugin-runtime-extra, reload, v13-tooling J6) keep their v12 / 16.x assertions through `validateV12ForMigration` and assert the 17.0 refusal next to them; reload's transactional plugin tests use worker plugins. `plugin-devkit-15-2-0` D2 / D4 (inline is now a config error — new assertion), `v13-codemod-15-9-1` C1 / C2 / C4 / C5 (inline → worker + the pending entry), `v13-tooling-16-0-2` J3 (listed exception) / J4 / J6, `v10` (schema 13); found by the local full suite: `v7` (distributed config is v13; failing-before `v7-1701-failing-before`).

## [16.9.0-canary.0] - 2026-10-15

**Development prerelease — v17 preparation** (npm dist-tag `canary`, image `:16.9.0-canary.0` only — not for production; `latest` stays on 14.9.x and `next` on the 15.0 release candidate). Every removal planned for 17.0.0 is announced one minor ahead and plugin API v6 is available early; the 17.0 list is a **proposal** until 17.0.0-rc.1 ([migrating to v17](docs/migrating-to-v17.md)). 15.0.0 has not shipped (gates A / B / C open, [v15 gates](docs/v15/gates.md)); 16.0.0 is at rc.1 on `canary` and needs its own gates.

### Added

- **Plugin API v6** (the 17.0 contract, loadable now): hooks return `{ action }` outcomes only — a v4-era shape (`{ deny }`, `{ respond }`, `{ arguments }`, a whole response from `onResponse`) fails the hook (fail closed, `-32006` unless `failure: open`); a v6 module plugin is refused with `runtime: inline` (so it has no `onRequest` / `routes`). `PLUGIN_API_VERSION` is 6, `PLUGIN_API_MIN_VERSION` stays 5: 16.9 loads v5 and v6. Hooks see the contract the plugin declared in `ctx.apiVersion` (a v5 plugin keeps seeing 5). Plugin compatibility table: `16.0.0 – <16.9.0` v5 (frozen, prerelease), `16.9.0 – <17.0.0` v5 – v6 (proposal), 17.0 v6 (proposal).
- **17.0 deprecations** (`DEPRECATED (removed in 17.0.0)`, listed by `GET /admin/deprecations`; [deprecations](docs/deprecations.md#planned-removals-in-1700-announced-1690-canary0)): `v17.plugins.<name>.api-v5` (a loaded v5 module plugin), `v17.plugins.<name>.legacy-outcome` (a v5 module plugin hook returned a v4-era outcome; it keeps working), `v17.plugins.<name>.http-hooks` (a plugin with `onRequest` / `routes`), `v17.plugins.<i>.inline` (a schema v13 file with an inline module plugin; also listed by `mcp-gateway validate`). Schema v12 files and the `v16.*` items stay reported as before (removed in 17.0.0).
- **Codemod** `mcp-gateway plugin migrate --to v6 <file> [--in-place] [--json]` (`migratePluginSource` in `src/plugins/migrate-v6.ts`): `apiVersion: 5` → 6, literal v4-era outcomes → `{ action }`, a report of what needs a person (`onResponse` returns, HTTP hooks, a missing `apiVersion`); dry run by default, `--in-place` keeps `<file>.bak`; idempotent.
- `docs/migrating-to-v17.md` (proposal): plugin API v6, runtimes, HTTP hooks, schema v13 only (a file without `version:` is read as v13 in 17.0), the codemod.

### Tests

- `test/v17-prep-16-9-0.test.ts` (written first; failing-before: modules missing → `v17prep-failing-before`): P1 v5 and v6 load / table, P2 v4-era outcomes (v6 fails closed in a worker, v5 works inline and is recorded), P3 v6 refused inline, P4 load-time deprecations, P5 v13 config deprecation, P6 codemod + CLI.
- Adjusted for the 16.9 behaviour (expected changes): `test/v13-schema-16-0-0.test.ts` S7 (a migrated v13 file with an inline plugin now lists `v17.plugins.1.inline`), `test/v16-freeze-16-0-0-rc1.test.ts` R4 (the frozen v5 range ends at 16.9.0), `test/plugin-sdk-15-2-1.test.ts` C2 (16.9 row), `test/v5.test.ts` / `test/v8.test.ts` (`PLUGIN_API_VERSION` ≥ 5).
- Found by the local full suite (failing-before `v169-fix-failing-before`): `test/plugins.test.ts` (a v5 plugin's hooks see `ctx.apiVersion` 5; a v6 plugin sees 6 — new assertion), `test/v13-codemod-15-9-1.test.ts` C1 (after `config migrate --to v13` every 16.0 deprecation is resolved and exactly `v17.plugins.1.inline` remains), `test/v13-tooling-16-0-2.test.ts` J4.

### Changed

- `scripts/docs-check.ts`: the `v17.*` deprecations are advisory in docs (they describe valid 16.x configs; 17.0 refuses those forms at load, which docs-check then reports) — before, an `allowInline` v13 example was mislabelled a "schema v11 field".

## [16.2.0-canary.0] - 2026-10-15

**Development prerelease — first 16.2 canary** (npm dist-tag `canary`, image `:16.2.0-canary.0` only — not for production; `latest` stays on 14.9.x and `next` on the 15.0 release candidate). Multi-region control plane 2.0. 15.0.0 has not shipped (gates A / B / C open, [v15 gates](docs/v15/gates.md)); 16.0.0 is at rc.1 on `canary` and needs its own gates.

### Added

- **Revocation propagation SLO** ([multi-region](docs/guides/multi-region.md#control-plane-20-1620-canary0-development-prerelease)) — `regions.consistency.revocationSloMs` (integer ≥ 100, default `maxStalenessMs`). When a revocation issued in another region first reaches this one, its latency is measured (this region's clock minus the issuing region's revocation time, corrected by that peer's observed clock skew; never negative). A slower one is a breach: counted, on the operations console timeline as the new kind `revocation-slo` (warning) and exported as `mcp_gateway_region_revocation_slo_breaches_total`, next to `mcp_gateway_region_revocation_slo_seconds` and `mcp_gateway_region_revocation_propagation_seconds{quantile}`. `GET /admin/regions/report` gains `revocationPropagation` (`sloMs`, `samples`, `breaches`, p50 / p99 / max over the last 200, 20 most recent samples). Own-region and store-relayed revocations are not sampled. A peer's skew is now recorded before its revocations are merged in a sync round, so the correction uses the same exchange.
- **Cross-region rollup** — each region adds its own figures to the sync exchange (cost ledger since the start of the UTC day, total and by tenant; kept call lineage by outcome). `GET /admin/regions/rollup` lists every region (`self` / `fresh` / `stale` / `missing`, `asOf`, `lagMs`) with the sums (`total.costs`, `total.byTenant`, `total.lineage`) and `complete` (every peer fresh with figures). The operations console cluster view shows it under `regions.rollup`, with the propagation summary. A malformed rollup, or one claiming another region, is ignored.
- **Region-qualified lineage** — with `regions` configured, lineage records (`GET /admin/ops/lineage/:requestId`, `?correlationId=`) carry `region` and `globalId` (`<region>:<requestId>`, unique across regions). `GET /admin/regions/lineage/:globalId` resolves one from any region (its own record, or the peer's fetched with the peer `apiKey`; `404` unknown region / call, `400` without a region part, `502` peer unreachable). Gateways without `regions` keep the 15.1 lineage shape.
- Feature context (`FeatureContext`) gains optional `costRollup`, `lineageSummary`, `lineage` (used by the regions module).

### Tests

- `test/regions-control-plane-16-2-0.test.ts` (written first; failing-before 8/8 → `regions162-failing-before`): propagation latency with skew correction, breaches and quantiles; never-negative latency and the default SLO; config validation; `mergeRollups` (sums, statuses, completeness); peer rollups only from configured peers and only when well formed; two in-process regions: rollup of costs + lineage across regions and on the console cluster view, region-qualified lineage resolvable from either region, an SLO breach under an injected partition (report, metrics, timeline).

## [16.1.0-canary.1] - 2026-10-15

**Development prerelease — second 16.1 canary** (npm dist-tag `canary`, image `:16.1.0-canary.1` only — not for production; `latest` stays on 14.9.x and `next` on the 15.0 release candidate). It adds change notifications for stateless MCP 2026-07-28 callers. 15.0.0 has not shipped (gates A / B / C open, [v15 gates](docs/v15/gates.md)); 16.0.0 is at rc.1 on `canary` and needs its own gates.

### Added

- **`subscriptions/listen`** ([MCP 2026-07-28 subscriptions](https://modelcontextprotocol.io/specification/2026-07-28/basic/patterns/subscriptions); [client compatibility](docs/guides/client-compatibility.md#mcp-2026-07-28-1610-canary0)) — the 2026-07-28 replacement for the GET stream and `resources/subscribe`, for callers without a session:
  - the request (header validation as for every modern request) answers with a long-lived SSE response; a client that does not accept `text/event-stream` gets `400`;
  - first message `notifications/subscriptions/acknowledged` with the agreed filter: `toolsListChanged` / `promptsListChanged` / `resourcesListChanged` as asked, `resourceSubscriptions` limited to URIs the caller's scope can route to a server that supports resource subscriptions (at most 100 per listen);
  - then `notifications/tools/list_changed`, `notifications/prompts/list_changed`, `notifications/resources/list_changed` (computed per caller scope, as for sessions) and `notifications/resources/updated`, each with `_meta["io.modelcontextprotocol/subscriptionId"]` = the listen request's id; types the caller did not ask for are never sent;
  - upstream `resources/subscribe` is shared with sessions and released when the last subscriber (session or listener) goes; closing the stream ends the subscription;
  - the gateway ends a listener gracefully — a `resultType: "complete"` response carrying the subscription id — on shutdown and when an auth reload removes the key that opened it; SSE keepalive comments as on session streams; at most `mcp.maxSessions` open listeners (`503` beyond).
- `server/discover` advertises `tools.listChanged`, `resources.listChanged` / `subscribe` and `prompts.listChanged`.

### Tests

- `test/mcp-subscriptions-16-1-1.test.ts` (written first; failing-before 5/6 → `subs1611-failing-before`; S6, header validation, already held from canary.0): S1 acknowledgment + agreed filter + SSE required, S2 tagged tools/list_changed and no unrequested types, S3 resources/updated, S4 closing releases the upstream subscription, S5 scope, S6 header validation, S7 graceful end on shutdown; S8 (key removed by an auth reload) added after the first green run, for the documented behaviour.
- `test/compat-matrix-13-6-0.test.ts`: when the Python SDK's auto mode stays on 2026-07-28 it also opens `subscriptions/listen` with the SDK's own `listen()` and checks the acknowledgment (passes locally with `mcp==2.3.0`).

## [16.1.0-canary.0] - 2026-10-15

**Development prerelease — first 16.1 canary** (npm dist-tag `canary`, image `:16.1.0-canary.0` only — not for production; `latest` stays on 14.9.x and `next` on the 15.0 release candidate). 16.1 was conditional on a new MCP specification revision; [MCP 2026-07-28](https://modelcontextprotocol.io/specification/2026-07-28) was published on 2026-07-28. This canary makes `/mcp` dual-era. 15.0.0 has not shipped (gates A / B / C open, [v15 gates](docs/v15/gates.md)); 16.0.0 is at rc.1 on `canary` and needs its own gates.

### Added

- **MCP 2026-07-28 on `/mcp`, statelessly** ([client compatibility](docs/guides/client-compatibility.md#mcp-2026-07-28-1610-canary0)), additive — the handshake revisions (2025-11-25, 2025-06-18, 2025-03-26) and their sessions are unchanged:
  - **`server/discover`** without a session: `supportedVersions` (2026-07-28 first, then the handshake revisions allowed by `mcp.protocolVersions`), `capabilities`, `_meta["io.modelcontextprotocol/serverInfo"]`, `instructions`, `ttlMs` / `cacheScope`. A bare probe without `_meta` gets the same answer, so dual-era clients (the official Python SDK `mcp` 2.x in `mode="auto"`) stay on 2026-07-28 instead of falling back — 13.6–16.0 answered `-32601`.
  - A request without `Mcp-Session-Id` that declares `params._meta["io.modelcontextprotocol/protocolVersion"]` is served without a session: `tools/list`, `tools/call`, `resources/list`, `resources/templates/list`, `resources/read`, `prompts/list`, `prompts/get`, `completion/complete`, through the same authentication, scopes, policy, rate limits, audit and lineage as a session request. Results carry `resultType: "complete"` and `_meta` serverInfo; list / read results carry `ttlMs` (30 s) and `cacheScope: "private"`.
  - Streamable HTTP server validation: `MCP-Protocol-Version` must equal the `_meta` version, `Mcp-Method` the method, `Mcp-Name` the tool / prompt name or resource URI (Base64 sentinel `=?base64?…?=` decoded) → otherwise `400` + `-32020` HeaderMismatch. A version that is not served statelessly → `400` + `-32022` with `data.supported` / `data.requested`. Methods 2026-07-28 removed (`ping`, `logging/setLevel`, `resources/subscribe` / `unsubscribe`) and unknown methods → `404` + `-32601`; one message per POST (a batch is `400` `-32600`); resource not found is `-32602` in this mode.
  - `mcp.protocolVersions` accepts `2026-07-28`: without the key everything is served; a list without it turns the stateless core off (a bare `server/discover` keeps the old `-32601`); a list naming only it makes `/mcp` modern-only (`initialize` → `400` + `-32022` naming the supported revision).
  - Not in this canary: `subscriptions/listen`, Multi Round-Trip Requests (upstream sampling / elicitation / roots are unavailable to stateless callers), the tasks extension, per-request `logLevel`, `x-mcp-header` parameters, speaking 2026-07-28 to upstream servers.

### Tests

- `test/mcp-modern-16-1-0.test.ts` (written first; failing-before 6/7 → `mcpmodern-failing-before`; M7, the unchanged handshake path, passed before): M1 discover, M2 stateless tools with scopes, M3 header validation incl. Base64 sentinel, M4 unsupported versions and the pin without 2026-07-28, M5 removed methods / batches, M6 resources and prompts (-32602), M7 handshake unchanged, M8 config + modern-only pin. During implementation: M6 found that an upstream's own `-32601` must stay HTTP 200 (404 only for methods the gateway lacks), and the "unknown resource" case needed a caller with no resource server in scope (the fixture answers any URI); M4 / M8 were added for the pinned cases.
- `test/compat-matrix-13-6-0.test.ts`: the `server/discover` check now expects a DiscoverResult (and `-32020` for a header-only probe); the Python SDK check accepts `2026-07-28` for `mode="auto"`. Locally with `mcp==2.3.0` (the version CI pins): auto mode stays on 2026-07-28 and calls a tool statelessly; session mode on 2025-11-25 unchanged.

## [16.0.0-rc.1] - 2026-10-14

**Release candidate prerelease — first 16.0 release candidate** (npm dist-tag `canary`, image `:16.0.0-rc.1` only — not for production; `latest` stays on 14.9.x and `next` on the 15.0 release candidate until 15.0.0 is stable). From this release the [16.0 freeze list](docs/v16/freeze.md) is **frozen**. A frozen list is not a passed gate: 15.0.0 has not shipped (gates A / B / C open, [v15 gates](docs/v15/gates.md)) and stable 16.0.0 needs its own gates (A / B against the 15.0 baseline, an incremental external security review).

### Changed

- **The 16.0 list is frozen** (docs/v16/freeze.md, docs/migrating-to-v16.md, docs/deprecations.md, the schema v13 title and code headers): the "proposal until 16.0.0-rc.1" wording is gone; until 16.0.0 ships there are no further removals, renames or changed meanings, additions that cannot break a client stay allowed (CHANGELOG "Additions after the freeze"), and later release candidates only fix blocking problems. `config migrate --to v13 --dry-run` prints "Schema v12 → v13 (16.0, frozen from 16.0.0-rc.1)".
- **Plugin compatibility**: the 16.0 row (plugin API v5; inline module plugins need `allowInline: true`) is **frozen (prerelease)**, not *shipped* — it becomes shipped only with a 16.0.0 GA. New row status `frozen` in `PLUGIN_COMPATIBILITY`; `pluginApiSupport()` returns `frozen: true` for it (additive; `proposal: true` stays for 17.0). docs/guides/plugin-compatibility.md regenerated and explains the status.
- **CI for the 16.x line runs the gateway on Node.js 24 only** (`engines.node >= 24` since 16.0.0-alpha.1): the `Node ${{ matrix.node }}` matrix is `[24]`; Docs check, Supply chain, MCP compat matrix, Multi-instance reliability, Upgrade + security regressions, Performance (`Load + faults (Node 24)`, module cost report) and Release assets use Node 24; the Deployment examples' Docker Hub fallback builds on `node:24-alpine` (it still named `node:22-alpine`, unlike the Dockerfile). The release gate's required checks drop `Node 22` (scripts/required-checks.json, docs/release-gates.md). The JS client jobs keep Node 20 / 22 / 24 (separately versioned package); maint/14.9.x and release/15.0.x keep their own Node 22 + 24 CI.

### Added

- **Frozen-surface guard for config schema v13**: `schema/v13/frozen-surface.json` (shipped in the package) records every key path and enum / const value of schema v13 at 16.0.0-rc.1 (284 entries); `scripts/v13-surface.ts` (`npx tsx scripts/v13-surface.ts` exits 1 on a break; `--record --at <version>` only at a freeze point) and the test fail when an entry disappears or an enum narrows, while new keys pass. if / then / else conditions are cross-key constraints and not counted as surface. Outside the loader's import graph (startup bench unchanged).

### Tests

- `test/v16-freeze-16-0-0-rc1.test.ts` (written first; failing-before 6/6 → `v16rc1-failing-before`): R1 freeze doc frozen + gates still required, R2 migration guide / deprecations without "proposal", R3 schema title and headers, R4 compat 16.0 "frozen (prerelease)" / 17.0 proposal, R5 frozen surface (and the guard catches a removed key and a narrowed enum), R6 CI Node 24 only + release gate. After the failing-before run, R5 showed that conditional `if/then` branches kept a deleted key on the surface → the surface walk skips conditions.
- `test/plugin-sdk-15-2-1.test.ts` C2 expects `frozen: true` for 16.x; `test/release-gate-13-4-0.test.ts` uses `Kotlin client` as its pending example (no `Node 22` check on 16.x).

## [16.0.0-alpha.2] - 2026-10-14

**Development prerelease — second alpha of 16.0** (npm dist-tag `canary`, image `:16.0.0-alpha.2` only — not for production; `latest` stays on 14.9.x and `next` on the 15.0 release candidate). It completes the schema v13 tooling planned for alpha.2 in [migrating to v16](docs/migrating-to-v16.md); the 16.0 list stays a proposal until 16.0.0-rc.1. 15.0.0 itself has not shipped — its gates A / B / C are still open ([v15 gates](docs/v15/gates.md)) — and stable 16.0.0 needs its own gates.

### Added

- **`schema/v13/config.schema.json`** (JSON Schema draft-07, shipped in the npm package): generated from the code (`buildV13ConfigSchema` in `src/config/v13-schema.ts`, `npx tsx scripts/gen-schema-v13.ts [--check]`) from the v12 schema plus the v13 rules — `version: 13`; module plugins take only `runtime` (`isolation` is for WASM components: `tenant | client | shared`); `runtime: inline` needs `allowInline: true`, and `allowInline` is allowed only there; no `2024-11-05` in `mcp.protocolVersions`. The loader stays the authority for what the schema leaves to the runtime (feature section bodies); the module declaration schema is unchanged (`schema/v12/module.schema.json`). The builder is outside the loader's import graph (startup bench unchanged).
- **`mcp-gateway config rollback` for v13**: undoes `config migrate --to v13 --in-place` by restoring `<file>.pre-v13.bak` (the v13 file is kept as `<file>.v13.bak`). New `--to v12 | v11`: required when both a pre-v13 and a v11 backup exist; without it the command uses the only backup there is (v11 as before). `config migrate --to v13 --in-place` now names the rollback command.
- **`docs-check` checks every current config in its v13 form**: `version: 13` fences are accepted and validated (loader + `schema/v13`); v12 / unversioned configs are run through the `--to v13` codemod and the result is validated against `schema/v13/config.schema.json`, so the docs can switch to v13 mechanically when 16.0 becomes `latest` (126 configs checked, 0 findings). The summary line reports the count.

### Decided

- **A config file without `version:`** is read as schema v12 in all of 16.x, without the `schema.v12` notice (the 14.x / 15.x docs write configs that way, and the docs stay on v12 while `latest` cannot read v13); every 16.0 removal in it is still reported (`v16.*`). 17.0.0 will read an unversioned file as schema v13, so a file without `v16.*` notices keeps working unchanged. Replaces the alpha.1 "revisit by rc.1" note; documented in docs/migrating-to-v16.md and docs/v16/freeze.md.

### Tests

- `test/v13-tooling-16-0-2.test.ts` (written first; failing-before: module missing → `v13tooling-failing-before`): J1 schema file generated / compiles / ships, J2 the JSON Schema states the v13 rules, J3 loader ⇔ schema agree on the rule cases, J4 docs-check validates v13 fences and the v13 form of v12 fences, J5 `config rollback` after `--to v13 --in-place` (and `--to` with both backups), J6 the unversioned-file decision. After the failing-before run: J4's count expectation corrected (a fence the loader refuses is not checked in its v13 form), J5 given a 120 s timeout (seven CLI runs) and the J4 fixture copies `README.md`.
- `test/mcp-endpoint.test.ts` "applies the gateway rate limit to tools/call": the alpha.2 full run failed it once — with `limit: 1` and the sliding window's minute-aligned buckets, two calls that straddle a 60 s boundary are both allowed (estimated 0.99 < 1). The test now uses a 1 h window (test-only change; the limiter is unchanged).

## [16.0.0-alpha.1] - 2026-10-14

**Development prerelease — first alpha of 16.0** (npm dist-tag `canary`, image `:16.0.0-alpha.1` only — not for production; `latest` stays on 14.9.x and `next` on the 15.0 release candidate). It implements the 16.0 changes announced in 15.9 ([migrating to v16](docs/migrating-to-v16.md), [v16 freeze](docs/v16/freeze.md)); the list stays a proposal until 16.0.0-rc.1. 15.0.0 itself has not shipped — its gates A / B / C are still open ([v15 gates](docs/v15/gates.md)) — and stable 16.0.0 needs its own gates (A/B against the 15.0 baseline, an incremental external security review).

### Breaking (proposal)

- **Config schema v13** (`version: 13`): schema v12 with the 16.0 rules enforced — a module plugin takes only `runtime` (the 14.3 `isolation: worker | process | inline` alias is a configuration error; WASM components keep `isolation: tenant | client | shared`); an inline module plugin (`runtime: inline`) needs `allowInline: true` on its entry, and `allowInline` anywhere else is an error; `mcp.protocolVersions` must not name `2024-11-05`.
- **Schema v12 files** are read as in 15.x; an explicit `version: 12` file is reported once as `schema.v12` (removed in 17.0.0). The v12-only uses keep working and stay reported — `v16.plugins.<i>.isolation` / `v16.plugins.<i>.inline` are now marked removed in 17.0.0, and `2024-11-05` in a v12 `mcp.protocolVersions` is ignored. A file without `version:` is read as v12 without the `schema.v12` notice (alpha decision, revisited by 16.0.0-rc.1).
- **`/mcp` no longer negotiates MCP revision 2024-11-05**: a client that asks for it gets the newest revision (2025-11-25) and decides whether to continue, as the spec says; the request is reported once (`v16.mcp.protocol-2024-11-05`). `2025-11-25`, `2025-06-18` and `2025-03-26` are unchanged. Upstream servers on 2024-11-05 (including HTTP+SSE) are still adapted as before.
- **Node.js 24**: `engines.node` is `>=24.0.0` and the container image is built on `node:24-alpine`. npm only warns on older Node.js; 16.x is not supported there and keeps reporting `v16.node.<major>`.

### Changed

- `mcp-gateway config migrate --to v13` now writes a schema v13 file: `isolation` → `runtime`, `allowInline: true` on inline module plugins, `2024-11-05` dropped from `mcp.protocolVersions` (a list that named only it is removed), `version: 13`; the result is validated as v13 before anything is written; a v13 file is checked and left as it is. Default output `<name>.v13.<ext>`; `--in-place` keeps `<file>.pre-v13.bak` (the file 15.x can read).
- Docs and examples stay on schema v12 while npm `latest` is a release that cannot read v13 (`docs-check` does not report the `schema.v12` notice).

### Not in this alpha

- A generated `schema/v13/config.schema.json` (editors keep `schema/v12`), and a `config rollback` for v13 (copy the `.pre-v13.bak` file back). Planned before 16.0.0-rc.1.

### Tests

- `test/v13-schema-16-0-0.test.ts` (written first; failing-before 8/8 → `v13schema-failing-before`): S1 v13 loads, S2 alias refused (WASM isolation kept), S3 `allowInline`, S4 2024-11-05 refused in v13 / ignored + reported in v12, S5 `schema.v12` notice, S6 `/mcp` negotiation (2024-11-05 → 2025-11-25; upstream adaptation unchanged), S7 codemod writes v13 that loads and is idempotent, S8 `engines.node`. The S6 fixture was corrected after the failing-before run to the test helper's `base` URL and operator header.
- Updated for 16.0 behaviour: `test/v13-codemod-15-9-1.test.ts` (the codemod now writes v13), `test/v16-prep-15-9-0.test.ts` (plugin ids removed in 17.0.0; explicit v12 files also report `schema.v12`), `test/mcp-endpoint.test.ts` (a 2024-11-05 request negotiates 2025-11-25).
- Also updated: the "unsupported future version" probes in `test/v5`, `v8`, `v9`, `v10`, `v11`, `migrate-bench` and `core-v2-14-0-0` use `version: 14` (13 is read now; the message names `version: 13` and `version: 12`); `core-v2-14-0-0` and `v15-changes-15-0-0` expect the `schema.v12` notice on explicit v12 files; the downstream compatibility matrix (`test/compat-matrix-13-6-0.test.ts`) runs the SDK client on the revisions `/mcp` accepts (2025-11-25, 2025-06-18, 2025-03-26).

## [15.9.0-canary.1] - 2026-10-14

**Development prerelease** (npm dist-tag `canary`, image `:15.9.0-canary.1` only — not for production; `latest` stays on 14.9.x and `next` on the 15.0 release candidate). Second build of the 15.9 line (v16 preparation): everything in 15.9.0-canary.0 plus the `config migrate --to v13` codemod and the draft 16.0 freeze list. 15.0.0 itself has not shipped — its gates A / B / C are still open ([v15 gates](docs/v15/gates.md)) — and the 16.0 list stays a proposal until 16.0.0-rc.1.

### Added

- **`mcp-gateway config migrate --to v13`** (and `config diff --to v13`) — the codemod for the 16.0 config changes ([migrating to v16](docs/migrating-to-v16.md#the-codemod-config-migrate---to-v13-1590-canary1)). Config schema v13 is read from 16.0.0-alpha.1 on, so on 15.9 it applies only the rewrites that are valid schema v12 and mean the same thing on 15.x — `isolation: worker | process | inline` on a module plugin becomes `runtime:` (comments and layout kept; WASM component `isolation` untouched; the file keeps `version: 12`) — and lists the v13-only changes as *pending* without writing them: inline module plugins (16.0 needs `allowInline: true` on the plugin entry), `mcp.protocolVersions` naming 2024-11-05, Node.js 24. `--dry-run` prints the plan and the diff; `--in-place` keeps a `<file>.pre-v13.bak` backup; without either it writes `<name>.v13-ready.<ext>`; `--json` prints `{ to: 13, writes: 12, changes, pending, report, diff }`. Idempotent. Refuses files that are not schema v12 and `isolation` / `runtime` pairs that disagree (exit 1); `config diff --to v13` exits 3 when the file would change.

### Documentation

- `docs/v16/freeze.md` (draft): the surfaces 16.0 keeps as in 15.x, what 16.0 changes and what the 15.9 codemod does for each. Decision recorded there: the inline opt-in is per plugin entry (`allowInline: true`), because `plugins` is a list.
- `docs/migrating-to-v16.md`: the codemod section; `docs/deprecations.md` links it.

### Additions after the freeze

Additive only, as allowed by the [freeze list](docs/v15/freeze.md): `config migrate` / `config diff` accept `--to v13` (before: refused with exit 1); `--to v12` behaves exactly as before. No route, response field, error code, HTTP status mapping, config key or plugin API changed. The codemod is loaded on demand by the CLI only (not in the gateway's start-up graph).

### Tests

- `test/v13-codemod-15-9-1.test.ts` (written first; failing-before: module missing → `v13codemod-failing-before`): C1 alias rewrite (comments kept, still v12, same effective runtime, alias deprecations gone), C2 v13-only items pending and never written, C3 idempotent / clean file, C4 refusals (conflicting `isolation` / `runtime` — the v12 loader already refuses it, so the test expects the loader's message; non-v12 files; JSON input), C5 CLI (`--dry-run` writes nothing, `--in-place` backup, `validate` passes on the result, `config diff` exit 3 / 0, `--json`, second run is a no-op, `--to v14` refused). After the failing-before run the fixture's server got the required `id` / `name` and the C4 assertion was pointed at the loader's message.

## [15.9.0-canary.0] - 2026-10-14

**Development prerelease** (npm dist-tag `canary`, image `:15.9.0-canary.0` only — not for production; `latest` stays on 14.9.x and `next` on the 15.0 release candidate). First build of the 15.9 line (v16 preparation): every removal proposed for 16.0.0 is now announced as a deprecation, one minor ahead, with a draft migration guide. Behaviour is unchanged. 15.0.0 itself has not shipped — its gates A / B / C are still open ([v15 gates](docs/v15/gates.md)) — and the 16.0 list stays a proposal until 16.0.0-rc.1.

### Deprecated (removed in 16.0.0 — proposal)

Each use is reported as `DEPRECATED (removed in 16.0.0)`: logged once per id, listed by `mcp-gateway validate` and by `GET /api/v1/admin/deprecations`. Ids in [deprecations](docs/deprecations.md#planned-removals-in-1600-announced-1590-canary0).

- `v16.plugins.<i>.isolation` — `isolation: worker | process | inline` on a module plugin (the 14.3 alias of `runtime`). 16.0 reads only `runtime`. WASM components keep `isolation: tenant | client | shared`, which is a different setting and is not deprecated.
- `v16.plugins.<i>.inline` — a module plugin running inline, in the gateway process (`runtime: inline`, or `isolation: inline`). 16.0 (config schema v13) runs inline module plugins only with an explicit opt-in.
- `v16.mcp.protocol-2024-11-05` — `mcp.protocolVersions` naming `2024-11-05` (config), or a downstream `/mcp` session that negotiates it (runtime). Upstream servers on HTTP+SSE stay supported.
- `v16.node.<major>` — running on Node.js older than 24 (runtime). 16.0 needs `engines.node >= 24`; Node 22 maintenance ends 2027-04-30.

### Documentation

- `docs/migrating-to-v16.md` (draft): what changes in 16.0, what to do on 15.9, rollback. The `config migrate --to v13` codemod and the 16.0 freeze list follow in 15.9.0-canary.1.
- `docs/guides/plugins.md`: the example no longer shows an inline module plugin.

### Additions after the freeze

Additive only, as allowed by the [freeze list](docs/v15/freeze.md): new entries in the existing deprecation lists (config and runtime). No route, response field, error code, HTTP status mapping, CLI flag, config key or plugin API changed. A config that loaded on 15.3 loads on 15.9 the same way.

### Tests

- `test/v16-prep-15-9-0.test.ts` (written first; failing-before: module missing → `v16prep-failing-before`): D1 module-plugin `isolation` alias announced, WASM component isolation not; D2 inline module plugins announced; D3 `mcp.protocolVersions` with 2024-11-05 announced; D4 Node < 24 announced, 24+ not; D5 `validateConfig` lists them, behaviour unchanged; D6 a `/mcp` session on 2024-11-05 records the runtime deprecation once, newer revisions do not.
- `test/admin.test.ts`: the runtime deprecations assertion ignores the environment-dependent `v16.node.<major>` entry.

## [15.3.0-canary.1] - 2026-10-14

**Development prerelease** (npm dist-tag `canary`, image `:15.3.0-canary.1` only — not for production; `latest` stays on 14.9.x and `next` on the 15.0 release candidate). Second build of the 15.3 line (AI generation governance): everything in 15.3.0-canary.0 plus per-tenant generation budgets, the approval ↔ lineage link, a prompt-injection regression corpus and the Motionary interop check under tool schema governance. 15.0.0 itself has not shipped — its gates A / B / C are still open ([v15 gates](docs/v15/gates.md)) — so no 15.x release after it can become stable before it.

### Added

- **Per-tenant generation budgets** — `costs.budgets[]` gains three optional keys: `perTenant: true` (every acting tenant gets its own budget, subject `tenant:<id>`, without listing tenant ids; callers without a tenant share `tenant:(none)`), `tools` (`server/tool` globs — only matching calls count, and only matching calls are refused) and `measure: calls` (count calls, also unpriced ones, instead of summing cost — "20 image generations per tenant per day"). Refusals are the 4.3 ones (`-32013`, REST `429` + `Retry-After`); `GET /api/v1/costs` lists each subject with its `measure`. `perTenant` cannot be combined with `tenants`, `clients` or `perClient` (configuration error).
- **Approval ↔ lineage link** — an approval request carries the held call's `correlationId` (from `X-Request-Id` / `X-Correlation-Id` / MCP `_meta.correlationId`) and, once the call has finished (approved and run, denied, expired, cancelled), its `requestId`; the call's lineage (`GET /api/v1/admin/ops/lineage/:requestId`, `?correlationId=`) carries `approval: { id, status, decidedBy }`. Calls that were not held have no `approval` field.
- **Motionary interop under tool schema governance** — `test/motionary-schemas-15-3-1.test.ts` (CI job "MCP compat matrix", now pinned to Motionary **14.8.0**): every Motionary MCP tool is digested and pinned, the structured tools (`check_compatibility`, `suggest_fix`, `list_templates`) pass `validateOutput: enforce` with 0 violations, and a stale pin refuses the call before it reaches Motionary. MCP 3.0 (Motionary 16) is not published yet; this covers MCP 2.x tool schemas.

### Security hardening

- With `policy.outputFilter` applied to a tool, `_meta["mcp-gateway/flags"]` is always this gateway's own verdict: an upstream's value is dropped when there is no finding (before, it passed through unchanged) and, as before, replaced when there is one. Other upstream `_meta` keys are untouched. Not a vulnerability (the forged key could only add a false flag, never hide a finding), so no advisory and no LTS backport.

### Additions after the freeze

Additive only, as allowed by the [freeze list](docs/v15/freeze.md): three optional keys on the existing `costs.budgets[]` entries (without them nothing changes), a `measure` field on `GET /api/v1/costs` budget rows, `correlationId` / `requestId` fields on approval requests, an `approval` field on lineage records of held calls, and `CostLedger.blocked()` taking the call's server and tool (optional arguments). No existing route, response field, error code, HTTP status mapping, CLI flag or plugin API changed.

### Benchmark baseline

- `bench/baseline.json` linux-x64: only the deterministic `modules` / `moduleKb` re-recorded (minimal 287 → 298 modules, 1995.2 → 2202.4 KB; all 413 → 424, 2697.8 → 2906.4 KB) — the lean graph had grown 10.4 % in bytes across 14.1–15.3 and reached the 10 % guard. The one eager addition the guard caught (the 15.3.0-canary.0 tool-schema governor and validator) was made lazy first; timings, memory, `featureModules` and `lazyDeps` limits are unchanged. Justification recorded in the file (`moduleSizes`).

### Tests

- `test/generation-governance-15-3-1.test.ts` (written first; failing-before 8/10 → `gen1531-failing-before`): G1–G4 per-tenant generation budgets (REST end to end with two tenants, ledger rules, 4.3 shape unchanged, config validation), A1–A3 approval ↔ lineage (approved, denied, not held), I1–I3 prompt-injection regression corpus (13 hostile results: every phrasing caught by the built-in detectors; denied tools stay denied, held tools stay held, other tenants' servers stay forbidden after each; forged `mcp-gateway/flags` dropped). Two assertions were corrected after the failing-before run to the frozen REST error shape (`code` + `budget` / `policy` at the top level, not `error.data`). Fixture: `fake-mcp-server.mjs` gains a `raw` tool (returns `arguments.result` verbatim).
- `test/motionary-schemas-15-3-1.test.ts` (M1–M3, runs with `MGW_MOTIONARY_BIN`; verified locally against motionary@14.8.0 from npm).

## [15.3.0-canary.0] - 2026-10-14

**Development prerelease** (npm dist-tag `canary`, image `:15.3.0-canary.0` only — not for production; `latest` stays on 14.9.x and `next` on the 15.0 release candidate). First build of the 15.3 line (AI generation governance) from `main`: everything in 15.2.0-canary.1 plus tool schema governance. 15.0.0 itself has not shipped — its gates A / B / C are still open ([v15 gates](docs/v15/gates.md)) — so no 15.x release after it can become stable before it.

### Added

- **`policy.toolSchemas.validateOutput`** (`off` default · `audit` · `enforce`, optional `tools` globs): a successful tool result of a tool that declares an `outputSchema` (MCP 2025-06-18) is checked — its `structuredContent` must match, and must be present. `audit` passes it through, counts and logs it; `enforce` refuses the call with `-32005` "Tool output blocked: structuredContent does not match the tool's outputSchema" (`data.decision: output-schema`, the first errors as JSON Pointer + message; REST `502` like the output filter, an error on `/mcp`) so nothing of the invalid result reaches the client. `isError` results and tools without an `outputSchema` are not checked. Built-in, dependency-free JSON Schema validator for the vocabulary tool schemas use (`policy/json-schema`).
- **`policy.toolSchemas.pins`** (`server/tool` → sha256 of the canonical `{ inputSchema, outputSchema }`) and **`onDrift`** (`block` default · `audit`): a call to a pinned tool whose schema changed (or that is no longer listed) is refused before the upstream call (`403` / `-32003`, `data.decision: schema-drift` with the pinned and current digest) or, with `audit`, passed and counted.
- **`GET /api/v1/admin/ops/tool-schemas`** (operators and console viewers): every listed tool's `sha256`, `inputSchema` / `outputSchema` present, `pinned`, `drift`, counters since start (`violations`, `driftCalls`, `driftRefusals`) and `missing` pins. Guide: [Tool schema governance](docs/guides/tool-schemas.md).

### Additions after the freeze

Additive only, as allowed by the [freeze list](docs/v15/freeze.md): one new optional config section `policy.toolSchemas` (nested under the existing `policy` key; no new top-level key; without it nothing changes), one new read-only console route, new internal modules `policy/json-schema` and `policy/tool-schemas`. No existing route, response field, error code, HTTP status mapping, CLI flag or plugin API changed.

### CI

- `deploy-examples.yml`: the image build retries once and then falls back to the same official Node image on Docker Hub (`--build-arg NODE_IMAGE=docker.io/library/node:22-alpine`) when public.ecr.aws answers `429 Data limit exceeded` (it failed the 15.2.0-canary.1 merge-commit gate twice).

### Tests

- `test/tool-schemas-15-3-0.test.ts` (written first; failing-before: modules missing → `schemas153-failing-before`): J1–J3 validator and digest, O1–O5 output validation (default unchanged, enforce over REST and `/mcp` without leaking the invalid result, missing `structuredContent`, `isError` / no-schema tools untouched, audit counts, `tools` scoping), P1–P4 pins (digest listing and operator-only access, matching pin, drift refused before the upstream with other tools unaffected, `onDrift: audit`, missing pins), V1 config validation. Fixture: `fake-mcp-server.mjs` gains `SCHEMA_TOOLS=1` (a `weather` tool with an `outputSchema`).
- `test/tool-schemas-lazy-15-3-0.test.ts` (written first; failing-before 2/2 → `schemas153-lazy-failing-before`): the governor and validator are loaded on first use, so a gateway without `policy.toolSchemas` never evaluates them — the first PR build failed the kernel bench module guard (`minimal` moduleKb 2213.4 > 1.1 × baseline 1995.2 + 5 on linux-x64); with the lazy import it is 2198.2.

## [15.2.0-canary.1] - 2026-10-14

**Development prerelease** (npm dist-tag `canary`, image `:15.2.0-canary.1` only — not for production; `latest` stays on 14.9.x and `next` on the 15.0 release candidate). Second build of the 15.2 line (plugin ecosystem and SDK): everything in 15.2.0-canary.0 plus plugin testing, reproducible verification, the compatibility matrix and MCP `_meta` correlation ids. 15.0.0 itself has not shipped — its gates A / B / C are still open ([v15 gates](docs/v15/gates.md)) — so no 15.x release after it can become stable before it.

### Added

- **`@winstonsayno/mcp-gateway/testing`** — a new package export for plugin tests (framework-free: `node:test`, vitest, jest, mocha). `startPluginHarness(entry, { baseDir, trust })` loads one `plugins[]` entry exactly like the gateway (signature check, `worker` / `process` runtime, permissions, limits, failure mode) with `callTool`, `respond`, `status`, `update` (hot-reload semantics: a failed update throws and the running plugin keeps serving), `unload`, `crash` (kills the isolated runtime as an OOM kill would) and `close`; plus `toolCall` / `toolResponse`, `createTestSigningKey` / `signPluginFile`, `verifyArtifact` / `verifyReproducible` and the compatibility matrix. Guide: [plugin SDK → test, verify and ship](docs/guides/plugin-sdk.md#test-verify-and-ship-1520-canary1).
- **Reproducible signature check** — `mcp-gateway plugin verify <file> … --rebuilt <file>` (repeatable): the signature must verify and every independent rebuild from the same source must have exactly the signed sha256 (exit `1` naming the differing rebuild). Library `verifyReproducible()` in `plugins/trust`. Without `--rebuilt` the command is unchanged.
- **Plugin compatibility matrix** — [docs/guides/plugin-compatibility.md](docs/guides/plugin-compatibility.md): plugin API v1–v5 × gateway 2.0 → 15.x (plus the 16.0 / 17.0 roadmap proposals, marked as such) and the plugin API v5 capabilities by release; the same data as `PLUGIN_COMPATIBILITY` / `pluginApiSupport()` / `isPluginApiSupported()` (a test keeps page and data identical).
- **Example third-party plugin** — [`examples/plugins/tool-quota`](examples/plugins/tool-quota/README.md): a signed per-client tool quota in a worker runtime, its operator config and a `node --test` file; install → update → revoke → crash recovery documented and tested in the worker and the process runtime.
- **MCP `_meta.correlationId`** — on `/mcp`, a request's `params._meta.correlationId` (same 1–128 character `A–Z a–z 0–9 . _ : -` rule as `X-Request-Id`) becomes the call's lineage `correlationId` and wins over the `X-Request-Id` / `X-Correlation-Id` headers, so each message of a batch can carry its own; an invalid value is ignored. (Planned for 15.1, delivered now.)

### Additions after the freeze

Additive only, as allowed by the [freeze list](docs/v15/freeze.md): one new package export (`./testing`; the package root, `./gateway` and `./edge` are unchanged), one new option of `plugin verify` (`--rebuilt`), one new optional `_meta` key read on `/mcp` (requests without it behave as before), new internal modules `plugins/compat` and `testing`. No existing route, response field, config key, CLI flag, exit code or plugin API changed.

### Fixed (found while writing the example)

- The testing harness keeps the event loop alive while it is open: isolated runtimes are `unref`'d (they never hold a gateway process open), so a plain `node --test` file waiting on a hook reply after a runtime restart could end with "Promise resolution is still pending but the event loop has already resolved". (Only the new harness was affected; the gateway always has its HTTP server open.)

### Tests

- `test/plugin-sdk-15-2-1.test.ts` (written first; failing-before: modules missing → `sdk1521-failing-before`; T4 failing-before without the keep-alive: exit 13 "unsettled top-level await" after `crash()`): S1–S3 reproducible verification (library + CLI), C1–C3 matrix (ranges, running version, page = data), T1–T4 testing export (package exports, harness, refused outcome, plain-node event loop), L1–L4 example lifecycle × worker / process (install with `requireSigned`, unsigned update refused / signed update replaces and closes the old runtime, key-only revoke refused / key + entry unloads / restart refuses, crash → fresh runtime with reset state), M1–M3 `_meta.correlationId` (rule, precedence over the header, invalid value ignored).

## [15.2.0-canary.0] - 2026-10-14

**Development prerelease** (npm dist-tag `canary`, image `:15.2.0-canary.0` only — not for production; `latest` stays on 14.9.x and `next` on the 15.0 release candidate). First build of the 15.2 line (plugin ecosystem and SDK) from `main`: everything in 15.1.0-canary.1 plus the plugin developer kit. 15.0.0 itself has not shipped — its gates A / B / C are still open ([v15 gates](docs/v15/gates.md)) — so no 15.x release after it can become stable before it.

### Added

- **`mcp-gateway plugin init <name>`** (`-d <dir>`, `--runtime worker|process`, `--force`): a plugin API v5 module that imports only `node:` built-ins (one signature covers it), its `plugins[]` entry (`runtime: worker`, `failure: closed`, explicit `limits`, `permissions` with `args: read`, `response: read`, `hooks: [onToolCall]`, `network: false`, `env: []`) and a `node --test` file. Refuses to overwrite without `--force` and refuses names that are not `[a-z0-9][a-z0-9_-]{0,63}`.
- **`mcp-gateway plugin doctor`** (`-c <config>`, `--json`): loads every module plugin of a config exactly like the gateway (signature check, runtime, options validation) and checks `config`, `load`, `runtime`, `api`, `hooks`, `network`, `limits`, `secrets`, `signature` — pass / warn / fail, exit `1` on any failure. Guide: [plugin SDK → plugin init and plugin doctor](docs/guides/plugin-sdk.md#start-from-the-template-plugin-init-and-plugin-doctor-152).

### Additions after the freeze

Additive only, as allowed by the [freeze list](docs/v15/freeze.md): two new subcommands of the existing `plugin` command (no new top-level command; the `plugin` description now lists them) and a new internal module `plugins/devkit` (not a package export). No existing command, flag, exit code, config key or plugin API changed.

### Tests

- `test/plugin-devkit-15-2-0.test.ts` (written first; failing-before: module missing): P1–P4 template (self-contained module, entry validates against the config schema, worker load and hook behaviour, CLI write / no-overwrite / bad name), D1–D6 doctor (clean scaffold passes, hook / network / load / options / inline mismatches, `features.pluginTrust.requireSigned`, invalid config, CLI exit codes and `--json`, no new top-level command).

## [15.1.0-canary.1] - 2026-10-14

**Development prerelease** (npm dist-tag `canary`, image `:15.1.0-canary.1` only — not for production; `latest` stays on 14.9.x and `next` on the 15.0 release candidate). Completes the 15.1 control-plane slice on `main`: tenant-scoped console viewers, the cost rollup, lineage over `/mcp`, and the dashboard lineage view. 15.0.0 itself has not shipped — its gates A / B / C are still open ([v15 gates](docs/v15/gates.md)) — so no 15.1 release can become stable before it.

### Added

- **Tenant viewers** (`controlPlane.console.tenantViewers: true`, default `false`): tenant members with role `owner`, `admin` or `viewer` read the call traces, lineage and cost rollup of **their own tenants only**. Another tenant's call (and a call without a tenant) answers `404`; a correlation id lookup lists only their calls; every other console route stays `403`. Operators and `controlPlane.console.viewers` keep the full view. Guide: [operations console → tenant viewers](docs/guides/operations-console.md#tenant-viewers-151).
- **Cost rollup** `GET /api/v1/admin/ops/costs?by=tenant|client|tool|day&since=<ISO 8601>`: totals from the cost ledger (`cost`, `calls`, tokens) plus a grand `total`, in the configured `currency`. Tenant viewers see only calls charged to their tenants. Guide: [operations console → cost rollup](docs/guides/operations-console.md#cost-rollup-151).
- **Dashboard → Operations → Lineage & costs**: look up a call by request id or correlation id (`X-Request-Id`), and the cost rollup by tenant / client / tool / day. The trace detail now shows the call's tenant. Demo mock answers both routes.

### Additions after the freeze

Additive only, as allowed by the [freeze list](docs/v15/freeze.md): one new optional config key (`controlPlane.console.tenantViewers`, schema v12 gains it as an optional property), one new admin route (`GET /admin/ops/costs`), a new `CostLedger.rollup()` method and new exports `tenantViewScope`, `TENANT_VIEWER_ROLES`, `COST_ROLLUP_BY` from the ops console module. Reason: 15.1 roadmap (tenant operators may only see their tenant; tenant cost rollup). No existing route, field, status code, config key or CLI flag changed; without the new key, behaviour is identical (tenant members get `403` on the console as before), and `GET /api/v1/costs` is unchanged.

### Tests

- `test/lineage-tenant-15-1-1.test.ts` (written first; failing-before 9/11): TV1–TV4 tenant viewer matrix (own tenant only, 404 for other tenants, correlation lookup per tenant, other console routes 403, non-members 403, off by default, invalid key never widens access), C1–C4 cost rollup (by tenant / client / tool / day, `since`, bad input, tenant scope, 4.3 `/costs` unchanged), M1 lineage of an `/mcp` `tools/call` with `X-Request-Id` (`via: mcp`, tenant scope), D1–D2 dashboard tab and demo mock.

## [15.1.0-canary.0] - 2026-10-13

**Development prerelease** (npm dist-tag `canary`, image `:15.1.0-canary.0` only — not for production; `latest` stays on 14.9.x and `next` on the 15.0 release candidate). First build of the 15.1 line from `main`: everything in 15.0.0-rc.4 plus call lineage. 15.0.0 itself has not shipped — its gates A / B / C are still open ([v15 gates](docs/v15/gates.md)) — so no 15.1 release can become stable before it.

### Added

- **Call lineage** (`GET /api/v1/admin/ops/lineage/:requestId`, `GET /api/v1/admin/ops/lineage?correlationId=`): one record per call with the caller (`identity.subject`, delegation `chain`), acting `tenant`, the config `generation` the call was pinned to, the `target`, the `decision` (for a refusal: layer, rule / policy, `configPath`), the `upstream` step, the priced `cost` (with `costs` configured) and the W3C `traceId`. Same access as the call traces (operators and `controlPlane.console.viewers`); no arguments, results or key material. Guide: [operations console → call lineage](docs/guides/operations-console.md#call-lineage-151).
- **Client correlation id**: the `X-Request-Id` (else `X-Correlation-Id`) a client sends on REST or `/mcp` — same rule as before, 1–128 characters of `A–Z a–z 0–9 . _ : -` — is kept with the call and searchable, so another system (for example an editor that sends one id per AI edit) can find the gateway calls behind its own records. It is never used for authorization.

### Additions after the freeze

Additive only, as allowed by the [freeze list](docs/v15/freeze.md): two new admin routes (above); new optional fields on the 14.8 call trace (`correlationId`, `tenant`, `generation`, `chain`, `cost` on `GET /admin/ops/traces[/:requestId]`); a new optional `correlationId` on the exported `InvokeContext` type (plus the invoker-internal `lineageSink`). Reason: 15.1 control-plane lineage (roadmap), and Motionary's AI edit provenance joins on it. No existing route, field, status code, config key or CLI flag changed; the REST response of a call is unchanged.

### Docs

- `docs/versions.md`: release lines `latest` (14.9.x, `maint/14.9.x`), `next` (15.0 RC, `release/15.0.x`), `canary` (15.1+, `main`).
- `scripts/docs-check.json` / docs-check: `otherPrereleases` (the 15.0 rc on `next` stays a valid reference while `main` is on `canary`).

### Tests

- `test/lineage-15-1-0.test.ts` (L1–L6: lineage fields, correlation lookup and charset, refusal layer / rule / config path, tenant + cost, access and prototype keys, 14.8 trace and REST response unchanged); docs-check `otherPrereleases` case.

## [15.0.0-rc.4] - 2026-10-13

**Prerelease** (npm dist-tag `next`, image `:15.0.0-rc.4` only — `latest`, `:latest` and `:14` stay on 14.9.x). Fourth 15.0 release candidate: rc.3 plus a change to how the container image is built. No change to the package contents, the frozen surface (REST / admin API, `/mcp`, CLI, plugin API v5, config schema v12, metrics, state formats) or the four 15.0 migration changes of rc.1. The v15 gates A / B / C are still open (see [v15 gates](docs/v15/gates.md)).

### Fixed

- **Multi-arch image build could hang on arm64** (forward-port of the 14.9.x fix, #224 / #225): the builder stage (dev `npm ci` + tsc) ran under QEMU arm64 emulation, which crashed with `qemu: uncaught target signal 4 (Illegal instruction)` and hung the 14.9.2 image build until the 30-minute job timeout. The builder now runs on the build host (`FROM --platform=$BUILDPLATFORM`) — its output, `dist/`, is architecture-independent — and only the runner stage (production `npm ci --omit=dev`) is built per target platform. rc.4 is the first release image built this way; gate A should run on this candidate or a later one.

### CI

- Supply-chain job: when ECR Public rate-limits the BuildKit image (`toomanyrequests: Rate exceeded`, which failed this job on #219, #224 and #226), `setup-buildx` falls back to Docker Hub instead of failing the PR (the release image workflow already did this).

### Docs

- Roadmap to 17.0: release channels (`latest` 14.9.x, `next` 15.0 RC, `canary` 15.1+ development), how the v15 gates are handled (unchanged, still open) and what the maintainer has to provide to close them (#226).
- `docs/v15/release-candidate.md`: rc.4; the stable line is 14.9.2.

### Tests

- `test/dockerfile-buildplatform.test.ts` (builder on `$BUILDPLATFORM`, runner per platform, only `dist/` copied from the builder).

## [15.0.0-rc.3] - 2026-10-12

**Prerelease** (npm dist-tag `next`, image `:15.0.0-rc.3` only — `latest`, `:latest` and `:14` stay on 14.9.x). Third 15.0 release candidate: rc.2 plus the 14.9.2 memory fix. No change to the frozen surface (REST / admin API, `/mcp`, CLI, plugin API v5, config schema v12, metrics, state formats) and no change to the four 15.0 migration changes of rc.1.

### Fixed

- **Durable task-graph run ids stayed in memory until retention deleted the run** (same fix as [14.9.2](#1492---2026-10-12)): about 0.2 KB per retained run on every instance — about +4 MB/h at 6 runs/s, about 680 MB at the default 168 h. Each instance now keeps at most 50 000 recent run ids in memory; older ids are read back from the store's run index (unchanged format) by full listings, and the frequent sweep pass visits the recent ids plus the runs it knows are still open. In-process harness (one instance + Redis, 60 000 runs): heap 30 → 46 MB on rc.2, flat 29–33 MB with the fix. The rest of the growth the 90-minute soak showed is the request log filling up to its fixed 100 000-entry cap (flat once capped — verified in-process with a lowered cap). Gate A (72-hour soak) still has to be run.

### Tests

- `test/durable-memory-14-9-2.test.ts`.

## [15.0.0-rc.2] - 2026-10-11

**Prerelease** (npm dist-tag `next`, image `:15.0.0-rc.2` only — `latest`, `:latest` and `:14` stay on 14.9.x). Second 15.0 release candidate: rc.1 plus the 14.9.1 P0 fix. No change to the frozen surface (REST / admin API, `/mcp`, CLI, plugin API v5, config schema v12, metrics, state formats) and no change to the four 15.0 migration changes of rc.1.

### Fixed

- **Gateway memory grew with the number of durable task-graph runs kept** (the rc.1 known issue; same fix as [14.9.1](#1491---2026-10-11)). The durable sweep's full pass loaded every retained run record at once, so the peak heap — and the process RSS — rose with each run started. Records are now read in chunks of 128, and ids of runs deleted by retention leave the run index (memory and store). 30-minute soak (2 instances + Redis): RSS growth +97 MB/h (rc.1 / 14.9.0: about +620 MB/h; 13.3.0: +30 MB/h on the same harness); gate A (72-hour soak) still has to be run.

### Tests

- `test/durable-memory-14-9-1.test.ts`.

## [15.0.0-rc.1] - 2026-10-11

**Prerelease** (npm dist-tag `next`, image `:15.0.0-rc.1` only — `latest`, `:latest` and `:14` stay on 14.9.0). The first 15.0 release candidate: exactly the four changes announced in 14.9.0 ([freeze list](docs/v15/freeze.md), [migrating to v15](docs/migrating-to-v15.md)); the rest of the frozen surface — REST / admin API, `/mcp`, CLI, plugin API v5, metrics, state formats — is unchanged. 15.0.0 itself waits for the v15 gates ([release candidate notice](docs/v15/release-candidate.md), [roadmap](docs/ROADMAP.md)).

### Removed / changed (breaking, announced in 14.9.0)

- **`schema.v11` — schema v11 files are refused.** A file with `version: 11`, or without `version` but using a v11-only field (`kernel`, `features.genaiTelemetry` / `policyShadow` / `postQuantumTls`), fails to load with the command that fixes it: `mcp-gateway config migrate --to v12 --in-place -c <file>`. `config migrate`, `config diff` and `config rollback` still read v11 files.
- **`v15.plugins.<i>.runtime` — module plugins run in a `worker` by default.** A module plugin entry without `runtime` / `isolation` loads in a worker thread (own heap, `limits`, `permissions`, crash isolation); `runtime: inline` (or `isolation: inline`) keeps the 14.x behaviour. Component (WASM) plugins are unchanged. `limits` / `permissions` on a plugin without `runtime` are now valid; on `runtime: inline` they are refused as before.
- **`v15.config.unknown-key.<key>` — unknown top-level keys of a `version: 12` file are refused** (14.x ignored them). `$schema` is allowed.
- **`schema/v12-draft/` removed** (the 13.9 alias copy of the v12 JSON schemas) — use `schema/v12/config.schema.json`.

### Changed

- The 14.9 run-time notices for these ids are gone (the changes are in force); `GET /api/v1/admin/deprecations` keeps its shape.
- Release workflows: a GitHub prerelease publishes the image tag `<version>` only (no `<major>`, `<major>.<minor>`, `latest`) and does not publish the clients.
- `scripts/upgrade-test.sh` upgrades from 13.9.5, 14.8.0 and 14.9.0.
- [Roadmap](docs/ROADMAP.md) is now a version / status / acceptance tracker; 14.10 – 14.13 are dropped (follow-ups become 15.1 / 15.2 after GA); v15 gates A (72 h soak), B (fixed-hardware v13.3 comparison) and C (external security review) are open.

### Known issue

- Memory grows under sustained load in the 30-minute soak (about 600 MB/h on the test box vs about 30 MB/h for 13.3.0, same harness). Fixed in 15.0.0-rc.2 and [14.9.1](#1491---2026-10-11).

### Tests

- `test/v15-changes-15-0-0.test.ts` (C1–C5; replaces `test/v15-deprecations-14-9-0.test.ts`); tests that used schema v11 input now use v12 (or the migration path where v11 is the subject); plugin tests that rely on in-process state say `runtime: inline`.
- Upgrade / rollback on real SQLite and Redis from 13.9.5, 14.8.0 and 14.9.0 to the candidate (`test/upgrade-14-9-0.test.ts` via `scripts/upgrade-test.sh`).

## [14.9.2] - 2026-10-12

Memory fix found by the 90-minute soak of 15.0.0-rc.2 / 14.9.1. No API, configuration, schema, metrics or state-format change; the 15.0 freeze is untouched.

### Fixed

- **Durable task-graph run ids stayed in memory until retention deleted the run** — about 0.2 KB per retained run on every instance (the run index listing cache and the set of finished runs), so memory rose with the durable-run rate times `retentionHours`: about +4 MB/h at 6 runs/s, about 680 MB at the default 168 h. An in-process harness (one instance, Redis, request log capped) measured 196 bytes per run on 14.9.1 / 15.0.0-rc.2 (heap 30 → 46 MB over 60 000 runs) and a flat heap (29–32 MB) with this fix. Each instance now keeps at most 50 000 recent run ids in memory (`STORE_KV_MAX_IDS`); older ids are read back from the store's run index (`task-graphs:runs:<n>`, unchanged) by full listings — the API run list and the sweep's full pass — and the frequent sweep pass visits the recent ids plus the runs the instance knows are still open, so takeovers and approval timeouts of old open runs are as prompt as before. The set of finished runs is bounded the same way.

### Notes

- The other growth the soak showed is the request log filling up to its fixed cap (100 000 entries, as in 13.3); it stops at the cap. Verified in-process: 100 000 calls with the cap lowered to 2 000 leave the heap flat (+0.03 MB per 10 000 calls).
- Deployments below 50 000 retained runs per instance behave exactly as in 14.9.1 (no extra store reads).

## [14.9.1] - 2026-10-11

P0 fix for the memory growth the 14.9.0 soak found (and that 14.9.0 did not fix — see its corrected notes). No API, configuration, schema, metrics or state-format change; the 15.0 freeze is untouched.

### Fixed

- **Gateway memory grew with the number of durable task-graph runs kept** (RSS about +620 MB/h in the 30-minute soak, 2 instances + Redis, against about 30 MB/h for 13.3.0 on the same harness). Root cause: the durable sweep's full pass (every 30th sweep, every 15 s with `sweepIntervalMs: 500`) loaded **every** retained run record — `retentionHours` keeps them 168 h by default — at once, on every instance; the peak heap of that pass, and with it the process RSS (which does not shrink back), rose with each run started. Heap snapshots showed little retained memory; the growth was the sweep's working set. A sweep now reads run records in chunks of 128 (`SWEEP_CHUNK`), so its working set no longer depends on how many runs are kept. Same 30-minute soak: RSS growth **+97 MB/h** (14.9.0: +623 MB/h), V8 heap total flat at 76–107 MB (14.9.0 spiked to 190 MB), p95 15.6 ms, 0 invariant violations.
- **The durable run index kept every id ever started** — in memory (an array copied on every listing) and in the state store (`task-graphs:runs:<n>` keys). Ids of runs deleted by retention now leave the index on the instance that deleted them, and a peer drops them on its next full sweep when the record is gone.

### Notes

- What still grows after a restart is bounded: the request log fills up to its cap (`maxEntries`, 100 000 entries, as in 13.3), and each finished durable run kept by `retentionHours` costs roughly 0.2 KB per instance until it expires. With a high durable-run rate, a lower `taskGraphs.durable.retentionHours` lowers that ceiling.
- 13.9.x (LTS) is not affected: it has no durable sweep (durable task graphs came in 14.4.0). 12.0.x and 10.9.x neither.

### Tests

- `test/durable-memory-14-9-1.test.ts` — a full sweep over 3 000 retained runs holds at most `SWEEP_CHUNK` records at once (14.9.0: 3 001); runs deleted by retention leave the index in memory and in the store; a peer forgets runs another instance deleted; repeated create → finish → expire cycles keep the index flat.

## [14.9.0] - 2026-10-11

v15 release candidate line (roadmap 14.9 "v15 候选版"). 14.9.0 freezes the 15.0 API and config surface, announces the three 15.0 breaking changes as run-time deprecations, and adds the validation the 15.0 gates need: upgrade / rollback tests on real stores, migration validation, a consolidated security regression suite, a cross-tenant matrix, fuzz / property runs and a soak harness. The soak found unbounded growth of durable task-graph state; the fix here removes the latency blow-up and the unexecuted runs, but memory growth remains (see Known issue). `15.0.0-rc.1` follows on the npm dist-tag `next`; `latest` stays on 14.x.

### Added

- **15.0 API / config freeze** — [docs/v15/freeze.md](docs/v15/freeze.md): config schema v12 and its top-level keys, module declaration, environment, REST / admin API, MCP endpoint, CLI, plugin API v5, state formats, release artefacts, metrics and library exports are frozen until 15.0.0.
- **15.0 deprecations reported at run time** (log warning once per id, `mcp-gateway validate`, `GET /api/v1/admin/deprecations`): `v15.plugins.<i>.runtime` (module plugins without `runtime` will run in a `worker` in 15.0), `v15.config.unknown-key.<key>` (unknown top-level keys will be refused), alongside the existing `schema.v11`. Docs: [deprecations](docs/deprecations.md#removed-in-1500-announced-1490), [migrating to v15](docs/migrating-to-v15.md), [release candidate notice](docs/v15/release-candidate.md).
- `taskGraphs.durable.retentionHours` (default `168`, `0` = keep forever): finished durable runs (succeeded, failed, cancelled, compensated) are deleted this long after they ended; `compensation_failed`, `interrupted` and dead-lettered runs are kept until an operator acts on them.
- `downgradeLoss()` (config v12 → v11) reports what a downgrade would drop (`modules.lifecycle`, `modules.capabilities`) instead of dropping it silently.
- **Soak harness** — `scripts/soak.mjs`: two gateway instances on a shared Redis under steady load with fault injection (kill -9, Redis partition, Redis restart), checking durable exactly-once execution, cross-tenant isolation and response leaks, and reporting throughput, latency, recovery times and memory growth; `.github/workflows/soak.yml` (manual, self-hosted `soak` runner) for the 72-hour v15 gate.
- `scripts/upgrade-test.sh`, `npm run test:security`; CI job "Upgrade + security regressions (real Redis)"; [release gates](docs/release-gates.md) for v15.

### Fixed

- **Durable task graphs: sweep cost and stored state grew without bound** (found by the 30-minute soak). The sweep (every 2 s by default) loaded every run record ever written, and finished runs were never deleted. A sweep now loads only runs not known to be finished (a full pass every 30th sweep re-checks the rest and applies retention), and finished runs expire after `retentionHours`. In the soak this removed the latency blow-up (p95 343 → 13 ms) and the durable runs that were never executed (8 → 0). *Corrected after release:* it did **not** remove the memory growth — see Known issue.

### Known issue

- **Memory growth under sustained load is not fixed in 14.9.0.** In the 30-minute soak (2 instances + Redis, durable task graphs enabled) gateway RSS still grew about 620 MB/h with this release, against about 30 MB/h for 13.3.0 on the same harness and machine. Cause: the durable sweep's full pass loaded every retained run record at once — fixed in [14.9.1](#1491---2026-10-11).

### Changed

- Plugin examples in the docs set `runtime` explicitly.
- README / docs: 15.0 release candidate notice (rc.1 is published after 14.9.0 under `next`).

### Tests

- `test/upgrade-14-9-0.test.ts` — 13.9.x / 14.8.0 state → current and rollback on real SQLite and Redis (rate limits, durable runs, regions, edge outbox, GitOps release record).
- `test/rc-migration-14-9-0.test.ts` — every example and docs config snippet migrates and validates; CLI migrate / rollback.
- `test/security-regressions-14-9-0.test.ts` — MGW-2026-001…019 registry mapped to tests, compact repros 012–019.
- `test/cross-tenant-matrix-14-9-0.test.ts` — REST, MCP, history, durable runs and ops traces across tenants.
- `test/fuzz-14-9-0.test.ts` — property runs for v12 parsing, migration, `${VAR}` expansion, loader ⇔ schema agreement, GitOps hashing, routing splits.
- `test/v15-deprecations-14-9-0.test.ts`, `test/durable-sweep-14-9-0.test.ts`.

## [14.8.0] - 2026-10-11

Operations console release (roadmap 14.8 "运维控制台升级"). Upgrades the existing dashboard and admin API — no rewrite: one cluster status view, per-call traces through the whole pipeline with step timings, policy denial explanations that name the rule, tenant or permission and the config path, an incident timeline, and a troubleshooting wizard that produces a redacted, shareable report. Operators see everything; `controlPlane.console.viewers` get read-only views.

### Added

- **Cluster status** — `GET /api/v1/admin/ops/cluster`: role, committed config generation (alive / pinned generations, rollbacks), data planes with the **diverged** nodes (not on the generation targeted at them), regions (fresh / stale, stale peers, replication lag per peer), edge gateways and their queued calls, plugin circuit breakers (open / half-open), task-graph **DLQ** counts by status, servers online / offline, failed feature modules.
- **Call traces** — every top-level call is traced: `GET /api/v1/admin/ops/traces` (filters `client`, `server`, `tool`, `outcome=ok|denied|error`) and `GET /api/v1/admin/ops/traces/:requestId` with the steps **auth → tenant → policy → plugins → route → upstream → cache → response**, each with its time (from the 13.8 pipeline stage clock), status (`ok` / `denied` / `error` / `skipped`), cache status and final route, plus the W3C `traceId` / `traceparent` of the gateway's OpenTelemetry span. Kept in memory (`traceBuffer`).
- **Policy denial explanation** — a refused call's trace carries `explain`: `decision`, `layer` (exposure, scope, tenant, delegation, policy, approval, plugin, residency, quota, budget, module, route), `rule`, `tenant`, `permission`, `reason` and the matching **`configPath`** (`policy.rules[0]`, `auth.apiKeys[3].scope.tools`, `tenants[1].members`, `tenancy.isolation`, …). `POST /api/v1/admin/ops/explain` answers *would this call be allowed* without making it (authorizer, then tool policy).
- **Denial explanations in error data, behind an admin flag** — `controlPlane.console.explainDenials: true` adds `policy.explain` to refused REST tool calls **made by operators**; scoped keys, tenant members and console viewers never get it (off by default).
- **Incident timeline** — `GET /api/v1/admin/ops/timeline`: restarts, config applies (and failed applies), GitOps releases / refusals / drift, revocations, plugin circuit opens, region stale / fresh transitions and refused calls (audit), newest first; filters `kind`, `since`, `until`, `subject`, `limit`.
- **Troubleshooting wizard** — `POST /api/v1/admin/ops/troubleshoot` (operators): upstream reachability, auth / key, tenancy / scope (central authorizer), policy (the 14.7 policy simulation against the running config), rate limits / recent quota refusals, plugin health → `pass` / `warn` / `fail` per check with the config path, an overall verdict, argument values `<redacted>`; shareable at `GET /api/v1/admin/ops/reports/:id`. Rate limited to 30 runs per minute per client (`429` with `RateLimit` headers).
- **RBAC** — `controlPlane.console.viewers` (client id globs): read-only console access (cluster, traces, explain, timeline, reports) without any other admin route; the wizard is operator-only. No console response carries key material, secrets or call arguments.
- **Dashboard: Operations page** — Cluster, Call traces (open a trace to see its steps and why it was refused), Incident timeline (kind / since filters), Troubleshoot (run checks / explain only). ARIA tab list with arrow / Home / End keys, labelled fields, focus moved to results, polite live region for status; demo mode mocks.
- `controlPlane.console` config (`enabled`, `viewers`, `traceBuffer`, `timelineBuffer`, `explainDenials`); config schema v12 describes it.
- Docs: [Operations console guide](docs/guides/operations-console.md), configuration `controlPlane.console`, API reference.

### Changed

- GitOps policy simulation (14.7): API key scope is now matched for recorded calls, whose client id is `key:<name>` (before, only bare key names matched, so scope changes were never reported for recorded or recent calls).
- Dashboard: the mobile bottom navigation keeps all seven sections on one row.
- Refused calls return their history / audit record id internally (`requestId`), so they can be traced; client responses are unchanged.
- `express-rate-limit` (already in the dependency tree through the MCP SDK) is now a runtime dependency, used for the troubleshooting wizard's per-client limit.

### Tests

- `test/ops-console-14-8-0.test.ts` (10): config schema; cluster status (operator / viewer / scoped keys, no secrets); call trace steps, order, timings, list and lookup, `__proto__` / `constructor` ids; denial explanation in traces and the explain API (policy rule, key scope path), never in client errors; `explainDenials` for operators only; incident timeline (restart, config apply, revocation, audit; kind / since filters, 400 on unknown kind; no secrets); troubleshooting wizard (checks, verdict, redacted arguments, shared report, unknown client, unknown server, operator-only); console disabled → 404, viewers get no other admin route; dashboard Operations page accessibility markup; wizard rate limit (30 / minute per client → 429).

## [14.7.0] - 2026-10-11

GitOps and governance release (roadmap 14.7 "GitOps 与治理"). Builds on declarative config (`diff` / `apply`, 7.1), config generations and cluster rollout (14.1) and schema v12 (14.0): the config lives in a git directory with environment overlays and secrets by reference only, every change is reviewed as an environment diff and a plan against the live gateway with a policy simulation, and a gateway can be set to accept only ed25519-signed releases approved by N people, with drift detection, audit entries and metrics.

### Security

- **MGW-2026-019 (High): `${VAR}` in string-form API keys and in `controlPlane.token` was used literally.** `auth.apiKeys: ["${OPERATOR_KEY}"]` — the form the control-plane and cluster-rollout guides showed since 7.0 — made the text `${OPERATOR_KEY}` a valid operator key, and a data plane with `token: ${OPERATOR_KEY}` sent the same literal, so a cluster set up from the docs worked while anyone who could reach it was an operator (`Authorization: Bearer ${OPERATOR_KEY}`). Only the object form `{ key: "${VAR}" }` was expanded (an unset variable there became an empty key). Fixed: references are expanded in every API key form and in `controlPlane.token`; a reference to an unset or empty variable is a config error. **Rotate any key that was written as a string reference.** Regression test `test/apikeys-env-mgw-2026-019.test.ts` (fails on 14.6.0). LTS backports: 13.9.5, 12.0.15, 10.9.16.

### Added

- **Config directories** (`mcp-gateway gitops render -d <dir> -e <env>`): `base.yml` + `environments/<env>.yml` overlays, `include:` (relative, inside the directory, no cycles), partials `_*.yml`; deep merge, id-keyed lists (`servers`, …) merged by id with `$delete: true`, `null` removes a key; `policy.files` inlined. **Secrets by reference only** — a literal secret (API keys, tokens, passwords, `authorization`, secret-named `env` / `headers` entries, URLs with credentials) is refused with its path; `${ENV}`, `secret://…` and `sha256:` key hashes are accepted. The bundle carries a canonical `sha256:` config hash.
- **`mcp-gateway gitops plan|diff|apply|status`** (text and `--json`): `diff -e staging --against-env prod` (no gateway) or against the running gateway (exit 3 on changes); `plan` = diff against live + manifest verification + would-apply / refusal + policy simulation; `apply [--dry-run]`; `status` (exit 2 on drift). Routes `GET /api/v1/admin/gitops/status`, `POST …/gitops/plan`, `POST …/gitops/apply` (operators).
- **Policy simulation for releases**: recorded calls (replay recorder), recent metrics or `--calls <file>` replayed against the running config and the candidate, layer by layer — server removed, API key removed / scope narrowed, tool policy (rule or default) — with every changed decision explained, `transitions`, `byClient`, `byTool`.
- **Signed releases** (`mcp-gateway/release-manifest@1`): `gitops keygen` (ed25519, private key `0600`), `gitops sign` (env, config hash, git sha, author; `--expires-in`), `gitops approve` (one ed25519 signature per approver), `gitops verify --trust <config>`. Verification: trusted author key with role `author`, valid signatures, environment and config hash match, age (`maxManifestAgeSeconds`), expiry, replay (must be newer than the applied release), `requiredApprovals` distinct approver names — the author never counts.
- **`controlPlane.gitops`**: `environment`, `enforce`, `trustedKeys[]` (`id`, `name`, `publicKey`, `roles`), `requiredApprovals` (number or per environment, default 2 for `prod` / `production`), `maxManifestAgeSeconds`, `driftCheckIntervalMs`, `recordFile` (applied release kept across restarts). Control plane or `role: all` only. Config schema v12 describes it.
- **Enforcement** (`enforce: true`): unsigned or unapproved bundles `403`; `PUT /admin/config` (non-dry-run), `POST /admin/reload` and feature `applyConfig` (config assistant) answer `409`. On a control plane an applied release is the next config generation and rolls out as `controlPlane.rollout` says.
- **Drift detection**: the running config is compared with the applied release (every `driftCheckIntervalMs`, on status and on metrics scrapes); changed paths are reported.
- **Audit and metrics**: audit entries on server `_gitops` (`gitops.apply` applied / refused with the reason, `gitops.drift` drift / in-sync); `mcp_gateway_gitops_applies_total{result}`, `mcp_gateway_gitops_drift`, `mcp_gateway_gitops_enforced`, `mcp_gateway_gitops_release_info{env,git_sha}`, `mcp_gateway_gitops_last_apply_timestamp_seconds`.
- `examples/gitops`: config directory for `staging` / `prod` and a GitHub Actions workflow (plan on pull requests, sign on main, approvers sign locally, verify + apply + status on release merges).
- Docs: [GitOps guide](docs/guides/gitops.md), configuration `controlPlane.gitops`, API reference.

### Changed

- `${VAR}` in `auth.apiKeys` (both forms) and `controlPlane.token`: an unset or empty variable is now a config error (was: literal text, or an empty key) — see MGW-2026-019.
- `scripts/docs-check.ts` validates gitops config directories rendered per environment and gives each `${VAR}` its own stand-in value.

### Tests

- `test/gitops-14-7-0.test.ts` (20): config directory rendering (includes, overlays, id merge, `$delete`, `null`, hash), include escapes / cycles / unknown environment, secrets by reference, env diff, keys / sign / approve / verify (author not counted, one approval per name, untrusted / forged approvals, tamper, wrong environment, approver-only author, age, expiry, replay), policy simulation with explanations, HTTP enforcement (unsigned / under-approved refused and audited, `PUT /admin/config` + `/admin/reload` 409, plan, apply, replay refused, drift + audit + metrics, environment / literal secret / `<redacted>` / hash checks, enforcement off), config + schema v12, CLI render / diff / keygen / sign / approve / verify / plan / apply / status, `examples/gitops` renders and validates, workflow.
- `test/apikeys-env-mgw-2026-019.test.ts` (2): MGW-2026-019 regression.

## [14.6.0] - 2026-10-11

Edge Autonomy release (roadmap 14.6 "Edge Autonomy 正式化"). Improves the existing 10.7 edge-autonomy module (`features.edgeAutonomy`) in place and makes it generally available: offline execution has explicit permission boundaries, the queue expires, conflicts go to a review queue, reconnect reconciliation is ordered, fenced and crash-safe (the 14.4 durable intent log), it honours revocations learned on reconnect (the 14.5 replicated revocations), and the queue is sealed at rest. Config schema v12 describes `edgeAutonomy`.

### Security

- **MGW-2026-018 (Low): edge-autonomy queued calls were replayed with a removed or revoked key, and the edge state files were world-readable.** On reconnect each queued call was replayed with the principal (and scope) captured when it was queued, so a key removed or narrowed while the edge was offline still had its queued calls executed upstream with its old rights, and a portal / operator revocation announced meanwhile was not consulted; `outbox.json` / `cache.json` (queued arguments, cached results, the caller's principal) were written with the process umask (typically `0644`). Fixed: every replay re-resolves the caller's current scope (a removed key's calls are `rejected`, never executed) and is refused for client ids revoked locally or by a revocation authority; the state files are written `0600` in a `0700` directory. Affected since 10.7.0 (stored principal since 11.1.0). LTS backports: 13.9.4, 12.0.14, 10.9.15. Regression test `test/edge-mgw-2026-018.test.ts`.

### Changed

- **High-risk calls are denied offline by default (behaviour change).** Before any local answer (`cache`, `wasm`, `queue`) the call's offline risk is classified — a declared `policies[].risk`, else the tool's MCP annotations (`readOnlyHint`, `destructiveHint`, `idempotentHint`), else the tool name (payments → critical; deletes and writes → high; reads → low; else medium). High and critical calls are refused with `-32018` unless a policy allows them (`policies: [{ match: "crm/update_*", offline: allow }]`); `highRisk: allow` restores the 10.7 behaviour. A 10.7-style config that queues `crm/update_*` without a policy now refuses those calls offline.
- **Queued calls expire.** Every queued call gets a TTL (`policies[].ttlSeconds`, else `queue.ttlSeconds`, default 24 h) and is never replayed after it (`queue.onExpiry`: `review` (default) or `drop`). `queue.maxItems` bounds the queue (default `outboxLimit`).
- **Replays run as the caller's current credential** and wait, after a reconnect, until revocation authorities are confirmed fresh (`reconcile.requireFreshRevocations`, default `true`; with `regions`: one sync round with every peer since reconnect).
- **The persisted queue and cache are sealed** (AES-256-GCM; key from `seal.keyEnv` or a generated `<dir>/.seal.key`, `0600`). A plaintext outbox from ≤ 14.5 is migrated on first load; a file that fails authentication is quarantined (`*.tampered-<ts>`) and not replayed.
- `features.edgeAutonomy` is no longer labelled EXPERIMENTAL (security posture, `GET /admin/edge-autonomy` → `experimental: false`).

### Added

- **Declared offline policies** `edgeAutonomy.policies[]`: `match`, `offline: allow|deny`, `risk: low|medium|high|critical`, `idempotent`, `conflictKey`, `ttlSeconds`; `edgeAutonomy.highRisk`.
- **Conflict handling and the review queue**: idempotency keys reuse the 14.4 durable intent log — the client's own key (`reconcile.idempotencyArg`) with the same payload returns the first receipt (`duplicate: true`), with another payload the call is parked for review (`idempotency-conflict`); replays the upstream rejects as a conflict / stale version go to review at once (`upstream-conflict`); concurrent offline writes to the same record by different clients (`policies[].conflictKey`) go to review (`conflict-key`). `GET /api/v1/admin/edge-autonomy/review`; `POST …/outbox/:id/retry` re-queues as an operator decision.
- **Crash-safe, fenced reconcile**: replays in queue order (a client's later calls to a server wait for its earlier ones), one reconciler at a time (`reconcile.leaseMs`) with a fencing epoch, and an intent / commit log under `<dir>/.reconcile` — after a `kill -9` a committed replay is never resent, an in-doubt idempotent one is resent with the same key, an in-doubt non-idempotent one goes to review (`outcome-unknown`).
- **Revocation authorities** (core, `gateway/revocations`): `regions` registers its replicated revocations; deferred work asks the authorities before acting. Local revocation notices (developer portal / operator) are remembered with the edge queue.
- **Report, CLI, metrics**: `GET /api/v1/admin/edge-autonomy/report`; `mcp-gateway edge report|queue|reconcile [--json]`; `mcp_gateway_edge_queue_items{status}`, `mcp_gateway_edge_queue_oldest_age_seconds`, `mcp_gateway_edge_decisions_total{action}`, `mcp_gateway_edge_offline_denied_total{risk}`, `mcp_gateway_edge_reconcile_total{result}`, `mcp_gateway_edge_outcome_unknown_total`, `mcp_gateway_edge_seal_failures_total`.
- Config schema v12 describes `features.edgeAutonomy`.

### Tests

- `test/edge-autonomy-14-6-0.test.ts` (15): schema defaults, risk classifier, high-risk denied offline for queue / cache rules, policy allow / deny / `highRisk: allow`, TTL expiry (review / drop) and full queue, idempotency keys, conflict keys, upstream conflicts and in-order holding, fencing, removed / revoked keys rejected, **simulated outage with two regions: a client revoked in region A while edge region B was offline (partitioned) is rejected on reconnect** (reconcile runs before the next periodic sync), revocations not confirmed fresh → pending, sealed files + tamper quarantine, `seal.keyEnv` + legacy migration, metrics / report / `edge` CLI.
- `test/edge-autonomy-restart-14-6-0.test.ts` (3): **`kill -9` of a gateway process mid-reconcile** (committed replay not resent, in-doubt non-idempotent replay → review, the rest replay once and in order), in-doubt idempotent replay resent with the same key, crash between upstream answer and queue write deduplicated by the intent log.
- `test/edge-mgw-2026-018.test.ts` (1): MGW-2026-018 regression (fails on 14.5.0).

## [14.5.0] - 2026-10-11

Multi-region consistency release (roadmap 14.5 "多区域一致性"). Improves the existing 5.2 Multi-Region module (`features.regions`) in place: the eventual-consistency boundary is now explicit, revocations replicate and fail closed during a partition, replicated config carries version vectors and generation fencing, and clock skew is bounded. Config schema v12 describes `regions` (new `consistency` block).

### Changed

- **Bounded staleness, fail closed (behaviour change).** With peers configured, a region is *fresh* while every peer synced within `regions.consistency.maxStalenessMs` (default `max(30000, 3 × syncIntervalMs)`). While it is not — partition, peer down, or right after start before the first sync — it refuses every tool call with JSON-RPC **-32027**, because it cannot confirm that no other region revoked the caller. `consistency.onStale: allow` restores the 14.4 behaviour; remove a permanently lost region from `peers` (hot reload). The admin API stays available.
- **Clock-skew bound.** A replicated write stamped more than `consistency.maxClockSkewMs` (default 30 s) ahead of the local clock is rejected and never advances the hybrid clock. 14.4 accepted any timestamp, so a region with a runaway clock won every later conflict (and a timestamp near 2^53 froze the clock mesh-wide).
- A region renamed by a hot reload (`self` changed) stops syncing under its old identity (14.4 kept the old sync timer running).

### Added

- **Explicit consistency boundaries** ([guide](docs/guides/multi-region.md)): replicated = revocations, `kv`, server availability; region-local = sessions, rate limits, quotas, budgets, policy, config / config generations, API and portal keys, caches, task runs, audit. Reported in `GET /api/v1/admin/regions/report` (`boundaries`); sync exchanges carry only the replicated state plus the sender's clock and a config fingerprint (policy hash + generation).
- **Replicated revocations**: `POST /api/v1/admin/regions/revocations` `{ clientId, reason? }`, `GET …/revocations`, CLI `mcp-gateway regions revoke`; developer-portal key revocations are recorded automatically as `key:portal-<id>`. A grow-only set (never un-revoked by a merge); a tool call by a revoked client id is refused with JSON-RPC **-32028** in every region within `maxStalenessMs`. Instances of one region share revocations through a shared store (redis / sqlite / eventlog); an instance that cannot read it is not fresh.
- **Version vectors and generation fencing** for `kv` (replicated config): causally newer writes win regardless of clocks (delayed / replayed versions are rejected), concurrent writes converge with a joined vector and are counted as conflicts (`conflictedKeys`); `PUT …/kv/<key>` `{ value, ifGeneration }` answers **409** with `currentGeneration` when the generation moved. Entries from 14.4 peers (no vector) merge last-writer-wins as before.
- **Region health and report**: `GET /api/v1/admin/regions/health` (200 fresh / 503 not, for load-balancer health checks); `GET /api/v1/admin/regions/report` and CLI `mcp-gateway regions report [--json]` / `regions health` — freshness and lag per peer, clock skew (`ok` / `exceeded`), policy drift between regions, conflicts, rejected entries, revocations, denied calls.
- **Metrics**: `mcp_gateway_region_fresh`, `mcp_gateway_region_replication_lag_seconds{peer}`, `mcp_gateway_region_peer_up{peer}`, `mcp_gateway_region_clock_skew_seconds{peer}`, `mcp_gateway_region_denied_total{reason}`, `mcp_gateway_region_rejected_entries_total{reason}`, `mcp_gateway_region_conflicts_total`, `mcp_gateway_region_revocations`.
- The `regions` module now registers a call hook (failure policy `closed`) and declares the `state-store` capability.

### Tests

- `test/regions-consistency-14-5-0.test.ts` (13): clock-skew bound, version vectors (causality beats wall clock, concurrent convergence), generation fencing, grow-only revocations, freshness; two in-process gateways with injected partitions and clock skew — revocation in A refused in B within the bound, partition → fail closed (-32027, health 503) → heal → revocation enforced, `onStale: allow`, kv 409, skewed peer flagged and its writes rejected while revocations still replicate, report / health / metrics / CLI, portal revocations.
- `test/regions-partition-redis-14-5-0.test.ts` (1): two regions, each with its own real Redis, peered through TCP fault proxies — region-local rate limits, replicated revocation, hard partition makes both regions fail closed, recovery, a second instance learning revocations through the shared store, store loss → fail closed.

## [14.4.0] - 2026-10-11

Durable task execution release (roadmap 14.4 "持久化任务执行"). Additive on the 10.7 task-graph engine and opt-in (`taskGraphs.durable`); without it task graphs behave as in 14.3. Config schema v12 gains the `durable` block, node keys `idempotent` / `idempotencyArg` / `approval`, `compensate.idempotencyArg` and the graph key `clients`.

### Security

- **MGW-2026-017 (Low) — task-graph runs kept acting with a removed or re-scoped key; checkpoints were world-readable.** Every node call of a run was authorized with the principal (and scope) captured when the run started, so a key removed or narrowed while its run was in flight — or before an operator resumed the run — still had the run's remaining calls executed with its old rights. Run checkpoints (`taskGraphs.dir`), which carry run inputs, node outputs and the caller's principal, were written with the process umask (typically `0644`). Fixed: each call re-resolves the submitting client's current scope (a removed key is denied; a stored delegation chain still narrows), and checkpoints are written `0600` in a `0700` directory. Affected: task graphs with `dir` / with keys revoked during a run since 10.7.0 (principal since 11.1.0) through 14.3.0, 13.9.2, 12.0.12 and 10.9.13 (reproduced on 13.9.2). Workaround: cancel a revoked key's runs (`POST /api/v1/admin/task-graphs/runs/:id/cancel`) and restrict the checkpoint directory to the gateway user.

### Added

- **Durable task execution** ([guide](docs/guides/durable-tasks.md)): `taskGraphs.durable` persists every step in the gateway store (redis / sqlite / eventlog) or `dir`, and a run left in flight by a restart, crash or `kill -9` continues from its **last committed step** (`resumeOnStart`); committed nodes are never executed again.
- **Leases and fencing**: the executing gateway holds a heartbeat lease (`leaseMs`) and a per-run fencing epoch; when it dies exactly one peer sharing the store takes over, and a stale executor is fenced out at its next write — several gateways can share runs over Redis.
- **Idempotency keys**: per task (`Idempotency-Key` header or `idempotencyKey`, scoped per client, `idempotencyTtlSeconds`; same key + same input → same run, different input → `409`) and per tool call (intent log: `<runId>:<nodeId>`; a committed result is reused; a non-idempotent call left in doubt by a crash or timeout is **never repeated automatically** — `outcome_unknown` → DLQ). `idempotencyArg` passes the call key to deduplicating upstreams; `idempotent: true` marks repeat-safe calls.
- **Failure queue (DLQ)** with retry policy (`dlq.retry`: attempts, exponential backoff, cap, jitter): list / show / replay (`force` for unknown outcomes) / discard (runs the compensations) under `/api/v1/admin/task-graphs/dlq`.
- **Approval resume**: nodes with `approval` (`approvers` globs, `required`, `timeoutSeconds`) pause the run as `awaiting_approval`, survive restarts, resume on approve and compensate on deny / timeout; the requester cannot approve its own run; every decision is audited.
- **Idempotent compensations**: finished compensations are not repeated after a crash; an in-flight one is re-run with its key (`compensate.idempotencyArg`) or marked for an operator.
- **Client routes** `/api/v1/features/task-graphs` for graphs with `clients: true`: a client starts, lists, waits on, cancels and approves within its own runs only; runs record their owner (client + every tenant membership); operators filter by `?tenant=` / `?client=`.
- **CLI** `mcp-gateway tasks runs|show|resume|cancel|approve|deny` and `mcp-gateway tasks dlq list|show|replay|discard`.
- **Metrics**: `mcp_gateway_task_runs_total`, `_idempotent_hits_total`, `_resumes_total`, `_takeovers_total`, `_lease_lost_total`, `_outcome_unknown_total`, `_dlq_entries`, `_dlq_retries_total`, `_compensations_total`, `_awaiting_approval`.

### Tests

- `test/durable-tasks-14-4-0.test.ts` (11): resume from the last committed step, intent log crash points, DLQ retry / replay / discard, approval resume / timeout / re-resolved principal, idempotent compensations, tenant isolation, metrics, file permissions and the CLI.
- `test/durable-tasks-restart-14-4-0.test.ts` (3): a real gateway process killed with `kill -9` mid-call — a non-idempotent call is never executed twice, an idempotent step resumes automatically, an approval-paused run survives.
- `test/durable-tasks-multi-14-4-0.test.ts` (3): two to three gateways sharing a real Redis — one run per idempotency key, no stealing while the lease holds, exactly one survivor takes over a dead owner's run.
- `test/task-graphs-mgw-2026-017.test.ts`: MGW-2026-017 regression (also on the LTS lines).

## [14.3.0] - 2026-10-11

Plugin security runtime release (roadmap 14.3 "插件安全运行时"). Config schema v12 gains optional plugin keys (`runtime`, `failure`, `permissions`, module-plugin `limits`); existing in-process plugins keep working unchanged (one-time deprecation note: `runtime: worker` becomes the default for module plugins in 15.0). v11 files are still migrated automatically.

### Security

- **MGW-2026-016 (Medium) — plugin signature verified different bytes than the gateway loaded.** With `pluginTrust`, the gateway verified a plugin file and then imported it again from disk (following its relative imports, which no signature covered; WASM components were read a second time too). Someone able to write to the plugin directory could swap the file between verification and load — or change an imported helper at any time — and run unsigned code despite `requireSigned`. The gateway now loads exactly the verified bytes (module plugins as a `data:` module, components from the verified buffer) and refuses a plugin whose file changed after verification; signed module plugins must be self-contained bundles. Affected: signed plugins since 5.4.0 through 14.2.0 / 13.9.1 / 12.0.11 / 10.9.12.

### Added

- **Isolated plugin runtimes** ([plugin security guide](docs/guides/plugin-security.md)): `plugins[].runtime: worker` (worker thread, `resourceLimits` heap cap) or `process` (child Node.js process, `--max-old-space-size`, Node permission model) — alias `isolation: worker | process`. A crash, `process.exit()`, uncaught async error, endless loop (per-call `limits.timeoutMs` → runtime recycled) or heap exhaustion (`limits.memoryMb`) ends only that plugin's runtime; the next call gets a fresh one (exponential backoff on repeated crashes). Hooks cross the boundary as structured-clone messages; `ctx.secrets` is proxied through the gateway; `ctx.logger` is forwarded. Child processes, nested workers, `process.binding` and addons are refused inside isolated runtimes.
- **Fine-grained permissions** `plugins[].permissions`: `args` / `response` (`read` drops rewrites / replacements), `secrets` (allow-list of granted names), `servers` / `tools` (globs scoping which calls the hooks see), `hooks`, and — in isolated runtimes — `network` (`false` or a host allow-list, checked before every TCP connection incl. `fetch`), `env` (only declared variables; default none) and `fs` (`process`: Node permission model; `worker`: best-effort guard).
- **Failure policy and circuit breaker**: `plugins[].failure: closed | open` or per hook (`{ onToolCall, onResponse }`); `limits.maxFailures` / `cooldownMs` open the circuit after consecutive failures (closed → refuse, open → skip) with a half-open trial; `limits.maxConcurrent` sheds excess calls as "busy".
- `GET /api/v1/plugins` reports `runtime`, `circuit`, `failures`, `lastError`, `restarts`, `alive`, `inFlight` and the declared `permissions`; `PluginHost.status()`.
- `schema/v12/config.schema.json` describes the `plugins` block (14.3 keys included).

### Deprecated

- Running module plugins in the gateway process by default: set `runtime: worker` (or `runtime: inline` explicitly to keep a plugin in process — required for `onRequest` / `routes`). 15.0 makes `worker` the default.

### Tests

- `test/plugin-runtime-14-3-0.test.ts` (R1–R10): exit / endless loop / heap blow-up / async throw in a worker never affect the test process (guarded: a hostile payload is never run in-process), failure open / closed, circuit breaker, args / secrets / scope permissions, a real TOCTOU test (file swapped right after verification → refused, swapped code never runs; signed entry cannot import unsigned files), config validation.
- `test/plugin-runtime-extra-14-3-0.test.ts` (X1–X6): `process` runtime (exit, OOM, Node permission model for `fs`), `network` / `env`, `hooks` / `response` / escape hatches, busy + half-open recovery, `isolation` alias + inline compatibility + v12 JSON Schema, and a running gateway that keeps serving `/health` and calls while a worker plugin exits, loops, runs out of memory and throws asynchronously.

## [14.2.0] - 2026-10-11

Tenant isolation release (roadmap 14.2 "租户隔离强化"). Config schema v12 gains one optional key (`tenancy`); configs without it keep their behaviour apart from the security fix below. v11 files are still migrated automatically. No breaking changes.

### Security

- **MGW-2026-015 (Medium) — cross-tenant credential use and spend.** For a client in several tenants, every per-call tenant decision used the caller's *first* membership instead of the tenant owning the called server: a `servers[].inject` reference with `{tenant}` sent the first tenant's secret to another tenant's upstream; cost budgets and quotas charged and blocked every tenant of the caller; cache partitions, policy-engine / Cedar `tenant`, data residency and plugin contexts saw the wrong tenant. Every per-call decision now uses the **acting tenant** — the caller's tenant entitled to the called server. Affected since 3.5.0 through 14.1.0 / 13.9.0 / 12.0.10 / 10.9.11.

### Added

- **`tenancy.isolation`** ([tenant isolation guide](docs/guides/tenant-isolation.md)): centralized isolation rules. Each server belongs to the first tenant whose `servers` globs match it; cross-tenant access is denied by default (`crossTenant: deny`), hidden from `tools/list` (REST and `/mcp`, per-session `list_changed`) and refused with decision `cross-tenant`; explicit sharing `grants` (`owner`, `tenants`, `servers`, `access: call | read`, `reason`) are the only way across, and every granted call is audited. `crossTenant: audit` keeps the old sharing but records crossings. Hot reloadable.
- **`mcp-gateway tenancy report [-c] [--json]`**: server owners, overlapping tenants, grants, credential scoping and findings (`overlap-ungranted` violation, `isolation-off`, `shared-credential`, `global-cache`, `grant-unowned-server`, `member-glob`, …); exits 1 on violations.
- **Audit**: request records carry `tenant` (acting tenant) and `tenantGrant`; `GET /api/v1/requests?tenant=`; the SQLite audit log gains `tenant` / `tenant_grant` columns (added to existing databases automatically).
- `schema/v12/config.schema.json` describes the optional `tenancy` block.
- **Joint example `examples/motionary-studio/`** (MCP 14.2 + Motionary 14.4 Studio): one Motionary MCP upstream per tenant, default-deny isolation, audit log per call.

### Fixed

- Semantic cache partitions use typed subjects, so a tenant id can no longer collide with a client id (`scope: tenant`).
- Plugin contexts (API v3+) get the acting tenant of the call.

### Tests

- `test/tenancy-14-2-0.test.ts` (I1–I11): acting tenant, credentials, budgets, audit, isolation + grants, config validation, report + CLI, per-tenant `list_changed`, and a property-based isolation matrix (fast-check, 300 runs: tenants × memberships × roles × grants × servers × catalog/call × principals against an independent oracle).
- `test/motionary-e2e.test.ts`: tenant A cannot see or call tenant B's Motionary tools; every call (allowed and refused) is audited with caller and acting tenant (real `motionary-mcp` in CI).

## [14.1.0] - 2026-10-11

Cluster coordination release (roadmap 14.1 "集群协调"). Config schema v12 gains one optional key (`controlPlane.rollout`, control plane only); clusters without it behave as in 14.0 (every data plane gets every config at once), with generations, data-plane local rollback and divergence reporting added. No breaking changes.

### Added

- **Config generations** ([cluster rollout guide](docs/guides/cluster-rollout.md)): every config a control plane distributes is a numbered generation (monotonic; identical content keeps its number). The config pull answers with the generation the asking data plane should run (`X-Config-Generation`, `generation`; data planes send `X-Node-Id`) and heartbeats report the generation each data plane runs.
- **Canary rollout** (`controlPlane.rollout.strategy: canary`, `canary.nodes` / `canary.percent`, `bakeMs`): a new generation goes to the canary data planes first; the rest stay on the stable generation until every canary node has run it for `bakeMs` without failures, then everyone is promoted. `all-at-once` stays the default.
- **Data-plane post-apply health check**: a data plane whose new config leaves every upstream offline (when some were online before the apply) after a grace period (half of `pullIntervalMs`, at most 5 s) re-applies its previous config, reports the generation as failed (`failedGeneration`, `lastError`) and does not re-apply the same config in a loop. `GET /api/v1/data-plane` shows `generation`, `failedGeneration`, `rollbacks`.
- **Automatic cluster rollback** (`failureThreshold`, `autoRollback`): when data planes fail the current generation the control plane marks it bad and publishes the last good config as a new generation. Re-submitting a bad generation's content is refused (status `refused`) until it is force-published.
- **Rollout API** (operators, `role: control`): `GET /api/v1/admin/cluster/rollout` (state, per-node targets, canary, failures, history, divergence), `POST /api/v1/admin/cluster/rollback` (`{ to?, reason? }`), `POST /api/v1/admin/cluster/rollout` (`{ force: true }`).
- **Divergence reporting** (`maxDivergenceMs`): a data plane off its target generation longer than this is listed as diverged (`converged: false`); data planes on the stable generation during a canary are not.
- **Cluster metrics**: `mcp_gateway_cluster_config_generation{role}`, `mcp_gateway_cluster_rollout_state{state}`, `mcp_gateway_cluster_diverged_nodes`, `mcp_gateway_cluster_rollbacks_total{role,trigger}`.
- `schema/v12/config.schema.json` describes the optional `controlPlane.rollout` block (files without it stay valid).

### Fixed

- Several gateways in one process: gateway-level Prometheus sources (reliability / telemetry, per-stage latency, authorization counters) are now kept per instance — before, the last gateway started overwrote them for every other gateway's `/metrics` (a leftover of 13.4.0 finding F3).

### Tests

- `test/cluster-14-1-0.test.ts` (rollout contract R1–R9) and `test/cluster-multinode-14-1-0.test.ts`: one control plane and three real data-plane gateways over HTTP — canary promotion, health-check failure → local + automatic cluster rollback, bad generation blocked without force, pre-existing upstream outage not blocking, divergence of a stopped data plane, cluster metrics.

### Performance
- `bench/baseline.json`: the linux-x64 kernel cold-start baseline is re-recorded from CI on the v14.0.0 merge (`all` start 144.5 ms, was a stale 74.7 ms from 13.0.0); method and previous values are kept in the file. See docs/benchmarks.md.

### CI
- Docker image workflow: the QEMU (binfmt) and BuildKit image pulls fall back from the ECR Public mirror to Docker Hub, then retry ECR Public after a pause, so one throttled registry (`toomanyrequests`) no longer fails a release image build (v13.8.0, v13.9.0 and v14.0.0 each needed manual reruns).

## [14.0.0] - 2026-10-11

Core architecture v2 (roadmap 14.0 "核心架构 v2") — the first major release of the 14.x line. Config schema v12 becomes the runtime schema, feature modules get one lifecycle with capability declarations and per-instance state, and the migration tool writes files. Built with adapters: authentication, the proxy layer and the 46 feature modules are unchanged in behaviour; legacy modules run through a v11-compat adapter. Upgrade guide with rollback steps: [docs/migration/v13-to-v14.md](docs/migration/v13-to-v14.md).

### Breaking changes

- **Config schema v12 is the runtime schema.** A `version: 12` file uses the `modules` block (`activation`, `failurePolicy`, `lifecycle`, `capabilities`) and module-named feature sections (`features.genaiOtel`, `features.policySim`, `features.pqTls`). The five v11 fields `kernel.modules`, `kernel.failurePolicy`, `features.genaiTelemetry`, `features.policyShadow` and `features.postQuantumTls` are **not part of schema v12** — a `version: 12` file that uses them is refused with the v12 name to use.
- **v11 files still load in 14.x — migrated in memory.** A `version: 11` file (or an unversioned file that uses a v11-only field) is converted in memory to the same runtime config, with one deprecation warning per v11 field and one startup notice. **Support for v11 files ends in 15.0.0.** Unversioned files without v11 fields read as v12 (identical). Mixing the two (`kernel` and `modules`, or `version: 11` with a v12 section name) is refused.
- **The admin API speaks schema v12.** `GET /api/v1/admin/config` (and the tools built on it: config diffs, config-assistant plans) returns `version: 12`, `modules.*` and the v12 section names. `PUT` / `POST` still accept v11 bodies (migrated in memory). Update clients that read `kernel.*` or the three renamed sections.
- **Control plane distributes schema v12.** A 14.0 control plane (`controlPlane.role: control`) sends `version: 12` to data planes; 13.x data planes refuse it — upgrade data planes first (14.x data planes read v11 and v12). `mcp-gateway desktop` writes v12 profiles.
- **Per-instance module state (13.4.0 finding F3).** Module state that was process-wide (approval queue, billing meters, GenAI spans, rollouts, budgets, task runs, SCIM directories, journals, …) now belongs to one `Gateway` instance, and a module's state is dropped when the module is disabled by a reload or the gateway stops — re-enabling it starts fresh. Embedders running several gateways in one process no longer share it; code that called a module helper outside any gateway (tests, scripts) uses a process-wide scope as before.
- **Capability denials refuse activation.** `modules.capabilities.<id>.deny` naming a capability the module declares refuses that module's activation (its failure policy applies — `closed` for security guards).
- Message text: an inactive module's 404 now names `modules.activation` and the v12 section (was `kernel.modules` / v11 names). `config migrate --to v12` without `--dry-run` now writes a file (13.9 only previewed).

### Added

- **Unified module lifecycle v2**: `init` → (`reconfigure`)* → `disable` → `dispose`, `health` at any time, with bounds from `modules.lifecycle` (`initTimeoutMs`, `unloadTimeoutMs`; a hanging `init` fails the module instead of stalling start or a reload). Modules opt in with `apiVersion: 2`; every other module runs through the **v11-compat adapter** (`mount` + `onStop`, as in 13.x). `GET /api/v1/admin/kernel` shows `lifecycle: v2 | v11-compat` and the declared `capabilities` per module. genai-otel is the first module on lifecycle v2.
- **Capability declarations**: every built-in module declares its runtime capabilities in the manifest (`background-timers`, `outbound-network`, `filesystem`, `state-store`, `signing-keys`, `invoke-tools`, plus `call-hook` / `security-guard`); a test checks each declaration covers what the module's source uses. Enforcement: activation is refused for a denied declared capability (all modules); modules on lifecycle v2 can only start timers (`ctx.timers`) and reach the network (`ctx.net.fetch`) through their context, which refuses undeclared or denied use, and the kernel clears their timers on disable / stop. Filesystem, signing keys and the other capabilities are declared and deny-able at activation; they are not intercepted at run time in 14.0.
- **Migration tool that writes files**: `mcp-gateway config migrate --to v12 -c gw.yml` writes `gw.v12.yml` next to the file (or `-o <path>`; `--force` to overwrite); `--in-place` rewrites the file after copying it to `gw.yml.v11.bak`; `mcp-gateway config rollback -c gw.yml` restores the backup (keeping the v12 file as `gw.yml.v12.bak`). Comments and layout are kept, the output is validated before anything is written, an already-v12 file is left alone. `--dry-run` and `config diff --to v12` keep working.
- **Version policy**: [docs/versions.md](docs/versions.md) — npm dist-tags, image tags and support windows per line. 13.9.x becomes a maintained line (branch `lts/13.x`, npm dist-tag `v13-lts`, image `:13`).
- **JSON Schemas move to `schema/v12/`** (`config.schema.json`, `module.schema.json`; titles no longer say DRAFT). Module declarations now say `apiVersion: v12`; the module schema still accepts `v12-draft`. The 13.9 path `schema/v12-draft/` stays as an identical copy (deprecated alias) until 15.0.0 — point editor `$schema` / CI references at `schema/v12/`.

### Unchanged (verified)

- The 13.5.0 security suite, the 13.7.0 multi-instance (real Redis) suite and the 13.6.0 MCP compat matrix pass unchanged. Authentication, authorization, the proxy layer and the failure-policy model (13.1) are untouched.

## [13.9.0] - 2026-10-11

v14 migration preparation (roadmap 13.9 "v14 迁移准备"). Config schema v11 remains the runtime schema — a v11 file loads exactly as before; no breaking changes.

### Added

- **Config schema v12 DRAFT** ([design](docs/design/schema-v12.md)): `schema/v12-draft/config.schema.json` and `schema/v12-draft/module.schema.json` (JSON Schema draft-07, generated by `scripts/gen-schema-v12.ts`, drift-checked in tests). v12 moves module settings into a `modules` block (`activation`, `failurePolicy`, NEW `lifecycle` bounds and `capabilities` denials), names every feature section after its module id, and defines the module declaration 14.0 will use: lifecycle methods (`init` / `reconfigure` / `disable` / `dispose` / `health`), capabilities, config sections, dependencies, failure policy. 13.x refuses `version: 12` with a pointer to the draft.
- **Deprecation inventory** ([docs/deprecations.md](docs/deprecations.md)): every v11 field v12 renames — `kernel.modules` → `modules.activation`, `kernel.failurePolicy` → `modules.failurePolicy`, `features.genaiTelemetry` → `features.genaiOtel`, `features.policyShadow` → `features.policySim`, `features.postQuantumTls` → `features.pqTls` (removed in 14.0.0). Each is logged once per field per process (at start and when a reload introduces it) and listed by `mcp-gateway validate` / `GET /api/v1/admin/deprecations`. Silence the log with `MCP_GATEWAY_SILENCE_DEPRECATIONS=all` or a list of ids / paths.
- **Migration preview**: `mcp-gateway config migrate --to v12 --dry-run [--json] [-o file]` prints the v12 config (YAML comments and layout kept), a unified diff and a compatibility report (errors / warnings / manual steps); `mcp-gateway config diff --to v12` prints the unified diff (exit 3 when the file would change, 1 on errors). Round-trip tests: every example config (plus the Kubernetes ConfigMap and Helm `config:`) migrates without errors, validates against the v12 draft and downgrades to the identical v11 config.
- **Module contract (13.9 completion criterion)**: all 46 modules have a v12 declaration derived from the manifest and validated against `module.schema.json`, and a new instance-isolation contract test (stopping one Gateway instance leaves the module active and reloadable in another).

### Fixed

- **genai-otel**: changing `features.genaiTelemetry.exportIntervalMs` on reload now reschedules the OTLP export immediately (13.4.0 finding F4; was read once at mount).
- **pq-identity**: removing `features.pqIdentity` now signs the final audit checkpoint over the chain head (13.4.0 finding F5; the disable cleanup read the live config, whose section was already gone).

## [13.8.0] - 2026-10-11

Performance and backpressure release (roadmap 13.8 "性能和背压控制"). Config schema v11 is unchanged except for one new optional section (`overload:`, off by default); no breaking changes.

### Added

- **Load protection** (`overload:`, [configuration](docs/configuration.md#load-protection-and-fair-scheduling-138)): admission control in front of every tool call (REST `/tools/call`, `/tools/stream`, MCP endpoint POSTs), after authentication and rate limiting. An adaptive concurrency limit (gradient: shrinks ×0.9 when a window of completions is `tolerance`× slower than the long-term average or above `targetLatencyMs`, +1 when healthy and saturated, clamped to `min`/`max`); excess requests wait in a bounded queue (`queue.maxSize`, `queue.perTenant`, `queue.timeoutMs`) and are shed with **HTTP 503 + `Retry-After`** (REST `{ error, message, reason, retryAfterSeconds }`, MCP JSON-RPC **-32030**).
- **Fair scheduling across tenants**: the admission queue is a weighted fair queue (start-time fair queuing; `fairness.weights` per tenant, `defaultWeight`), so a tenant flooding the gateway is served at its share and cannot starve the others. Clients without a tenant are their own flow.
- **Queue and load metrics**: `mcp_gateway_overload_limit`, `_inflight`, `_queue_depth{tenant}`, `_admitted_total`, `_shed_total{reason}`, `_queue_wait_ms{quantile}`.
- **Per-stage latency** (always on): `GET /api/v1/metrics?view=stages` (same access as `/api/v1/metrics`) and `mcp_gateway_stage_duration_ms{stage,quantile}` break each call into `queue`, `auth`, `authz`, `policy`, `hooks`, `routing`, `cache`, `upstream`, `finish`, `total`. `bench/load.mjs` prints the breakdown and the `Load + faults` CI job publishes it as a check-run annotation.
- **End-to-end p99 analysis** ([docs/perf/p99-analysis.md](docs/perf/p99-analysis.md)): the gateway's own stages add < 3 ms at p99; the tail is event-loop / upstream queueing, which the adaptive limit addresses.
- **Per-module cost report**: `scripts/module-costs.mjs` measures each of the 46 feature modules' import cost and, for call-hook modules, added p50 / p99 latency and allocation per call against a gateway without features; reference run committed as [docs/perf/module-costs.md](docs/perf/module-costs.md) + `.json`; CI job `Module cost report` (Performance workflow, informational) regenerates it on every PR.
- `Multi-instance reliability (real Redis)` is now a required release-gate check (`scripts/required-checks.json`, [docs/release-gates.md](docs/release-gates.md)).

## [13.7.0] - 2026-10-10

Multi-instance reliability release (roadmap 13.7 "多实例可靠性"). Config schema v11 is unchanged; no breaking changes.

### Added

- **Real-Redis fault-injection suite in CI** (job `Multi-instance reliability (real Redis)`, `test/multi-instance-13-7-0.test.ts`): spawned `redis-server` processes (crash + restart without persistence, `requirepass` + database number) behind a TCP fault proxy (latency beyond the command timeout, resets mid-pipeline, partitions) and up to four gateway instances sharing them. Covers the MGW-2026-012 reply-alignment regression across timeouts and reconnects, the store breaker across a crash, one rate limit across N instances under concurrent bursts, token revocation across instances and through a partition, MCP session recovery / termination / store data loss, and connection migration (cancellation and progress). The guarantees are listed in [docs/deployment.md](docs/deployment.md#multiple-instances-horizontal-scaling).
- **Cross-instance cancellation**: a `notifications/cancelled` that reaches a replica other than the one running the request is left in the shared store; the owning replica polls for it (every 250 ms while the request runs) and stops the call.
- `MCP compat matrix` is now a required release-gate check (`scripts/required-checks.json`, [docs/release-gates.md](docs/release-gates.md)).

### Fixed

- **MGW-2026-014 (Low): Redis commands could run before `AUTH` / `SELECT` had completed on a new connection.** The built-in Redis client published a connection as soon as the TCP / TLS handshake finished, so commands issued while `AUTH` and `SELECT <db>` were still in flight ran against database 0 — revocations, rate-limit / lockout counters and session records could be written to or read from the wrong database right after every (re)connect. Connections are now used only once `AUTH` / `SELECT` succeeded; a connection whose peer closed is no longer handed out.
- **A session terminated on one instance stayed usable on the others.** `DELETE /mcp` removed the shared record, but an instance that had adopted the session kept serving it, and its periodic refresh re-created the record. Termination now writes a tombstone and every instance re-checks a session's record at most once per second, so the session is rejected (404) cluster-wide within 1 s.
- **Sessions were not re-published after store data loss.** After Redis restarted without persistence (or failed over), sessions kept working only on the instance that held them; others answered 404 until the holder's next refresh (up to a minute). The holder now re-publishes a missing record on its next request.

## [13.6.0] - 2026-10-10

MCP protocol interoperability release (roadmap 13.6 "MCP 协议互操作"). Config schema v11 is unchanged; no breaking changes.

### Added

- **Client compatibility matrix in CI** (job `MCP compat matrix`, [docs/guides/client-compatibility.md](docs/guides/client-compatibility.md)): the official TypeScript SDK client on each downstream revision (2025-11-25, 2025-06-18, 2025-03-26, 2024-11-05) and the official Python SDK client (`mcp` 2.3.0, incl. its `server/discover` auto mode) against a gateway with stdio, Streamable HTTP and legacy SSE upstreams — initialize / negotiation, progress, cancellation, timeouts, `tools/list_changed`, session re-attach and termination. The job uploads `compat-matrix.json`.
- **Motionary example + E2E** (`examples/motionary`, `test/motionary-e2e.test.ts`): the gateway proxies the Motionary MCP server (`motionary-mcp`, stdio). Motionary is installed from npm (pinned `motionary@13.0.2`) only in the example / CI job, never as a dependency. The test requires a core tool set and accepts more (`MOTIONARY_EXPECT_TOOLS` adds expectations) so Motionary 13.7 can extend it.

### Fixed

- **Streamable HTTP upstreams: unsolicited notifications were lost.** The channel never opened the standalone `GET` stream, so `notifications/tools/list_changed` (and `resources/updated`, log messages, server requests without a related request) from Streamable HTTP servers never reached the gateway; downstream clients kept a stale tool list. The channel now opens the stream after `notifications/initialized`, accepts servers without one (405), and re-opens a dropped stream with `Last-Event-ID`.
- **`MCP-Protocol-Version` mismatch was accepted.** A request on a session negotiated at one revision carrying another supported revision in `MCP-Protocol-Version` was served (shaped for the negotiated revision). It is now refused with HTTP 400; requests without the header are unchanged.
- **Sessionless `server/discover`** (the 2026-07-28 probe sent by newer SDKs) got HTTP 400 "Mcp-Session-Id header is required"; it now gets JSON-RPC `-32601` so the client falls back to `initialize`.

## [13.5.0] - 2026-10-10

Security verification 2.0 release (roadmap 13.5 "安全验证 2.0"). Config schema v11 is unchanged; configs that load today keep loading, except the fail-closed cases listed under Upgrade notes (each of which previously started a weaker gateway than configured).

### Security

- **MGW-2026-013 (High): regular-expression denial of service in glob matching.** Globs (`*`, `?`) were compiled to backtracking regular expressions (`*` → `.*`), so a pattern such as `*a*a*a*a*a*a*a*a*a*zz` took seconds to minutes against an ordinary tool name, blocking the event loop. Some patterns are client-supplied: an authenticated client allowed to delegate could send one in the `tools` of an agent-identity token request (`POST /api/v1/features/agent-identity/token`) and stall the gateway for every tenant. Glob matching is now a linear matcher with the same semantics (property-tested against the old translation), and the compiled-pattern cache is bounded. Affected: 8.1.0 (first release with agent identity) through 13.4.0, 12.0.7 and 10.9.8. Fixed in 13.5.0, 12.0.8 and 10.9.9.

### Added

- **Combined security tests** (`test/security-13-5-0.test.ts`): cross-tenant isolation × agent / proxy authorization × routing × caching — refused calls (scope, tenant role, delegation, routed split target) never read the cache or reach the upstream; cache partitions by tenant, principal and scope; fail-closed configuration cases.
- **Property-based / fuzz tests** (`test/fuzz-13-5-0.test.ts`, fast-check as a devDependency only): glob semantics and linearity, cache-key injectivity, routing / tenant config parsing, tenant isolation of the authorizer, API-key header parsing — on top of the 10.2 suite (`test/property.test.ts`: config, JSON-RPC framing, JWT / bearer).

### Changed

- **Tool cache keys** carry the caller's tenant, principal kind, delegation actors and a scope fingerprint, and are an unambiguous JSON encoding (server ids / routed targets / tools / client ids can no longer collide). `scope: shared` rules share within one tenant only. The semantic cache partition uses the same unambiguous encoding.
- **Fail-closed configuration** (clear `Invalid configuration` errors): two `auth.apiKeys` entries with the same key value (ambiguous identity); an `auth` block without `strategy` that carries credentials or unknown keys (`enabled: true`, typos) — it used to resolve to strategy `none`, i.e. no authentication; an empty `host` (would listen on every interface); non-finite routing weights (`.inf`); server ids containing control characters.
- SECURITY.md: private vulnerability reporting verified enabled.

### Upgrade notes

13.5.0 is a minor release, but it includes security hardening that rejects some configurations that 13.4.0 accepted. Each case used to start a gateway that was weaker than what the file said. Config schema v11 is unchanged. If 13.5.0 refuses to start with `Invalid configuration`, find your case below:

| Now rejected | Why | Fix |
| --- | --- | --- |
| Two `auth.apiKeys` entries with the same key value (plain or `sha256:` form; error: `has the same key as apiKeys[N] (ambiguous identity)`) | The first entry's name, scope and tenant silently won | Give each client its own key, or merge the two entries |
| An `auth` block with no `strategy` that has credentials (`apiKeys`, `jwtSecret`, `jwt`, `oauth`) or unknown keys (for example `enabled: true` or a typo) | It resolved to strategy `none`, so authentication was **off** | Set `auth.strategy` (`api-key`, `jwt`, `oauth2`), or `none` explicitly if no auth is intended; remove unknown keys |
| `host: ""` (empty string) | It listened on every interface | Remove `host` to get the default, or set the address (for example `127.0.0.1`) |
| A non-finite `routing.splits[].variants[].weight` (`.inf`, `.nan`) | Weighted selection breaks with Infinity/NaN arithmetic | Use a finite number ≥ 0 |
| A `servers[].id` with control characters (U+0000–U+001F, U+007F) | Ids are used in cache keys, logs and routing | Rename the server using printable characters |

Behavior change without config edits: tool-cache entries are now partitioned by tenant, principal and scope (`scope: shared` shares within one tenant only), so hit rates can drop for a short time after the upgrade while the cache refills.

## [13.4.0] - 2026-10-10

Engineering quality release (roadmap 13.4 "工程质量整顿"). Config schema v11 is unchanged; no configuration changes are needed.

### Added

- **Module contract harness** (`test/contract-13-4-0.test.ts`, `test/helpers/module-contract.ts`): one shared lifecycle / security contract applied to all 46 registered feature modules — manifest consistency (registration, versions, activation keys, acyclic dependencies, minimal sections valid under schema v11), declared call hooks, failure policies (static, and at runtime with an injected init failure: `closed` → -32026 within the module's failure scope, `open` → call runs, `degrade` → result marked degraded), the init → reconfigure → disable → re-enable → stop lifecycle with background-timer accounting, generation pinning (hooks read only the call's pinned config) and the identity context every hook sees. A module added to the manifest is covered automatically.
- **Docs auto-check** (`scripts/docs-check.ts`, CI job `Docs check`): validates YAML config snippets — including the config inside Kubernetes ConfigMaps and Helm values — against config schema v11, JSON / TypeScript / JavaScript samples, `mcp-gateway` commands and flags against `src/cli.ts`, relative links and heading anchors, container image tags and version numbers (npm pins, `helm --version`, "latest x.y.z", chart version, README / dashboard versions). It fails on stale versions; supported LTS lines are listed in `scripts/docs-check.json`, historical migration guides are exempt from the version rules.
- **Deployment examples** that CI boots (`examples/deploy/`, workflow `Deployment examples`): Docker Compose (with the published image the example names and with an image built from the commit), plain Kubernetes manifests and the Helm chart on a kind cluster, each answering health and a tool call.
- **Release gate** (`scripts/release-gate.mjs`, `scripts/required-checks.json`, [docs/release-gates.md](docs/release-gates.md)): the release scripts refuse to tag, create a release or publish to npm unless every required check is green on the merge commit (conditional path-filtered checks must be green when they ran; any other failing check refuses too).
- `CONFIG_FILE_KEYS` export of the config loader (top-level keys the parser knows; used by tooling).

### Fixed

- Feature modules disabled by a hot reload (their config section removed) kept the background work they started running until the gateway stopped: the OpenTelemetry GenAI exporter, billing, the compliance-report scheduler, the chaos scheduler, the edge WASM runtime (warm instance pools stayed allocated), the tool-registry mirror sync and the post-quantum audit checkpoints. The kernel now gives every module its own `onStop` scope: cleanups run when the module is disabled as well as at shutdown, its routes are taken down, and re-enabling it mounts it once again (no duplicated timers). Cleanups registered by a module whose initialisation then failed are released too.
- The container image's `HEALTHCHECK` probed `http://localhost:4000`, which busybox `wget` resolves to `::1` while the gateway listens on IPv4 `0.0.0.0`, so containers were always reported `unhealthy` (Docker / Compose `--wait` / `depends_on: service_healthy`, Swarm restarts). It now probes `127.0.0.1`; the Compose examples too. Found by the new deployment-example CI job.
- On Kubernetes, a Service named `mcp-gateway` makes the kubelet inject the service-link variable `MCP_GATEWAY_PORT=tcp://<cluster-ip>:<port>`, which the gateway read as its listen port (`NaN`) and refused to start (CrashLoopBackOff). A `tcp://` / `udp://` / `sctp://` value is now ignored with a warning, any other non-numeric value is a clear startup error, and the Helm chart and the plain manifests set `enableServiceLinks: false`. Found by the new kind job.
- Call hooks notified of a refused call (`refused`: time-travel journal, post-quantum audit log) now receive the call's principal, like `before` / `after` hooks.
- Documentation (37 findings of the new check): stale image tags (`docs/deployment.md` still showed `:1` / `:1.0.0`; the cosign examples used `:11`), feature sections shown at the top level although they live under `features:` since 10.0 (DLP, edge fleet, multi-region guides), invalid YAML (unquoted `${VAR}` inside flow mappings in seven snippets), server entries without `name` / `transport`, a JWT example combining an HMAC secret with `RS256`, an output-filter pattern using an unsupported inline `(?i)` flag, and three broken anchors.

### Changed

- `docs/deployment.md` rewritten for 13.x: image tags and digest pinning (with `cosign verify`), Docker, Docker Compose, Helm and hardened plain Kubernetes manifests, all taken from `examples/deploy/`.
- `SECURITY.md`: GitHub private vulnerability reporting is enabled and is the reporting channel; a new "Audits" section states that there has been no independent third-party security audit.

## [13.3.0] - 2026-10-10

**Minor release — production reliability.** Config schema stays **v11**: the new keys (`health.restartAfter`,
`store.sqlite.busyTimeoutMs`, `observability.principal`, `observability.metrics.otlp`) are optional additions and
every 13.2 config loads unchanged. Includes a security fix, **MGW-2026-012** (Medium):
[SECURITY.md](SECURITY.md#security-advisories); backports in 12.0.6 and 10.9.7.

### Added
- **Reproducible load + fault benchmark** (`bench/load.mjs`). One in-process gateway in front of an HTTP upstream with
  a replica and a stdio child, with API-key auth, rate limit, response cache, quotas, budgets and policy rules in the
  hot path. A fixed number of requests from N workers, each with its own seeded PRNG, so two runs send the same
  sequence. Reports throughput, latency p50 / p95 / p99 / max (overall and per operation), unexpected-error rate,
  RSS / heap (start, end after GC, peak, growth per 10k requests), event-loop delay, upstream connections and
  failovers / resends / recycles. `--faults` kills the HTTP replica, stalls the stdio child and makes the HTTP upstream
  forget its sessions (non-overlapping windows, counted per faulted server); every fault must recover within 5 s
  with no errors afterwards. `--profile long` runs 60k requests at concurrency 32; `--store redis` puts a RESP store
  in the path. See [benchmarks](docs/benchmarks.md#load-and-fault-benchmark-133).
- **Performance workflow** (`.github/workflows/perf.yml`, separate from CI): kernel cold start, load and load with
  faults against `bench/baseline.json`, on pull requests that touch `src/` / `bench/`, on `main` and weekly. Only a
  gross regression fails (latency > 3× + 15 ms, errors > +0.5 pp, heap growth > 2× + 8 MiB per 10k requests,
  upstream connections > 2× + 8, throughput < ⅓, a fault that does not recover); a deliberate change updates the
  baseline in the same PR with a `justification`.
- **Reliability telemetry** on `/metrics` and, with `observability.metrics.otlp`, pushed as OTLP/HTTP JSON (no SDK
  dependency): `mcp_gateway_route_final_total{server,upstream}` (where calls really went after reroutes, splits and
  failover), `mcp_gateway_calls_by_principal_total{principal_type}` (direct / delegated / anonymous),
  `mcp_gateway_policy_denials_by_reason_total{reason}`, `mcp_gateway_module_failures_total{module}` and
  `mcp_gateway_module_failed{module}`, `mcp_gateway_config_generation`, `mcp_gateway_config_generations_alive`,
  `mcp_gateway_reloads_total{result}`, `mcp_gateway_upstream_failovers_total{server}`,
  `mcp_gateway_upstream_resends_total`, `mcp_gateway_upstream_recycles_total`, `mcp_gateway_state_store_up{backend}`,
  `mcp_gateway_state_store_failures_total{backend}`. Spans gain `mcp.route.final.server` / `mcp.route.final.upstream`,
  `mcp.principal.subject` / `.actor` / `.chain` / `.type`, `mcp.policy.deny_reason` and `mcp.upstream.resent`.
- **`observability.principal`**: how subject / actor ids appear on spans — `hash` (default: keyed HMAC-SHA256,
  16 hex characters; set `hashKey` so hashes correlate across instances and restarts), `plain` or `omit`. Metric
  labels never carry a principal.
- **State-store circuit breaker.** A Redis that accepts connections but never answers, or a SQLite file locked by
  another process, used to cost every request the full command timeout. Now the first failed operation opens a
  breaker: for 1 s every store operation fails at once (rate limits / lockouts / quotas then fail open or closed per
  `store.failureMode`, exactly as before — only without the wait), then one probe operation decides whether it closes.
  Errors Redis itself answers (`-ERR …`) do not trip it. `mcp_gateway_state_store_up` shows the breaker state
  (embedders: `StateStore.health()`).
- **`health.restartAfter`** (default 3, 0 = never): a server that stays "connected" but fails this many consecutive
  health pings (a hung stdio child, a stalled remote) has its session recycled — the stdio process is restarted.
  Before, a hung upstream was only marked degraded and every call to it timed out until a manual restart.
- **Session-expiry resend.** When an HTTP upstream answers 404 because it restarted and forgot the session, the
  request was provably not processed: the call now waits (within its own timeout, at most 3 s) for the reconnect and
  is sent once more on the new session instead of failing. A request that may have been delivered is never resent.

### Changed
- **Cold start without feature modules.** `jose` (JWT / OAuth), `ws` (WebSocket transport), `yaml` (config files)
  and the plugin-signature backend are imported on first use. A minimal gateway evaluates 267 modules / 1.77 MB
  instead of 443 / 2.50 MB and starts with ~38 MB RSS instead of ~54 MB (`bench/kernel.mjs`, linux-arm64). No
  behaviour change: a strategy whose dependency cannot load refuses the request.
- **SQLite lock wait.** `store.sqlite.busyTimeoutMs` (default **200**, max 5000) replaces the fixed 5000 ms: with the
  synchronous `node:sqlite` API a lock held by another process blocked the whole event loop for up to 5 s per store
  operation (spurious upstream timeouts on every other call). Past the wait the operation fails and `failureMode`
  applies.
- **Transport failures are classified by the gateway, not by error codes.** Only failures the gateway itself produced
  (connection lost, not connected, timeout) count as `not-connected` / `timeout` for `failoverOn` and `ejectAfter`. An
  upstream's own JSON-RPC error is `error` whatever its code — before, an upstream answering `-32000` was taken for
  "not connected", so the tool was **re-run on the next replica** (duplicate side effects) and the member ejected.
- `bench/kernel.mjs` reports `modules`, `moduleKb` and `lazyDeps` and fails when they grow more than 10 % (or a
  profile loads an on-demand dependency it does not use); `--write` merges into `bench/baseline.json` instead of
  replacing it.

### Fixed
- **Redis reply alignment (MGW-2026-012).** See Security.
- Fault matrix (`test/reliability-13-3-0.test.ts`): Redis down / stalled / reset, SQLite locked, HTTP upstream down /
  stalled / slow / 503 / restarted / flapping, stdio child killed / flapping / hung — each with bounded latency during
  the fault and recovery after it; combined circuit breaker + load balancing + rate limit + budgets + cache under
  failures (cost charged once, cache hits skip upstream and balancer).

### Security
- **Redis replies could be delivered to the wrong command after a timeout or reconnect (MGW-2026-012).** The built-in
  Redis client kept one reply queue for all connections. When a command timed out (the client then destroys the
  socket) or the connection reset, the old socket's `close` could fail commands that had already been written to the
  new connection, and their replies were then handed to later commands: `GET agent-identity:revoked:<jti>` could
  return another key's value — or `nil`, so a **revoked agent token was accepted** — and rate-limit / lockout
  counters could read other counters. Every connection now owns its reply queue and parser; a connection that timed
  out or received a reply nobody waits for is discarded with the commands it carried. Affected: deployments with
  `store.backend: redis` (all versions since 1.4.0); verified in 13.2.0, 12.0.5 and 10.9.6.

## [13.2.0] - 2026-10-10

**Minor release — transactional kernel reload.** Config schema stays **v11** (no new or changed keys; every 13.1
config loads unchanged). Includes a security fix, **MGW-2026-011** (Medium):
[SECURITY.md](SECURITY.md#security-advisories); backports in 12.0.5 and 10.9.6.

### Added
- **Versioned config generations.** Every committed configuration is a numbered, immutable generation: a deep-frozen
  snapshot of the config, the server configs it registers (replicas and catalog installs included) and the plugin
  instances that were active. The gateway starts at generation 1; every committed hot reload (and catalog
  install / uninstall) publishes the next one; a reload that fails publishes nothing. `GET /api/v1/admin/kernel` has a
  `reload` block (`generation`, `committedAt`, `alive`, `pinned`, `committed`, `rollbacks`); embedders have
  `gateway.generation` and `gateway.generations()`.
- **Calls are pinned to one generation.** A call pins the current generation when it starts and every config read of
  that call — policy, tenants, quotas, budgets, compliance, routing splits, call hooks, server config, injected
  credentials, plugins and the upstream session — comes from it, never from a generation committed while it was in
  flight. The final security snapshot (13.1.3) carries the `generation`; the send refuses a call that is no longer
  running in it (`config-generation-changed`), and spans carry `mcp.config.generation`.
- **Prepare / Commit / Rollback per server.** New servers are connected staged (13.1.1); **modified** servers now get
  a second session with the new config in the Prepare phase while the current session keeps serving, and the new
  session is swapped in at commit. A modify whose new config cannot connect fails the reload — the old server stays
  callable (a server that is down anyway is still reconnected after the commit, as before). The replaced session and
  the sessions of **removed** servers are retired, not closed: they finish the calls pinned to the previous generation
  and close when it retires (its last pinned call ended). Calls in flight are no longer cut off by a reload.
- **Fault injection.** `gateway.faults` takes a function per reload phase (`prepare:catalog`, `prepare:plugins`,
  `prepare:modules`, `prepare:servers`, `commit:router`, `commit:modules`, `commit:plugins`, `commit:servers`,
  `commit:final`) for tests and chaos drills; the regression suite fails a reload at every phase.

### Changed
- **Plugin updates are transactional.** A plugin that cannot be loaded now **fails the whole reload** (12.x–13.1 kept
  the running plugins but applied the rest of the config, so plugins and config disagreed). Instances built before the
  failure are closed. Replaced plugin instances stay open until the calls pinned to their generation are done; a
  commit failure after the swap brings the old instances back (never closed) and closes the new ones.
- **Feature module lifecycle is transactional.** During a reload a module `init`, `reconfigure` or `disable` that
  throws fails the reload instead of leaving the module failed (and, for `closed` security modules, refusing calls).
  Every step already taken is compensated in reverse order: reconfigured modules are reconfigured back, disabled ones
  initialised again, modules activated by the reload disposed (also a module whose `init` failed half-way). Only a
  compensation that itself throws marks a module failed (logged).
- **Rollback covers more.** A failed commit also restores mTLS, secret providers / rotation, federation peers, body
  limits and the trust-proxy setting; `pluginTrust` is now part of the reloaded config (it was compared but never
  applied).
- **Races.** Reloads stay serialized (one generation each). A reconnect of a server's old config that is still in
  progress when a reload installs the new session can no longer replace it (the supervisor's attempt is re-checked
  under the proxy's connect lock). Notifications (tools / resources changed) of a prepared or retired session are not
  published.
- Cached results of servers that were modified or removed are purged when the reload commits.

### Security
- **Calls in flight across a hot reload ran with the new configuration (MGW-2026-011).** A call that was waiting — for
  an approval (`approve` rule) or in a slow plugin / hook — while a reload committed was authorized under the previous
  configuration but sent with the new one: the new upstream session of a modified server and that server's new
  `inject:` credentials, without the new policy being applied (a call approved under a policy that the new
  configuration replaced with `deny` still ran, with the new credentials). Calls are now pinned to the generation they
  were authorized in (see above).

### Tests
- `test/reload-13-2-0.test.ts` (25 cases, written first: 23 failed on 13.1.3) — generations, modify / remove
  prepare-commit-rollback, in-flight pinning, plugin and module transactions, races, fault injection at all 9 phases,
  and a loop of 20 × 3 reloads asserting flat handles / timers / listeners / sessions / generations.

## [13.1.3] - 2026-10-10

**Security patch — final call security.** Config schema stays **v11**; no configuration changes. Advisories
**MGW-2026-009** (High) and **MGW-2026-010** (Medium): [SECURITY.md](SECURITY.md#security-advisories); backports in 12.0.4 and 10.9.5.

### Security
- **Credentials never cross a reroute (MGW-2026-009).** Per-call credentials (`inject:` on a server — tool arguments
  or `_meta` fields) are now always those of the server the call is **sent to**. Since routing splits were introduced,
  a call that a `routing` split moved from server A to server B carried **A's** injected credentials to B (hook
  reroutes — rollouts, blue/green, self-healing, budget downgrades — already used the final server's). A split target
  that needs a credential must declare its own `inject:`; nothing is injected otherwise.
- **Argument-dependent checks run on the final arguments (MGW-2026-010).** Call hooks may rewrite a call's arguments
  (DLP redaction, budget downgrades, plugin hooks). Before, the tool policy (argument rules), approval holds and the
  security guard modules that ran earlier (DLP, sanitize, approval flows, policy engine, …) were only re-checked when a
  hook also changed the target server, so a rewrite on the same server was sent unchecked and an operator could approve
  arguments that were not the ones sent. Now the final authorization re-runs the policy and every guard whose verdict
  was given on other arguments, until the arguments are stable (a guard that keeps rewriting is refused with
  `args-unstable`); refusals carry `argsChangedBy` (the hooks that rewrote the arguments).
- **Approval holds are placed on the final call.** An `approve` rule now holds the call in the final authorization,
  after the call hooks, on the final target and final arguments — the operator approves exactly what is sent (once;
  a reroute to a target with its own `approve` rule still asks again, as before).
- **Final security snapshot.** After the final authorization the invoker freezes the principal (and subject / actors
  of a delegated call), the upstream server, the tool, the approved business arguments and the credential target
  (always the upstream server). The upstream send refuses a call that differs from it (`snapshot-mismatch`, reasons
  `target-changed-after-authorization`, `arguments-changed-after-authorization`, `credentials-of-another-server`,
  `principal-changed-after-authorization`). Injected credentials are the only values added after the checks, and they
  override a caller-supplied argument of the same name.
- **Every refusal is traceable.** Request records (history, SQLite audit store, SIEM events) of failed calls now carry
  `decision` (the refusal reason: `deny`, `scope`, `reroute-denied`, `dlp`, `quota`, `budget`, `module-failed`,
  `snapshot-mismatch`, …, or `upstream-error`) and `errorCode`. Older audit databases get the two columns on start.
- A refused call never contacts the upstream server: covered by a unified reroute regression matrix (hook reroute,
  routing split, reroute + argument rewrite, rewrite without reroute, split to a non-exposed tool, reroute followed by a
  split) with a spy upstream.

### Upgrade notes
- Deployments that combine `routing` splits with `inject:` credentials: give every split target its own `inject:`
  entries (the requested server's credentials are no longer sent to it).
- Approval holds now happen after call hooks; a hook answering the call itself (`respond`, e.g. a semantic-cache hit)
  is still subject to the hold.

## [13.1.2] - 2026-10-10

**Security patch — one identity context per call.** Config schema stays **v11**. Advisories:
[SECURITY.md](SECURITY.md#security-advisories) — **MGW-2026-007** (high, delegated calls evaluated as the agent) and
**MGW-2026-008** (medium, token client ids without the issuer); also fixed in **12.0.3** and **10.9.4**.

### Security
- **Delegated calls are made for the original caller.** A call made with an agent delegation token
  (`POST /api/v1/features/agent-identity/call`), or by a feature module on behalf of a request (time-travel replays,
  debug sessions, adaptive retries, task graphs, plugin routes), now has one identity context: the **subject** is the
  original caller (the token's `sub`, the requesting client), the agent is the **actor**, and the effective scope is
  the caller's scope ∩ every delegation hop. Every module keys on the subject: client policy rules, tenant membership,
  quotas, budgets, data residency, per-tenant credential injection, the tool cache (`scope: client`) and the semantic
  cache (`scope: tenant` / `client`), metering, cost accounting and the audit record. Before, these modules saw the
  agent (`agent:<id>`) or a component label (`replay:…`, `debug:…`) instead of the caller.
- **Policy rules naming an agent only restrict.** Rules whose `clients` name an actor explicitly (`agent:<id>`,
  `agent:*`; a bare `*` does not count) still apply to that agent's calls, but only a `deny` or `approve` takes
  effect; an `allow` for the agent never lends the delegator access its own rules refuse.
- **Token identity keys include the issuer when several issuers are trusted.** `sub` is only unique per issuer. With
  more than one accepted issuer (`auth.oauth.issuer` / `authorizationServers`, `auth.jwt.issuer` as a list) client ids
  are now `oauth:<issuer>#<sub>` / `jwt:<issuer>#<sub>`; with a single issuer they stay `oauth:<sub>` / `jwt:<sub>`.
  In such a configuration an unqualified client pattern (`oauth:alice`, `jwt:user-*` in `tenants[].members`,
  `policy.rules[].clients`, `quotas.rules[].clients`, `costs.budgets[].clients`, `agentIdentity.agents[].delegators`)
  is now a **config error** naming the qualified form, instead of silently matching users of every issuer.

### Changed
- Agent API answers like the REST tool call: quota and budget refusals are **429** (with `Retry-After`), policy-layer
  refusals (residency, PII, approvals, plugins, failed security modules) **403**, timeouts **504** — before, everything
  except an authorizer refusal was 502. Failed calls carry `code` and `message` at the top level.
- Audit: request records of delegated calls carry `actor` (the executing agent, or the initiating component) and
  `chain` (`[caller, agent, sub-agent, …]`) in `GET /api/v1/requests`, the persistent audit log (new nullable columns
  `actor`, `chain`, added automatically to existing databases) and SIEM export events; `clientId` / `client` is the
  original caller. Records of direct calls are unchanged. Trace spans get `mcp.actor`.
- New module `auth/identity` (`identityOf`, `tokenClientId`, `issuerQualified`); `evaluateActorPolicy` in
  `policy/tool-policy`; `gateway/http-status` (status mapping shared by the REST surfaces).

### Upgrade notes
- Deployments with **one** token issuer (or API keys only) need no config change. Usage, cost and audit totals of
  delegated calls move from `agent:<id>` to the delegating client.
- Deployments with **several** trusted issuers: rewrite client patterns to `oauth:<issuer>#<sub>` (or `oauth:*`);
  `mcp-gateway validate` lists every pattern to change.

### Tests
- New `test/identity-13-1-2.test.ts` (written first; 13 of its 15 original cases failed on 13.1.1): two tenants
  sharing one agent (tool cache, semantic cache), delegator deny rules and agent allow rules, per-tenant and
  per-client quotas, tenant budgets and data residency for delegated vs direct calls, REST / MCP / agent API status
  and code parity, audit chain incl. sub-agents and the SQLite audit log / SIEM event, issuer-qualified ids for
  `oauth2` and `jwt` and the ambiguous-pattern config error.

## [13.1.1] - 2026-10-10

**Security patch.** Tightens two edges of 13.1.0 and fixes a cache key that let routing-split targets share entries.
Config schema stays **v11**; no config changes needed. Advisories: [SECURITY.md](SECURITY.md#security-advisories)
(MGW-2026-005, MGW-2026-006).

### Security
- **MGW-2026-005 (medium) — caches shared entries across routing-split targets.** The tool cache (`cache.rules`) and
  the semantic cache (`semanticCache`) keyed entries on the requested server, but a `routing` split decides the real
  upstream after the cache lookup. A cached answer from variant A could be served to a caller the split sends to
  variant B, and — with `cache` `scope: shared` or a semantic cache scoped `tenant` / `global` — to a caller that is
  **not authorized on A** (bypassing the MGW-2026-001 final authorization of split targets). The split is now decided
  once per call and **authorized before any cache lookup**; both caches key on the routed target
  (`<server>><target>`), so split targets never share entries; the send uses that same decision. Also fixed in
  **12.0.2** and **10.9.3**.
- **MGW-2026-006 (low) — servers prepared by a hot reload were visible before the commit.** 13.1.0 connected brand-new
  servers in the Prepare phase straight into the registry, so for the duration of the reload (and until a failed reload
  disposed them) their tools, resources and prompts were listed and callable under the *previous* auth / routing
  config. Prepared servers are now **staged**: connected, but not listed (`tools/list`, `resources/*`, `prompts/*`,
  REST `/tools`, `/servers`), not routable (invoke, routing splits, rollouts, load balancer) and not exposed to the
  authorizer until the commit swaps them in; a failed reload disposes them without them ever being visible. Affected:
  13.1.0 only (12.x connected new servers after the config swap).

### Changed
- **Fail-closed is scoped (MGW-2026-002 follow-up).** A failed `closed` module now refuses only the tool calls it
  would have governed, read from its own config: `dlp.servers`, `sanitize.servers` minus `exempt`,
  `multimodal.servers`, `confidential.servers[].match`, `approvalFlows.flows[].tools` (+ `clients`; `when` ignored),
  `privacy.protect`, `realtimeBudgets.budgets[]` (`clients` / `tenants` / `tools`), `console.orgs` (tenants),
  `anomaly.exempt` (clients), `agentIdentity` (agent-token calls + `requireAgentFor`). A module whose scope cannot be
  determined — no restriction configured, a value that does not parse, `policyEngine`, plugins / unknown modules —
  keeps refusing every tool call (safe default). Error `-32026`, `data.decision: "module-failed"`, the `audit:` log
  line and `mcp_gateway_module_failure_denials_total` are unchanged. A hook or split that reroutes a call into a failed
  module's scope is refused by the final authorization (`-32026`, `decision: "reroute-denied"`,
  `reason: "module-failed"`).

### Tests
- New `test/security-13-1-1.test.ts`: failed DLP scoped to server A refuses A and serves B; global / unparseable scope
  refuses all; reroute into a failed scope; per-module scopes; staged registry; split / rollout to a staged server
  never sent; mid-reload calls and listings of a new server → not found, after commit → served, after a failed reload
  → never visible; tool and semantic cache entries per split target and split authorization before the lookup.
- De-flaked `orchestration-edge-10-7` ("reconcile parks a replay…"): the start-up reconcile pass (100 ms after the
  module activates) could land between the test's two manual reconciles on a slow (coverage) runner; the test now lets
  it run first.

## [13.1.0] - 2026-10-10

**Security release.** Fixes an authorization bypass when a call is rerouted (P0), makes failed security modules fail
closed (P0), keeps module failures per gateway (P1) and makes hot reload Prepare → Validate → Commit (P1). Config
schema stays **v11**. Advisories: [SECURITY.md](SECURITY.md#security-advisories) (MGW-2026-001 … 004).

### Security
- **MGW-2026-001 (high) — re-authorization after reroute.** The central authorizer ran once at the start of the call
  pipeline, but call hooks (`rollouts` stable → canary, `blue-green`, `self-healing` fallback / rollback,
  `realtime-budgets` downgrade) and `routing` splits could change the target server afterwards without a new check:
  a client allowed only on the stable server could reach the canary. The invoker now runs a **mandatory final
  authorization immediately before the upstream send, against the final target**: the central authorizer (client /
  tenant / delegation scope ∩ the server's tool exposure) always runs again; when the target changed, the tool policy
  rules (incl. approval holds), data residency and the `before` hooks of the security guard modules that had not seen
  the final target (DLP, agent identity, confidential computing, policy engine, privacy, sanitize, approval flows)
  are evaluated for the new target too. The authorized target (server, tool, kind, principal) is then frozen; the
  send refuses any call whose target differs from it. A refused reroute answers `-32003` with
  `data.decision: "reroute-denied"` (`from`, `to`, `reroutedBy`, `reason`), is recorded in history / the audit store
  and logged as an `audit:` line, and counts in `mcp_gateway_reroute_denials_total`. Also fixed in **12.0.1** and
  **10.9.2**.
- **MGW-2026-002 (high) — no fail-open for security modules.** 13.0 skipped the call hooks of a failed module, so a
  DLP / policy-engine / agent-identity module that failed to load or initialise silently stopped protecting calls.
  Every feature module now has a **failure policy** in the manifest (`failurePolicy: open | closed | degrade`):
  - `closed` — security and enforcement modules (`dlp`, `agent-identity`, `confidential`, `policy-engine`,
    `privacy`, `sanitize`, `approval-flows`, `anomaly`, `multimodal`) and the quota modules `console` and
    `realtime-budgets`: while the module is configured but failed, tool calls are refused with **`-32026`**
    (`data.decision: "module-failed"`, `modules`), audited, counted in `mcp_gateway_module_failure_denials_total`;
    the gateway itself keeps running;
  - `open` — analytics (`genai-otel`, `billing`, `cost-advisor`, `data-lineage`, `sla`, `time-travel`, `adaptive`,
    `policy-sim`, `chaos`, `semantic-cache`, `rollouts`): hooks skipped;
  - `degrade` — `offline`, `self-healing`, `blue-green`, `edge-autonomy`, `pq-identity`, `debug-sessions`: hooks
    skipped and results carry `_meta["mcp-gateway/degraded"]` (`mcp_gateway_degraded_calls_total`).
  A module that is not in the manifest (plugins, embedder modules) and registers a request-blocking hook defaults to
  `closed`. A module whose load failed before its hook registered is caught too. `kernel.failurePolicy` may override
  the policy of `console`, `realtime-budgets` and `billing` only; security modules are fixed (validation error).
  `GET /api/v1/admin/kernel` shows each module's `failurePolicy`.
- **MGW-2026-003 (medium) — module failures were process-wide.** The runtime failure registry was a process-global
  map, so a module that failed in one `Gateway` changed the hooks of every gateway in the process. Failures are now
  per kernel (`ModuleFailures`, owned by each gateway's feature router); the process keeps only the immutable manifest
  and the module load cache.
- **MGW-2026-004 (medium) — hot reload was not transactional for connections.** 12.0 disconnected and unregistered
  removed servers before loading modules / refreshing the catalog; a later failure restored config, auth and routing
  but not the closed connections. `Gateway.reload()` is now **Prepare → Validate → Commit**: the catalog, plugins and
  connections to new server ids are built aside, newly activated feature modules must load, then the config is swapped
  atomically; only after a successful commit are removed servers disconnected. A failure disposes what was prepared
  and the old servers keep serving. (12.0's CHANGELOG and migration guide called the old behaviour "transactional";
  that wording is corrected.)

### Changed
- `failureOf()` / `markRuntimeFailed()` / `clearRuntimeFailed()` (internal kernel-runtime exports) are replaced by
  `ModuleFailures` and `failureOf(id, failures?)`; `activeCallHooks(cfg, failure?)` takes the gateway's failure
  lookup; new `callHookPlan()`. `Catalog.refresh()` is now `prepare()` + `commit()`.
- `KernelModuleView.failurePolicy`; `FeatureRouter.failureOf(id)`.

### Notes
- 10.9.1 (2026-10-09, `lts/10.x`, npm `v10-lts`) backported the 11.1–12.0 authorization fixes to the 10.x LTS line;
  10.9.2 adds MGW-2026-001.

## [13.0.0] - 2026-10-09

**Breaking: true modular kernel.** Feature modules are evaluated only when they are enabled — a gateway that
configures no features evaluates **none** of the 47 modules (12.0: all 47). Config schema stays **v11** (no `migrate`
needed). Guide: [Migrating to 13.0](docs/guides/migrating-to-v13.md). 10.x stays LTS.

### Breaking
- Feature modules are loaded through an `import()` manifest (`src/features/manifest.ts`) when their `features.<section>`
  is configured (or on the first request for the always-available `kernel`, `conformance`, `k8s`, `terraform`,
  `policy-sim`; `policy-sim`'s shadow hook loads at start only when `policyShadow` is set). Code that relied on a
  module's import side effects without configuring it must configure it or set `kernel.modules: eager` (10.x
  behaviour: everything at start).
- Call-hook order is the manifest order (a `first` hook still runs first), no longer import order; `callHooks()` and
  `GET /admin/kernel` `hooks` list only hooks of evaluated modules.
- `createFeatureRouter()` returns a `FeatureRouter` with `activate()` / `reconcile(prev)` / `dispose()` /
  `modules()`; `sync()` is now async. `listFeatures()` lists every built-in module, evaluated or not.
- A module that fails to load or initialise no longer takes the gateway down: its routes answer **503**, its call
  hooks are skipped, modules depending on it fail too, and `GET /admin/kernel` shows `state: failed` with the error.
- `RELEASE_LINE` = `{ line: '13.x', lts: false }`.

### Added
- **Lean entry point `@winstonsayno/mcp-gateway/gateway`**: Gateway, config loading / validation, the authorizer,
  the kernel API and types — importing it evaluates no feature module (the package root still re-exports every
  module's helpers and therefore evaluates all of them).
- **Module lifecycle contract** (all optional on `FeatureModule`): `init(ctx)`, `reconfigure(next, prev, ctx)`,
  `disable(ctx)`, `dispose()`, `health()`. The kernel runs them in dependency order (`dispose` in reverse), isolates
  failures and reports per-module `state` / `evaluated` / `dependsOn` / `loadMs` / `error` / `health` plus the
  `evaluated` load order in `GET /admin/kernel`.
- **Declared dependencies**: cross-module edges are manifest `dependsOn` entries obtained with
  `requireDependency(from, dep)` — billing → genai-otel, sanitize → anomaly, edge-autonomy → edge-runtime + offline,
  task-graphs → a2a-federation. Undeclared use throws; cycles are rejected.
- Exports: `FEATURE_MANIFEST`, `manifestEntry`, `loadFeature`, `loadedFeatures`, `dependencyOrder`,
  `requireDependency`, types `FeatureRouter`, `KernelModuleView`, `ModuleHealth`, `FeatureManifestEntry`.

### Changed
- Every feature's config schema lives in `src/features/schemas/<id>.ts`; `src/config/loader.ts` imports only those,
  so validating a config never evaluates a module. `dlpStats` moved to `src/policy/dlp-stats.ts` and `policyFor` to
  the DLP schema, so the admin API and compliance reports no longer import the DLP module (both still re-exported).
- `undici` is required on first use (mTLS / post-quantum TLS upstreams only): ~95 fewer modules at start.
- `bench/kernel.mjs` imports the `./gateway` entry, counts only feature modules (not schemas / the manifest) and
  fails CI if a profile evaluates more modules than recorded. `bench/baseline.json` records 13.0 and the 12.0 run.
- Baselines in `bench/baseline.json` are keyed by platform (`platforms["linux-arm64"]`, `platforms["linux-x64"]` =
  GitHub Actions runners, recorded from the 13.0 CI runs); memory is only checked against a same-platform baseline.
  The CI benchmark step runs with `set -o pipefail`, so the guard is no longer masked by `tee`.
- Edge autonomy: `reconcile` runs are serialized — `POST /admin/edge-autonomy/reconcile` made while the background loop
  is replaying joins that run and returns its counts (it used to answer all zeros).
- CI / release builds no longer pull from Docker Hub (unauthenticated pull rate limits blocked releases): the
  Dockerfile base image (`ARG NODE_IMAGE`, default `public.ecr.aws/docker/library/node:22-alpine`, same tag and
  digest as `node:22-alpine`), the Redis service container, the Swift SDK container, BuildKit and QEMU binfmt come from
  the Amazon ECR Public mirror of the Docker Official Images.

### Benchmark (minimal profile, median of 3 interleaved runs × 5, same machine)
| | 12.0.0 | 13.0.0 |
|---|---:|---:|
| import | 918 ms | 658 ms (−28 %) |
| start | 16.7 ms | 21.9 ms |
| RSS | 60.2 MiB | 53.8 MiB |
| heap | 23.3 MiB | 19.5 MiB |
| feature modules evaluated | 47 / 47 | 0 / 47 |

### Unchanged
- The single, non-bypassable authorizer (`src/auth/authorizer.ts`) for every tool-call path and its static
  call-site test. Config schema v11. Modules cannot be unloaded from memory once evaluated (ES modules); `disable`
  unmounts them (404), stops their hooks and lets them release resources.

## [12.0.0] - 2026-10-09

**Breaking security release.** Third-party stdio MCP servers are isolated from the gateway core — environment
allowlist, optional uid/gid, working directory and sandbox wrapper with networking off — multimodal per-item limits
are lower, and a failed hot reload rolls back its config (not fully transactional, see 13.1.0). Config schema stays **v11** (no `migrate` needed). Guide:
[Migrating to 12.0](docs/guides/migrating-to-v12.md). 10.x stays LTS.

### Security
- **P1 — child-process environment inheritance too broad (credential exposure to third-party MCP servers).** stdio
  servers inherited the gateway's whole environment except `MCP_GATEWAY_*`, so `AWS_SECRET_ACCESS_KEY`,
  `OPENAI_API_KEY`, database URLs etc. reached every upstream server. 12.0 replaces the exclusion policy with an
  **allowlist**: `PATH`, `HOME`, `LANG`/`LANGUAGE`/`LC_*`, `TZ`, `TMPDIR`, `TERM` (+ `SystemRoot`, `ComSpec`, `PATHEXT`,
  `TEMP`/`TMP`, `USERPROFILE`, `APPDATA`, `LOCALAPPDATA`, `windir` on Windows), then `security.stdioEnvPassthrough`,
  the server's `envPassthrough`, then its explicit `env`. Credential-looking passthrough is flagged by the posture
  check (`stdio-secret-passthrough`).

### Breaking
- stdio environment allowlist (above). Servers that relied on inherited variables need `env` / `envPassthrough`.
- Multimodal defaults: `maxItemBytes` 10 MiB → 4 MiB, `maxTotalBytes` 32 MiB → 16 MiB.
- Hot reload rolls back on failure: a failure while applying a config (catalog, plugins, mTLS, …) restores the
  previous config (auth, routing, policy) and rejects the reload (`POST /admin/config` fails). *Correction (13.1):
  this was not fully transactional — servers removed by the new config were disconnected before the failure point
  and were not reconnected by the rollback (MGW-2026-004, fixed in 13.1.0).*
- `GET /admin/kernel` `line: 12.x`; `RELEASE_LINE` = `{ line: '12.x', lts: false }`.

### Added
- `servers[].isolation`: `uid` / `gid` (POSIX), `cwd`, `sandbox: { type: bubblewrap | firejail | container | custom,
  network: none | host, writable, readable, image, runtime, command }` — see
  [Isolating stdio MCP servers](docs/security/stdio-isolation.md). `servers[].envPassthrough`,
  `security.stdioEnvPassthrough`. Exports from `transport/isolation`: `childEnv`, `planSpawn`.
- `bench/kernel.mjs`: cold start time, RSS / heap and evaluated feature modules of the built gateway (module-load
  tracing); CI compares against the recorded `bench/baseline.json` (gross-regression guard only).
- CI tests: 500 concurrent tool calls (scoped + unscoped, exact 403 count), multimodal memory pressure
  (300 × 1 MiB, held bytes within budget), hot-reload rollback. `Gateway.rollbacks` counter.

### Not in 12.0
- Feature modules are still evaluated at startup (the config loader imports their schemas); on-demand `import()`
  loading with a module lifecycle lands in 13.0. Baseline: 47 / 47 feature modules evaluated, ~1.07 s import.

## [11.2.0] - 2026-10-09

**Security release.** Multimodal blobs are bound to their owner and capped by byte budgets, and agent-token
revocation is stored in the shared state store (Redis / SQLite / event log) with a fail-closed default.

### Security
- **P1 — multimodal blobs lacked caller-ownership checks (cross-client access).** Offloaded blobs recorded only
  server, tool, type and expiry, and `GET /api/v1/features/multimodal/blobs/:id` required only authentication — any
  client holding (or guessing from a leak) the id could read another client's or tenant's image/audio. Each blob is now
  bound to the owning principal, tenant and `server/tool`; reads are re-authorized through the central authorizer (same
  client, or same tenant with permission to call that tool) and answer `404` to everyone else. Ids are 192-bit random.
- **P1 — token revocation lived only in process memory.** A revoked agent token became valid again after a restart and
  was never revoked on other instances. Revocations and issued-token records now live in the shared state store with
  TTL = token expiry; `features.agentIdentity.revocation.failureMode` defaults to **closed** (store unreachable → agent
  calls, sub-token exchange and introspection answer `503`).
- **P2 — multimodal memory caps too high** (10 MiB × 256 blobs ≈ 2.5 GiB worst case). New global and per-tenant
  budgets for held blobs (`maxStoredBytes` 256 MiB, `maxTenantStoredBytes` 64 MiB) with expiry + LRU eviction; an
  item that cannot fit is refused / stripped. (The per-item default drops in 12.0.)

### Added
- `store.backend: sqlite` (`store.sqlite.path`): durable single-node state store on `node:sqlite`; export
  `SqliteStateStore`.
- Multimodal: `storage: { type: filesystem, dir }` (blobs shared between instances via a shared volume),
  `signedLinks: { key, ttlSeconds }` (HMAC links bound to owner + expiry), owner/tenant in the admin blob list,
  counters `evicted` / `overBudget` / `deniedReads` / `heldBytes`.
- Prometheus: `mcp_gateway_authz_denials_total`, `mcp_gateway_agent_revocation_checks_total`,
  `mcp_gateway_agent_revocation_store_errors_total`, `mcp_gateway_agent_store_unavailable_total{decision}`,
  `mcp_gateway_multimodal_held_bytes`, `…_evicted_total`, `…_over_budget_total`, `…_denied_reads_total`;
  `registerMetricSource()` for feature modules. Admin view `revocation: { store, failureMode, shared, … }`.
- Posture notice `agent-revocation-in-memory` when agent identity runs on the memory store.

### Changed
- `POST /admin/agent-identity/revoke` answers `{ revoked, known, shared }`; `503` when the revocation could not be
  persisted (it is still applied on this instance). `applyMultimodal(…, now, owner?)` takes the owner; blobs without an
  owner are readable by nobody.

## [11.1.0] - 2026-10-09

**Security release.** Every upstream call now passes through one non-bypassable authorization decision point, and
agent delegation can no longer exceed the delegating client's own permissions. Upgrade recommended for every
deployment that uses `features.agentIdentity` or scoped API keys / JWTs.

### Security
- **P0 — agent delegation could bypass the original client's permissions.** `POST /api/v1/features/agent-identity/token`
  minted tokens from the agent's `tools` + `delegators` without intersecting the delegating client's own `servers` /
  `tools` scopes or tenant role, and `…/call` ran the call through the pipeline without a client-scope check; a
  restricted key could obtain an agent token broader than itself. Fixed: tokens never grant more than the delegator may
  call (restricted delegators get concrete `server/tool` names), and every delegated call is authorized as
  *original caller's current scope ∩ tenant (incl. write role) ∩ token grant ∩ server tool filter ∩ policy*. API-key
  delegators are re-resolved on every call (removed key → nothing allowed); JWT/OAuth delegators use the scope snapshot
  taken at issuance (`dsc` claim). Tokens minted by ≤ 11.0 are bounded the same way at call time.
- **P1 — agent scope narrowing could widen the tool set.** `narrowScope()` tested an allowed glob against the requested
  *pattern string*; `vault/read?` matches the string `vault/read*`, which admits longer names. Narrowing is now strict:
  a requested entry is granted only when it is identical to an allowed pattern, a literal `server/tool` an allowed
  pattern matches, or — for any other glob — the concrete tools currently known that both patterns match (re-checked at
  call time by the central authorizer). Sub-agent tokens (`subjectToken`) use the same rule. Property-based fuzz tests.

### Added
- `src/auth/authorizer.ts`: `authorize(principal, call)` — the single authorization decision, called first by
  `ToolInvoker.invoke()` for REST, `/mcp`, OpenAI and A2A bridges, chains, task graphs, agent identity, plugins
  (routes and hooks), federation, edge autonomy, replays and the edge runtime. A call without a principal is refused
  (`-32003`, fail-closed). Exported: `authorize`, `clientPrincipal`, `systemPrincipal`, `deniedPrincipal`, `Principal`.
- `InvokeContext.principal` (required) and `HookCall.principal`; the audit span carries the delegation chain
  (`mcp.principal.chain`). Edge-autonomy outbox entries and task-graph runs record the principal that queued / started
  them and replay under it.

### Changed
- **Feature module SDK:** `FeatureContext.invoke(server, tool, args, principal, clientId?)` — `principal` is now
  required (`principalOf(req)`, `ctx.principalFor(clientId)` or `systemPrincipal(name)`); the 4th argument is no longer
  a client id. `ctx.principalFor` / `ctx.resolveScope` added.
- **Plugin route SDK:** `ctx.invoke(server, tool, args, caller?)` — pass `req` or a client id and that caller's scope
  applies; without a caller the call runs as `system:plugin:<name>`. Previously client scopes were not applied.
- The server tool filter (`servers[].tools`) is enforced centrally for every caller (previously only on REST / `/mcp`).

## [11.0.0] - 2026-10-09

**Breaking release.** Config schema v11 is the only schema, the modular kernel loads feature modules lazily, and the
10.x deprecations are removed. A config that 10.9 loads without deprecation warnings runs unchanged; otherwise run
`npx @winstonsayno/mcp-gateway@10.9 migrate --write` (or `@11 migrate --write`). Guide:
[Migrating to 11.0](docs/guides/migrating-to-v11.md). 10.x stays LTS (fixes until 2027-10-31, security until 2028-10-31).

### Breaking
- **Schema v11 only**: `version: 10` is a validation error naming `mcp-gateway migrate --to 11`; a file without
  `version` is read as v11. Older versions (4 – 9) point at `version: 11` and `migrate --to 11`.
- **Lazy modules by default** (`kernel.modules: lazy`): a feature module (admin / client routes, timers, call hooks)
  is mounted only while its `features.*` section is configured; others answer `404` (after authentication) naming
  the section. Modules that worked without a section (e.g. session recordings next to `replay.enabled`) need one —
  `features: { sessions: {} }`. `kernel: { modules: eager }` restores the 10.x behaviour. Also applies to embedded
  `new Gateway(config)`.
- **Workflow engine removed** (6.2, deprecated in 10.9): `features.workflows`, `/api/v1/admin/workflows*`, the
  `workflows` feature module and the root exports `WorkflowsSchema`, `runWorkflow`, `WorkflowRuns`, `WorkflowsConfig`,
  `WorkflowRun`, `NodeRun`. Use task graphs (`features.taskGraphs`); `migrate --to 11` converts workflows.
  `topoLayers` stays exported (from the task-graph module).
- `GatewayConfig.version` is `11`; data planes always receive `version: 11`; no config deprecations remain.

### Changed
- `GET /api/v1/admin/kernel`: `schema: 11`, new `line` (`11.x`, not LTS), `moduleMode` and per-module `active`;
  `lts` keeps describing the 10.x window. `CONFIG_SCHEMA_VERSION` = 11; new export `RELEASE_LINE`.
- Helm chart 11.0.0 (`appVersion` 11.0.0, `config.version: 11`). Container tags `11`, `11.0`, `11.0.0` and `latest`
  move to 11.0.0; `10` stays on the last 10.x release.
- SECURITY.md / README: 11.x current, 10.x LTS dates unchanged; README refreshed for 11.0.

## [10.9.0] - 2026-10-09

Bridge release to 11.0: **config schema v11** and the **lazy modular kernel** are available now, and everything 11.0
removes is deprecated. No behaviour change for existing `version: 10` configs apart from the deprecation warnings.
Guide: [Migrating to 11.0](docs/guides/migrating-to-v11.md).

### Added
- **Config schema v11** (`version: 11`): same layout as v10 without `features.workflows`. 10.9 reads v10 and v11.
- **`kernel.modules: eager | lazy`** (hot reload): in `lazy` mode only feature modules whose `features.*` section is
  configured are mounted — routes, timers and call hooks; unconfigured modules answer `404` naming the section, and a
  section added by hot reload mounts its module. Default: `lazy` on schema v11, `eager` on v10 (10.x behaviour).
  `GET /api/v1/admin/features` reports `modules` and each module's `active` flag.
- **`mcp-gateway migrate --to 11`** (now the default target): sets `version: 11`, converts each `features.workflows`
  entry into a `features.taskGraphs` graph (same nodes; retry keeps doubling backoff), keeps comments, and notes the
  API / identity / activation changes. Idempotent; `--check` for CI.

### Deprecated (removed in 11.0)
- `config-schema-v10`: `version: 10` or no `version` — use `version: 11`.
- `features-workflows`: `features.workflows` and `/api/v1/admin/workflows` — use task graphs (10.7).

### Changed
- `mcp-gateway init`, the desktop config, examples, Helm chart values and docs now use `version: 11`.
- Data planes receive the control plane's schema version (10 or 11).

## [10.8.0] - 2026-10-09

Last release of the 10.5 – 10.8 feature line: **privacy computing** and **post-quantum identity**, both EXPERIMENTAL
and opt-in. Config schema v10 is unchanged apart from the new optional `features.privacy` and `features.pqIdentity`
sections and the optional `pluginTrust.requirePostQuantum` / `pluginTrust.keys[].mldsa` fields.

### Added
- **Privacy computing** (`features.privacy`, EXPERIMENTAL, [guide](docs/guides/privacy.md)): `protect` globs make
  tools answer only differentially private aggregates — direct calls are refused (`403` / `-32003`).
  `POST /api/v1/features/privacy/aggregate` runs the tool as the caller, clamps a field to caller-given bounds and
  returns a Laplace-noised `count`, `sum`, `mean` or `histogram` (cryptographic RNG; noise scale = sensitivity / ε);
  ε is charged to a per-client budget per window (`429` when exhausted). `POST /api/v1/features/privacy/federated`
  aggregates in each domain — locally or on a peer gateway — and combines only the noisy partial results.
- **Post-quantum identity** (`features.pqIdentity`, EXPERIMENTAL, [guide](docs/guides/pq-identity.md)): Ed25519 +
  ML-DSA-44/65/87 (FIPS 204) hybrid signatures (both must verify) for a signed gateway identity document, a signed
  tool manifest (per key scope), and a hash-chained audit log of every tool call (incl. refused ones) with signed
  checkpoints and a verifier that reports modified entries, gaps and forged checkpoints. Plugin artifacts:
  `pluginTrust.keys[].mldsa` requires hybrid signatures, `pluginTrust.requirePostQuantum` refuses classical-only ones;
  `mcp-gateway plugin sign --pq-key`. New CLI `mcp-gateway pq keygen | info`.
- ML-DSA runs on `node:crypto` when the runtime implements it (Node 24.7+ / OpenSSL 3.5; enabled only after a
  start-up interoperability self-test), otherwise on the new pinned dependency `@noble/post-quantum` 0.7.1 (pure JS;
  not independently audited).

### Not provided
- No X.509 hybrid certificates (the identity document is signed JSON), no key rotation / revocation, no HSM keys.
- DP guarantees assume one row per person and data-independent bounds; floating-point Laplace sampling is not snapped.

## [10.7.0] - 2026-10-09

Third release of the 10.5 – 10.8 feature line: **multi-agent orchestration 2.0** (durable, cross-gateway task graphs)
and **edge autonomy** (EXPERIMENTAL). Both are opt-in under `features:`; config schema v10 is unchanged apart from the
new optional `features.taskGraphs` and `features.edgeAutonomy` sections.

### Added
- **Task graphs** (`features.taskGraphs`, [guide](docs/guides/task-graphs.md)): DAGs whose nodes call a local tool
  (full pipeline) or hand an A2A task to an agent behind another gateway (`remote: { gateway, skill }` via
  `features.a2aFederation`); per-node retry with capped exponential backoff and optional full jitter, per-attempt
  `timeoutMs`, `if`, `onError`; **checkpoints** written atomically after every state change (`dir`); runs in flight
  at shutdown load as `interrupted`; **resume** continues from the checkpoint without re-executing succeeded nodes;
  **saga compensation** (`compensate: { tool, args }`, `{{self.*}}` = the node's output) runs in reverse completion
  order when a run fails or is cancelled. Admin API `/api/v1/admin/task-graphs` (`/run`, `/runs`,
  `/runs/:id/resume`, `/runs/:id/cancel`). Delivery is at-least-once — make node tools idempotent.
- **Edge autonomy** (`features.edgeAutonomy`, EXPERIMENTAL, [guide](docs/guides/edge-autonomy.md)): while an
  upstream is unreachable (health registry, `features.offline`, operator override, or a not-connected / timeout
  failure) matching calls are answered from the last good result for the same arguments (`cache`), by a local
  `features.edgeRuntime` WASM tool (`wasm`), accepted into a persisted outbox with a receipt (`queue`) or refused
  (`deny`, `-32018`) — always after local policy. The outbox is replayed through the full pipeline on reconnect (as
  the original client, optional idempotency key argument); replays that keep failing become `conflict`s for an
  operator. Admin API `/api/v1/admin/edge-autonomy`. Listed in the EXPERIMENTAL notices of `validate`, startup and
  `GET /api/v1/security`.
- `registerCallHook(hook, { first: true })` places a hook ahead of the others.

## [10.6.0] - 2026-10-09

Second release of the 10.5 – 10.8 feature line: **full-chain replay / time-travel debugging** and **real-time cost and
carbon budgets**. Both are opt-in under `features:`; config schema v10 is unchanged apart from the new optional
`features.timeTravel` and `features.realtimeBudgets` sections.

### Added
- **Time-travel journal** (`features.timeTravel`, [guide](docs/guides/time-travel.md)): an append-only journal of
  applied configurations (redacted, content-hashed) and tool calls — including refused ones — in memory and optionally
  as daily JSONL files with retention. Admin API `/api/v1/admin/time-travel`: state at any instant (`/state?at=`),
  call search (`/calls`), an agent's call chain around a call (`/chain/:id`), configuration diff between two instants
  (`/config-diff`) and **replay** (`POST /replay`): the `policy.rules` decision then vs now for each journaled call,
  and with `execute: true` a re-execution through the full pipeline with a diff against the recorded result.
- **Real-time budgets** (`features.realtimeBudgets`, [guide](docs/guides/realtime-budgets.md)): sliding-window
  budgets per client / tenant / global on `cost` (priced with the `costs` table) or `carbon` (an **estimate** in
  gCO2e from configurable energy-per-call / per-token factors × grid intensity — not a measurement). Alerts at
  `warnAt` fractions (log, webhook, `GET /admin/realtime-budgets/alerts`); at the limit `reject`, `downgrade`
  (override arguments such as `model` and / or reroute to a cheaper server) or `warn`. `POST /estimate` prices a call.
- Call hooks can observe refused calls (`refused` callback, 10.6), used by the journal.

### Changed
- Budget refusals on REST now answer **`429 Too Many Requests`** with `Retry-After` and a `budget` object, for both
  real-time budgets and the calendar budgets of `costs.budgets` (`action: block`), which previously surfaced as `502
  Tool Execution Failed`. The JSON-RPC error on `/mcp` is unchanged: code `-32013` with `data.decision: "budget"`.

### Notes
- Both features keep state per process (in memory); with several replicas each enforces / journals its own traffic.

## [10.5.0] - 2026-10-09

First release of the 10.5 – 10.8 feature line: the **kernel plugin SDK** and **policy-as-code 2.0**. Both are
opt-in and backward compatible — config schema v10 is unchanged apart from the new optional `features.policyEngine`
section and `plugins[].timeoutMs`.

### Added
- **Kernel plugin SDK** ([guide](docs/guides/plugin-sdk.md)): plugins can now declare
  - `configSchema` — a zod schema or a validator function for `plugins[].options`, checked at load (invalid options
    refuse the plugin, so startup / hot reload fails instead of misbehaving later);
  - `routes.admin` / `routes.client` — Express routers mounted like built-in feature modules at
    `/api/v1/admin/plugins/<name>` (operators) and `/api/v1/features/plugins/<name>` (any authenticated client), with
    a context offering the parsed options, the plugin's state store, the tool list, `invoke()` through the full
    pipeline and the caller's client id; rebuilt on every plugin hot reload;
  - `plugins[].timeoutMs` — time limit per `onToolCall` / `onResponse` for module plugins (fails closed, `-32006`).
  - `definePlugin()` typed helper and `validatePluginOptions()` exported from the package.
- **Policy-as-code 2.0** (`features.policyEngine`, [guide](docs/guides/policy-engine.md)):
  - **Cedar** policies (inline `cedar` and `cedarFiles`) evaluated in-process by a built-in parser / evaluator for a
    documented Cedar subset (scopes with `==` / `in` / `is`, `when` / `unless`, `like`, `has`, sets, records,
    `if-then-else`, `contains*`; extension functions and templates are rejected at validation). Cedar semantics:
    default deny, forbid overrides permit, erroring policies do not apply. Request model: `Client::"<id>"` in
    `Tenant::"<t>"`, `Action::"callTool"`, `Tool::"<server>/<tool>"` in `Server::"<server>"`, `context.args` etc.
  - **Rego via OPA**: the gateway queries an OPA server's data API (`POST /v1/data/<path>`), with timeout and
    `onError: deny | allow`. Rego itself is evaluated by OPA, not by the gateway.
  - `mode: shadow` (record would-be denials, never block), policy unit tests (`tests:`; run by
    `mcp-gateway policy test`, `POST /admin/policy-engine/test`), `POST /admin/policy-engine/evaluate`, and
    `POST /admin/policy-engine/impact` — replays captured calls (or recent metrics, or given calls) under the
    current and a candidate Cedar policy set and lists every changed decision.
  - Runs after `policy.rules`; both must allow. Denials use the policy error code (`403` / `-32003`).

### Fixed
- Docker image workflow: the post-release Trivy scan used the mixed-case `github.repository_owner` in the image
  reference (invalid), so the 10.4.0 run ended in failure after the image had been pushed, signed and verified. The
  reference is now lowercased.

## [10.4.0] - 2026-10-09

Supply chain and incident response — the last hardening release of the 10.1 → 10.4 series. No new features and no
runtime behaviour change.

### Security
- **Container images are signed with cosign keyless** (Sigstore; identity = this repository's `docker.yml` workflow,
  issuer `https://token.actions.githubusercontent.com`), by digest, and the signature is verified in the same run.
  BuildKit SLSA provenance and SBOM attestations stay on.
- **Trivy** in CI on every pull request (new *Supply chain* job): filesystem scan of all lockfiles (blocking on fixable
  HIGH / CRITICAL) and a scan of the freshly built image (blocking on fixable CRITICAL; fixable HIGH printed — today
  they come from the npm CLI bundled in the `node:22-alpine` base image). After each release the published image is
  scanned again and the report uploaded to code scanning.
- Container smoke test in CI: the image must refuse to start without auth and answer `401` / `200` with
  `MCP_GATEWAY_API_KEYS`.
- **SBOMs**: CycloneDX 1.5 and SPDX 2.3 (`npm sbom --omit dev`) plus `SHA256SUMS` are attached to every GitHub
  Release next to the npm tarball; CI checks that SBOM generation works.
- **Dependabot** now also covers the Python client (pip) and the Go client (gomod), in addition to npm (gateway and
  JS client), Gradle, GitHub Actions and the Docker base image.

### Documentation
- New [docs/security/supply-chain.md](docs/security/supply-chain.md): what each artifact carries, `cosign verify`,
  BuildKit attestation inspection, checking the npm tarball against the release checksums, scanning, known gaps
  (no npm provenance for the main package while it is published outside CI).
- New [docs/security/incident-response.md](docs/security/incident-response.md): reporting, triage targets by
  severity, fix / disclosure process, compromised-artifact playbook (npm deprecate, GHCR re-tag, credential
  rotation) and an operator checklist.
- SECURITY.md links both; README mentions signed images.
- ROADMAP: 10.x hardening complete; the feature line is mapped to 10.5 – 10.8 (plugin SDK + policy-as-code 2.0;
  replay / time travel + cost & carbon budgets; multi-agent orchestration 2.0 + edge autonomy; privacy computing +
  post-quantum identity, the latter three EXPERIMENTAL).

## [10.3.0] - 2026-10-09

Honest labelling and secure defaults. No new features. **One behaviour change inside the 10.x LTS line**, made as a
security default — see *Upgrade notes*.

### Upgrade notes (behaviour change)
- **A gateway without authentication now refuses to start on a non-loopback address.** Before 10.3, `auth.strategy:
  none` with `host: 0.0.0.0` (the schema default when `host` is omitted) started with a warning; anyone who could
  reach the port could call every tool and the admin API. `start` (and hot reload) now exit with
  `Refusing to start: authentication is disabled while listening on 0.0.0.0, …`. To migrate, do one of:
  1. turn auth on — `MCP_GATEWAY_API_KEYS=<key>` (or `sha256:` digests from `mcp-gateway gen-key`), or an `auth:`
     block (`api-key`, `jwt`, `oauth2`);
  2. bind to loopback — `host: 127.0.0.1`;
  3. only on a trusted network, opt out explicitly — `mcp-gateway start --insecure` or `security.insecure: true`
     (a warning is logged at every start).
  Data planes (`controlPlane.role: data`) are exempt; they take auth from the control plane. Docker: `docker run`
  without a config or `MCP_GATEWAY_API_KEYS` now exits instead of serving an open gateway — pass
  `-e MCP_GATEWAY_API_KEYS=…`.
- **Helm chart 10.3.0 requires an API key.** `helm install` / `helm template` / `helm upgrade` fail at render time
  with `mcp-gateway: an API key is required (chart >= 10.3.0) …` unless `existingSecret` (a Secret containing
  `MCP_GATEWAY_API_KEYS`, recommended), `apiKeys` (new: chart-managed Secret) or `config.auth` is set. Releases that
  ran without a key must add one on upgrade, or keep the old behaviour explicitly with `--set security.insecure=true`
  (the gateway starts with `--insecure` and the install NOTES print a warning).
- Why inside an LTS line: the old default exposed every upstream tool to the network without credentials. The
  config schema stays v10 and every config that has auth, or binds to loopback, behaves exactly as in 10.2.

### Security
- Refuse to start / reload without auth on a non-loopback bind address unless `--insecure` / `security.insecure`
  (new optional schema key; `validate` explains the refusal in its `auth-disabled-public-bind` warning).
- `mcp-gateway init` writes `host: 127.0.0.1` instead of `0.0.0.0`.
- Helm chart: fail-fast auth check, `apiKeys` value (chart-managed Secret with an `api-keys-hash` pod annotation so
  a key change rolls the pods), `security.insecure` opt-out passed as `--insecure`, new `NOTES.txt` (loud warning
  when running without auth), new chart README; chart version / appVersion 10.3.0.

### Changed
- **TEE attestation (`features.confidential`) and post-quantum TLS (`features.postQuantumTls`) are labelled
  EXPERIMENTAL** at startup (logged as `Experimental: …`), in `validate` and in `GET /api/v1/security`, each stating
  what is verified and what is not (no native SEV-SNP / TDX / Nitro / SGX evidence or vendor chains, no TLS channel
  binding; PQ groups only on upstream HTTPS, not the gateway's own listener or WebSocket upstreams).
- CI: `validate --strict` on the `init` output and on every `examples/*/mcp-gateway.yml`; the Helm workflow asserts
  that default values fail with the API-key message and renders the configured cases (existing Secret, `apiKeys`,
  JWT config, `--insecure`, all optional resources).
- Examples bind `127.0.0.1` where they have no auth.

### Documentation
- README: new sections **Use with any LLM** (OpenAI, DeepSeek, xAI Grok via OpenAI-compatible function calling with
  `GET /api/v1/tools?format=openai|openai-responses`, Anthropic Claude via `format=anthropic`, executed with
  `POST /api/v1/tools/call`; the OpenAI-compatible bridge as an in-gateway alternative) and **Use from web pages and
  apps** (REST and the JS / Kotlin / Swift / Python / Go clients; no long-lived keys in bundles — backend proxy or
  short-lived scoped JWTs with `requireExp`, `maxTokenAgeSeconds`, `mcp_servers` / `mcp_tools`, plus
  `cors.origins` / `mcp.allowedOrigins` / `security.allowedHosts`).
- New runnable example `examples/llm-tools` (OpenAI SDK loop; switch provider with `LLM_BASE_URL`). Only the
  gateway side and a local OpenAI-compatible mock were exercised — no provider was called.
- Kubernetes guide, deployment guide and security checklist describe the API-key requirement; package description
  and keywords broadened; Chinese README pitch updated.

## [10.2.0] - 2026-10-09

Test-depth release — property / fuzz tests, an admin authorization matrix and regression tests, plus the fixes they
found. No new features.

### Security
- **Replica secrets leaked through `GET /api/v1/servers`.** Any authenticated client (not only operators) received
  `servers[].replicas[]` with their URL credentials / query tokens, `headers` (e.g. `Authorization`), `env` and `args`
  unredacted. Replicas are now redacted like the primary server.
- **Drive-by / DNS-rebinding requests against a local gateway without auth.** A gateway bound to a loopback address
  with `auth.strategy: none` accepted any `Host` and answered CORS with `*`, so a web page — directly or through DNS
  rebinding — could call tools and admin endpoints through the user's browser (simple cross-site POSTs need no
  preflight). In that setup `security.dnsRebindingProtection` is now **on by default**: the `Host` must be a loopback
  name (or `allowedHosts`), CORS defaults to loopback origins, `/mcp` accepts only same-origin / loopback / listed
  origins and state-changing requests carrying a foreign `Origin` get `403`. Gateways with auth, or bound to other
  addresses, are unchanged. Set `security.dnsRebindingProtection: false` (or `cors.origins`) to opt out.
- `GET /api/v1/admin/config` returned server URLs containing `user:pass@` or secret query parameters verbatim; they are
  now `<redacted>` and restored on `PUT`.
- Redaction (logs, request / audit log, API output) returned values nested deeper than 20 levels unredacted; they are
  masked now.

### Fixed
- Config validation crashed with `TypeError: … forEach is not a function` for a non-array `servers`, `plugins` or
  `auth.apiKeys` (e.g. `servers: {}` in YAML); these are reported as validation errors now.

### Added
- Property / fuzz tests with fast-check (`test/property.test.ts`): config parsing (zod + YAML, alias bombs), JSON-RPC
  framing (stdio line splitting, `/mcp` bodies never 5xx), tool-argument size limits (UTF-8 bytes), JWT / bearer
  parsing (forged / `alg: none` / malformed tokens always 401), scope claims, Host and SAN parsing. `FC_RUNS` raises
  the run count.
- Admin authorization matrix (`test/admin-auth-matrix.test.ts`): every mounted `/api/v1/admin/*` route (enumerated
  from the router) × no credentials / invalid key / server- or tool-scoped key / tenant owner / cross-tenant owner
  must answer 401 / 403.
- Regression tests for DNS rebinding, Host / Origin bypass, oversized and gzip-bomb bodies, chunked uploads and
  redaction leaks (`test/regressions-10-2.test.ts`).
- Threat model: 10.2 audit log.

### Upgrade notes
- A loopback-bound gateway without auth now rejects requests whose `Host` is not `localhost` / `127.0.0.1` / `[::1]`
  and browser requests from non-loopback origins. Browser apps on other origins: list them in `cors.origins`, enable
  auth, or set `security.dnsRebindingProtection: false`.

## [10.1.0] - 2026-10-09

Security baseline release — hardening, tests and docs only, no new features.

### Security
- **stdio upstreams no longer inherit the gateway's own secrets.** Child processes received the full gateway
  environment, including `MCP_GATEWAY_API_KEYS`, `MCP_GATEWAY_ADMIN_KEY` and `MCP_GATEWAY_REDIS_URL`, so any
  third-party MCP server could read the admin key. Every `MCP_GATEWAY_*` variable is now dropped from the child
  environment; a server that really needs one passes it explicitly in its `env` (e.g. `MCP_GATEWAY_URL: ${MCP_GATEWAY_URL}`).
  Commands are spawned with an argument array and `shell: false` (pinned by a regression test: `$(…)` / backticks
  reach the child verbatim).
- **Tenant owners can no longer enrol operators or wildcard members.** `PUT /api/v1/tenants/:id/members` let a
  non-operator owner add a glob (`*`, `key:*`) or an operator's exact client id; membership confines a client to the
  tenant's servers, so an owner could strip operators of admin access or pull other tenants' clients into their
  tenant. Owners now grant exact, non-operator client ids only (403 otherwise); operators keep glob support.
- **mTLS fails closed.** When `mtls.identity` was configured but could not be loaded, upstream connections went ahead
  without the client certificate and verified the peer against the system CA store instead of the trust bundle. They
  are now refused until the identity loads.
- **SPIFFE peer identity parsing.** The certificate SAN was split naively on `, `, so a single JSON-quoted URI value
  could smuggle a second `spiffe://` entry. SANs are parsed quote-aware, and a peer certificate must carry exactly one
  SPIFFE ID (X509-SVID spec).
- **OAuth audience warning.** Without `auth.oauth.resource` (or `audience`) the expected token audience follows the
  request `Host` header; the gateway now warns at startup. Set `resource` (and `security.allowedHosts`).
- Dev dependencies: vitest 1.6 → 4.1 (vitest / vite / tinypool / esbuild advisories: GHSA-5xrq-8626-4rwp,
  GHSA-5gmw-xhrv-c9v3, GHSA-85c8-ppgw-ccpr, GHSA-4w7w-66w2-5vf9, GHSA-67mh-4wv8-2f99). Runtime dependencies had no
  known vulnerabilities; `npm audit` is now clean.

### Added
- [docs/security/threat-model.md](docs/security/threat-model.md): assets, data flow, trust boundaries, STRIDE summary,
  known limitations and the 10.1 audit log.
- CI: CodeQL (`security-extended`) and OpenSSF Scorecard workflows; `npm audit --audit-level=high` is a blocking CI step.

### Changed
- Roadmap: 10.1 → 10.4 are security-hardening releases; the planned features move after them.

## [10.0.0] - 2026-10-09

### Breaking
- **Config schema v10 only.** `version: 9` is refused with a hint to run `mcp-gateway migrate --to 10` (9.9 reads both).
- **Feature sections live under `features`.** Every section owned by a feature module (`chaos`, `sla`, `dlp`,
  `sessions`, `rollouts`, `selfHealing`, `postQuantumTls`, `ecosystem`, …) is configured as `features: { … }`; the same
  keys at the top level are validation errors. Core sections (`servers`, `auth`, `policy`, `store`, `controlPlane`,
  `mtls`, …) are unchanged. `GatewayConfig` keeps the sections top-level internally (no code changes for embedders).
- Data planes always receive `version: 10`; `GET /api/v1/admin/config` always returns `features`.

### Added
- **Unified gateway kernel**: `GET /api/v1/admin/kernel` describes the running gateway in one view — config schema
  version, every feature module and its mount point, the call-hook pipeline in execution order and which `features.*`
  sections are configured. `CONFIG_SCHEMA_VERSION`, `LTS` and `ltsStatus()` are exported.
- **Long-term support**: 10.x is the first LTS line — active support until 2027-10-31, security fixes until
  2028-10-31; schema v10 stays stable across 10.x. See [SECURITY.md](SECURITY.md) and [docs/ROADMAP.md](docs/ROADMAP.md).
- New roadmap for 10.1 → 11.0 (in Chinese) in [docs/ROADMAP.md](docs/ROADMAP.md).
- Pages demo: kernel view; demo config on schema v10.

### Changed
- Nothing is deprecated in 10.0 (`DEPRECATIONS` is empty).
- Examples, Helm values, the default config and every guide use schema v10 (`features:`).

### Fixed
- `SECURITY.md` supported-versions table still listed 1.2.x as the supported line; it now lists 10.x (LTS).
- `mcp-gateway desktop` (`desktopConfig()`) wrote `version: 9` with a top-level `offline` section — now schema v10
  (`features: { offline }`).
- Console org writes, `rollouts … ?persist=true` and compliance bundles (`config.redacted.json`) read and wrote their
  sections at the top level of the schema-form config; with schema v10 they use `features.console`,
  `features.rollouts` and drop `features.complianceReports` (new `featureSection()` / `withFeatureSection()` helpers).
- Dashboard config editor: the raw-JSON label said "schema v4" and the read-only hint named `admin.configApi`
  (now "schema v10" and `controlPlane.configApi`).
- Helm `values.yaml`, `docs/guides/kubernetes.md`, the examples and every guide still used schema v9.

See [docs/guides/migrating-to-v10.md](docs/guides/migrating-to-v10.md).

## [9.9.0] - 2026-10-09

### Added
- **Config schema v10 preview**: `version: 10` with every feature-module section nested under `features: { … }`
  (`chaos`, `sla`, `dlp`, `sessions`, …). 9.9 reads both schema v9 and v10; unknown `features` keys are refused.
- **`mcp-gateway migrate --to 10`** (new default): `version: 10` and top-level feature sections → `features` (YAML
  pairs are moved, so comments travel with them).
- `GET /api/v1/admin/config` returns `features` for v10 files; data planes receive the control plane's schema version.
- Pages demo: the demo config reports the `schema-v9` deprecation.
- [Migrating to 10.0](docs/guides/migrating-to-v10.md).

### Deprecated (removed in 10.0)
- Config schema v9 (`schema-v9`) → `version: 10`.
- Top-level feature sections (`top-level-features`) → `features: { … }`.

### Fixed
- `docs/configuration.md` still described `version` as `8` (or the deprecated `7`).
- `test/v6.test.ts` validated `version: 9` with a top-level `dlp` section and expected no deprecations; now uses schema v10
  (`features: { dlp }`).

## [9.8.0] - 2026-10-09

### Added
- **Ecosystem marketplace GA** (`ecosystem`): a moderated catalogue of plugins, tools and WASM tools. Clients submit
  listings (`POST /api/v1/features/ecosystem/submissions`) into a review queue; operators approve or reject them with a
  reason (`POST /api/v1/admin/ecosystem/listings/:id/approve|reject`). Approved listings appear in
  `GET /api/v1/features/ecosystem/catalog` (search, `kind`, `tag`; verified publishers and better ratings first) with
  ratings and reviews (one per client, 1–5 stars; operators can hide reviews). Publishers are verified through
  `https://<domain>/.well-known/mcp-gateway-publisher.json` (publisher id + key ids); `autoApproveVerified` skips the
  queue for them. Optional `file` persistence. [Guide](docs/guides/ecosystem.md).
- Pages demo: marketplace review queue and publishers.

## [9.7.0] - 2026-10-09

### Added
- **Post-quantum TLS** (`postQuantumTls`): upstream HTTPS connections (streamable HTTP / SSE, with or without mTLS)
  offer the hybrid post-quantum group **X25519MLKEM768** (ML-KEM, FIPS 203) first — `mode: prefer` keeps classical
  fallback (`classicalGroups`), `mode: require` never downgrades. `POST /api/v1/admin/pq-tls/probe` handshakes every
  matching upstream with PQ groups only and classically and checks its certificate against `certificatePolicy`
  (allowed key types incl. `ml-dsa`, `minRsaBits`, `maxValidityDays`, `rejectSha1`, expiry);
  `GET /api/v1/admin/pq-tls` reports support (OpenSSL 3.5+), effective groups and the last probes.
  [Guide](docs/guides/pq-tls.md).
- Pages demo: post-quantum TLS status.

### Changed
- `security/mtls`: upstream connections take the key-exchange groups from `postQuantumTls` (`setUpstreamTlsGroups`).

### Fixed
- README / CHANGELOG linked the 9.3 TEE guide as `docs/guides/confidential-computing.md`; the guide is
  [docs/guides/confidential.md](docs/guides/confidential.md).

## [9.6.0] - 2026-10-09

### Added
- **Self-healing** (`selfHealing`): rules watch each upstream's error rate and p95 latency over a sliding window
  (`windowSeconds`, `minCalls`) and act on their own — `eject` (refuse with JSON-RPC **-32025** or fail over to
  `fallback`), `rollback` (route to `rollbackTo`, e.g. canary → stable) or `throttle` (`maxPerSecond`) — lifted after
  `cooldownSeconds` (re-trips if still unhealthy). `GET /api/v1/admin/self-healing` shows active actions, window stats
  and history; `POST …/:id/trigger` / `…/:id/clear` for operators. [Guide](docs/guides/self-healing.md).
- Pages demo: self-healing actions.

## [9.5.0] - 2026-10-09

### Added
- **SLA monitoring & credit reports** (`sla`): availability and p95-latency objectives per target (server and tenant
  globs, rolling `windowDays`), measured on every tool call in hourly buckets (bounded memory, log-scale latency
  histogram). `GET /api/v1/admin/sla` reports calls, availability, p95, error budget, `met` and breaches; credit tiers
  (`credits: [{ below, percent }]`, `monthlyFee`, `currency`) turn breaches into service credits;
  `GET /api/v1/admin/sla/report?format=json|csv` exports the credit report per target and tenant.
  `excludeErrorCodes` keeps client-caused refusals out of the numbers. [Guide](docs/guides/sla.md).
- Pages demo: SLA targets.

## [9.4.0] - 2026-10-09

### Added
- **Global tool registry** (`toolRegistry`): publish signed tool manifests (`publisher`, `name`, semver `version`,
  `tools`, `server`) verified against `trustedPublishers` (Ed25519 / ECDSA / RSA); versions are immutable. Search
  (`GET /api/v1/admin/tool-registry?q=`), version history, `…/:publisher/:name/resolve?range=` with ranges (`^`, `~`,
  `1.2.x`, `>=`, `*`) and configured `pins`. Every gateway serves its registry at
  `/api/v1/features/tool-registry/index.json`; `mirrors` pull other registries on a schedule (or
  `POST …/tool-registry/sync`) and re-verify every signature. Optional `file` persistence.
  [Guide](docs/guides/tool-registry.md).
- Pages demo: tool registry.

## [9.3.0] - 2026-10-09

### Added
- **Confidential computing / TEE** (`confidential`): servers matched by `confidential.servers[].match` get calls only
  after remote attestation — a signed report (`platform` sev-snp / tdx / nitro / sgx, launch `measurement`, a
  single-use gateway `nonce`, `issuedAt`, `debug`) verified against `trustedKeys` (Ed25519 / ECDSA / RSA PEM), the
  platform list and the measurement allowlist, honoured for `validitySeconds`. Until then calls are refused with
  JSON-RPC **-32024**. `POST /api/v1/admin/confidential/:server/nonce` · `…/attest` · `DELETE …/:server`;
  `GET /api/v1/admin/confidential` shows attestation state and the last rejection. [Guide](docs/guides/confidential.md).
- Pages demo: attested TEE servers.

## [9.2.0] - 2026-10-09

### Added
- **Edge WASM runtime 2.0** (`edgeRuntime`): WebAssembly **tools** (core ABI shared with WASM plugins: `memory`,
  `alloc`, an export `(ptr, len) -> i64` taking JSON arguments) run in worker sandboxes from a warm instance pool
  (`warm`, idle instances above it stop after `idleSeconds`), with SHA-256 pins (`sha256`) and per-tool quotas
  (`limits.timeoutMs`, `memoryMb`, `maxConcurrent`). Failures and quota refusals use JSON-RPC **-32023**.
  `POST /api/v1/features/edge-runtime/tools/:name/call`; `GET /api/v1/admin/edge-runtime` reports pool, cold starts
  and latency; `POST /api/v1/admin/edge-runtime/reload` re-reads and re-pins modules. [Guide](docs/guides/edge-runtime.md).
- Pages demo: edge WASM tools.

## [9.1.0] - 2026-10-09

### Added
- **Multimodal tools** (`multimodal`): content-type policy (`allowedTypes` MIME globs, default `image/*` and `audio/*`)
  and size limits (`maxItemBytes`, `maxTotalBytes`) for `image`, `audio` and embedded `resource` blobs in tool results;
  violations are refused with JSON-RPC **-32022** or stripped (`onViolation: strip`). Items above `offloadAboveBytes`
  are held by the gateway and replaced by a `resource_link` to `/api/v1/features/multimodal/blobs/:id`, streamed in
  64 KiB chunks with `Range` support. `GET /api/v1/admin/multimodal` reports counters and held blobs.
  [Guide](docs/guides/multimodal.md).
- Pages demo: multimodal policy and held blobs.

## [9.0.0] - 2026-10-09

### Breaking
- **Config schema v9 only.** `version: 8` is refused with a hint to run `mcp-gateway migrate --to 9` (8.9 reads both).
- **`state` removed** — the shared store is configured as `store: { backend: memory | redis | eventlog, redis, eventlog,
  failureMode }` (`state.store` → `store.backend`). `GatewayConfig.state` stays the internal (embedder) name.
- Data planes always receive `version: 9`; `GET /api/v1/admin/config` always returns `store`.

### Added
- **Event-sourced state store** (`store.backend: eventlog`): every `set` / `incr` / `del` is appended to
  `<dir>/events.log` with absolute expiry; on start the gateway loads `snapshot.json` and replays the log, so rate-limit
  windows, lockouts and MCP session metadata survive a restart of a single instance. Compaction every `snapshotEvery`
  events (default 10 000), on shutdown and on `POST /api/v1/admin/store/compact`; `fsync: true` for durable appends;
  a torn last line after a crash is skipped. `GET /api/v1/admin/store` reports the backend and log stats.
  `EventLogStateStore` is exported. [Guide](docs/guides/event-sourced-store.md).
- Pages demo: store status (event log) and empty deprecations.
- New roadmap for 9.1 → 10.0 in [docs/ROADMAP.md](docs/ROADMAP.md).

### Changed
- Nothing is deprecated in 9.0 (`DEPRECATIONS` is empty).

### Fixed
- `MCP_GATEWAY_REDIS_URL` wrote the `state` block, which 8.9 refused next to a `version: 9` / `store` file; it now sets
  `store.backend: redis`.
- `portableConfig()` converted `state` → `store` only for files that declared `version: 9`, so a config without
  `version` could not round-trip through the config API once v9 was the only schema; it now always writes `store`.
- `docs/deployment.md` and `docs/benchmarks.md` still showed the `state` block.
- Pages demo test for the config editor still expected the demo config on `version: 8`.

See [docs/guides/migrating-to-v9.md](docs/guides/migrating-to-v9.md).

## [8.9.0] - 2026-10-08

### Added
- **Schema v9 preview** — 8.9 reads `version: 9`, where the shared store is configured as
  `store: { backend: memory | redis, redis, failureMode }` (replaces `state`; 9.0 adds `backend: eventlog`).
  `GatewayConfig.state` stays the internal name; the config API round-trips `store` for v9 files.
- **`mcp-gateway migrate --to 9`** (now the default): `version: 9` and `state` → `store` (`state.store` →
  `store.backend`), comments kept. [Migrating to 9.0](docs/guides/migrating-to-v9.md).

### Deprecated (removed in 9.0)
- Config schema v8 (`version: 8`) and the `state` block — listed by `mcp-gateway validate`, at startup and by
  `GET /api/v1/admin/deprecations`.

### Changed
- `init`, the desktop profile, examples, docs and Helm values use `version: 9`; data planes receive the control
  plane's schema version (8 or 9). Pages demo lists the 8.9 deprecations.

### Fixed
- **Chaos testing (8.8):** the steady-state guard now also runs when an injected error or timeout refuses the call
  (previously only after upstream responses, so error-only experiments never aborted). 8.8.0 was merged with a red CI
  run caused by this and an outdated test; both are fixed here.

## [8.8.0] - 2026-10-08

### Added
- **Chaos testing** (`chaos`): time-boxed experiments that inject latency, errors (JSON-RPC **-32021**), timeouts and
  corrupted results into a share of matching calls (servers / tools / clients globs), started on demand
  (`POST /api/v1/admin/chaos/:id/start`, `…/stop`, `/stop-all`) or on a schedule (`every`), with a steady-state guard
  that aborts an experiment when the error rate gets too high. `GET /api/v1/admin/chaos` reports injected faults and
  observed calls / errors. [Guide](docs/guides/chaos.md).
- Pages demo: chaos experiments.

## [8.7.0] - 2026-10-08

### Added
- **Natural-language config assistant** (`configAssistant`): `POST /api/v1/admin/config-assistant/plan` `{ text }`
  turns plain-words instructions into a validated config patch with its diff (dry run) using a built-in phrasebook
  (rate limits, allow / block / require-approval rules, caching, add / remove servers, audit, log level) and, when
  `llm` is configured, any OpenAI-compatible model for the rest (secrets redacted). `POST …/apply` `{ planId }`
  applies it (409 when the config changed since planning). [Guide](docs/guides/config-assistant.md).
- Pages demo: a planned config change.

### Fixed
- Pages demo: the config-editor mock matched every path starting with `/admin/config` (e.g. `/admin/config-assistant/…`)
  and swallowed it; it now matches `/admin/config` and `/admin/config/…` only.

## [8.6.0] - 2026-10-08

### Added
- **Data lineage** (`dataLineage`): links each tool call's arguments to the earlier results they came from by value
  fingerprints (values never stored; JSON inside text content is walked), per client, tenant or globally.
  `GET /api/v1/admin/data-lineage`, per-call upstream / downstream graph (`…/nodes/:id`), trace by value
  (`POST …/trace`) and an OpenLineage-style export (`…/export`). [Guide](docs/guides/data-lineage.md).
- Pages demo: a lineage chain.

## [8.5.0] - 2026-10-08

### Added
- **Zero-downtime blue/green upgrades** (`blueGreen`): run two versions of an upstream side by side and switch all
  traffic atomically after a health **probe** on the idle colour (`POST /api/v1/admin/blue-green/:id/switch`, 409 when
  it fails unless `force`), drain in-flight calls on the old colour, watch a **verification window** with automatic
  rollback on errors, and roll back by hand (`POST …/rollback`). `GET /api/v1/admin/blue-green` shows in-flight calls,
  per-colour calls / errors and the switch history. [Guide](docs/guides/blue-green.md).
- Pages demo: a blue/green switch under verification.

### Fixed
- Debug sessions (8.3) no longer replace the call's arguments object when nothing was edited, so call hooks that
  track calls by their arguments (blue/green, cost advisor) keep seeing their results on the same calls.

## [8.4.0] - 2026-10-08

### Added
- **Cost optimization advisor** (`costAdvisor`): observes live tool calls (tool, argument hash, price, outcome) and
  returns quantified recommendations at `GET /api/v1/admin/cost-advisor` — cache tools with repeated identical calls,
  failing tools that burn money, cheaper upstreams serving the same tool (with a `rollouts` suggestion) and missing
  budgets — each with an estimated saving and the config to apply. [Guide](docs/guides/cost-advisor.md).
- Pages demo: cost recommendations.

## [8.3.0] - 2026-10-08

### Added
- **Live collaborative debugging** (`debugSessions`): operators open shared debug sessions that stream matching tool
  calls live (Server-Sent Events or polling), pause calls at conditional **breakpoints**, **edit arguments and
  resume** or **abort** them (JSON-RPC **-32020**), annotate calls with shared notes and replay captured calls.
  Arguments and results are redacted. `/api/v1/admin/debug-sessions/…`. [Guide](docs/guides/debug-sessions.md).
- Pages demo: a debug session with a paused call.

## [8.2.0] - 2026-10-08

### Added
- **Cross-gateway A2A federation** (`a2aFederation`): discover remote A2A agents (other gateways with `a2a.enabled`
  or any A2A 0.3 agent) from their agent cards, expose their skills (`skills` globs) to selected local clients
  (`clients` globs) and forward tasks with A2A `message/send` — `GET /api/v1/features/a2a-federation/skills`,
  `POST …/send`. Tasks carry `metadata.federation { gateway, client }` for the remote's audit; operators see remotes,
  card status and recent forwarded tasks at `GET /api/v1/admin/a2a-federation` (`POST …/refresh`).
  [Guide](docs/guides/a2a-federation.md).
- Pages demo: federated A2A remotes.

## [8.1.0] - 2026-10-08

### Added
- **Agent identity & delegated auth** (`agentIdentity`): an agent registry (id, tools, allowed `delegators`) and
  short-lived **delegation tokens** (HS256 `agent+jwt`) obtained by token exchange —
  `POST /api/v1/features/agent-identity/token` — with RFC 8693 `act` chains for sub-agents (scope narrowed per hop,
  `maxDelegationDepth`). Agents call tools with `POST /api/v1/features/agent-identity/call` as client `agent:<id>`
  on behalf of the user. `requireAgentFor` tool globs refuse direct calls with **-32019**. Operators:
  `GET /api/v1/admin/agent-identity`, `POST …/introspect`, `POST …/revoke`. [Guide](docs/guides/agent-identity.md).
- Pages demo: agent registry and delegation chains.

## [8.0.0] - 2026-10-08

### Breaking
- **Config schema v8 only.** `version: 7` is refused with a hint to run `mcp-gateway migrate --to 8` (7.9 reads both).
- **`plugins[].wasm` removed** — WASM plugins are plugin API v5 components loaded with `plugins[].component`
  (WIT world `mcp-gateway:plugin@5.0.0`, `wit/mcp-gateway-plugin.wit`). `PluginConfig.wasm` is gone. Marketplace
  installs of `.wasm` artifacts now return a `component:` entry.
- **Plugin API v4 removed** — JS plugins must declare `apiVersion: 5` (`PLUGIN_API_MIN_VERSION` is 5). v4 *return
  shapes* still work inside v5 plugins; `{ action }` outcomes are the documented contract.
- Every WASM plugin reports `apiVersion: 5`. Embedders may still pass a core-ABI module in code
  (`new WasmPlugin({ bytes })` / `loadWasmPlugin()`, `abi: 'core'`).

### Changed
- No deprecations are active in 8.0 (`DEPRECATIONS` is empty; `GET /api/v1/admin/deprecations` returns empty lists).
- Data planes always receive `version: 8`. Docs, examples and the Pages demo use schema v8 and `component:`.
- New roadmap for 8.1 → 9.0 in [docs/ROADMAP.md](docs/ROADMAP.md).

See [docs/guides/migrating-to-v8.md](docs/guides/migrating-to-v8.md).

## [7.9.0] - 2026-10-08

### Added
- **Plugin API v5 preview** — one contract for JS and WASM plugins, defined as the WIT world
  `mcp-gateway:plugin@5.0.0` (`wit/mcp-gateway-plugin.wit`, shipped in the package): hooks return
  `{ action: "continue" | "rewrite" | "deny" | "respond" }` / `{ action: "continue" | "replace" }`. JS plugins declare
  `apiVersion: 5` (v4 return shapes still accepted). [Guide](docs/guides/plugins-v5.md).
- **WASM component plugins** — `plugins[].component` runs the core module of a component for that world with the
  canonical ABI (`cabi_realloc`, `option<string>` returns, `cabi_post_*`, host import `mcp-gateway:plugin/host@5.0.0`
  `log`); same sandboxing as 3.3.
- **Schema v8 preview** — 7.9 reads `version: 8` (no `plugins[].wasm`).
- **`mcp-gateway migrate --to 8`** (now the default): `version: 8`, plus a note per WASM plugin to rebuild and per JS
  plugin to declare `apiVersion: 5`. [Migrating to 8.0](docs/guides/migrating-to-v8.md).

### Deprecated (removed in 8.0)
- Config schema v7 (`version: 7`), `plugins[].wasm` (3.3 core ABI) and plugin API v4 — listed by
  `mcp-gateway validate` / at startup and by `GET /api/v1/admin/deprecations`.

### Changed
- Examples, Helm values, `init` and `desktop` profiles use `version: 8`; data planes receive the control plane's schema
  version. Pages demo lists the 7.9 deprecations.

## [7.8.0] - 2026-10-08

### Added
- **Automated compliance reports** (`complianceReports`): scheduled (daily / weekly / monthly) evidence bundles for
  **SOC 2, ISO/IEC 27001:2022 and GDPR** — Markdown + JSON per framework, the redacted running config and a SHA-256
  `manifest.json` (tamper detection, `verifyBundle()`); oldest bundles pruned (`keep`). New ISO 27001 Annex A control
  mapping covering the 6.x / 7.x features. `GET /api/v1/admin/compliance-reports`, `POST …/run`, bundle download,
  `GET …/preview`. [Guide](docs/guides/compliance-reports.md).

## [7.7.0] - 2026-10-08

### Added
- **Approvals 2.0** (`approvalFlows`): multi-step approval flows matched by tool, client and argument conditions;
  steps with their own approvers (client-id globs — not only operators), quorum (`required`), conditions and
  escalation (`escalateAfterSeconds` → `escalateTo`); denial or timeout refuses with -32004. Approvers use
  `/api/v1/features/approval-flows/inbox|mine|:id/approve|:id/deny`; operators get `GET /api/v1/admin/approval-flows`,
  overrides and `POST …/evaluate`. [Guide](docs/guides/approval-flows.md).
- Feature modules can mount routes for every authenticated client under `/api/v1/features/<id>` (`mountClient`).

## [7.6.0] - 2026-10-08

### Added
- **Offline desktop gateway**: `mcp-gateway desktop --from claude|cursor|windsurf|vscode` (or `--import <file>`)
  writes a loopback profile with a generated key and the client's MCP servers, and prints the snippet that points the
  client at the gateway. `offline` mode probes connectivity (or is switched by hand) and refuses calls to remote
  upstreams with JSON-RPC error **-32018** while offline; local `stdio` servers and all local policies keep working.
  `GET/POST /api/v1/admin/offline`, `POST /api/v1/admin/offline/import`. [Guide](docs/guides/offline.md).

## [7.5.0] - 2026-10-08

### Added
- **Tool versioning & gradual rollout** (`rollouts`): route a sticky percentage of clients (plus `clients` /
  `exclude` globs) from a stable server to a canary server with the same tools; per-version calls and error rates,
  automatic rollback on a canary error-rate threshold, and runtime `percent` / `promote` / `rollback` / `reset`
  (`?persist=true` writes the config). Canary results carry `_meta["mcp-gateway/rollout"]`.
  [Guide](docs/guides/rollouts.md).
- Call hooks: `before` may return `{ serverId }` to route a call to another upstream.

## [7.4.0] - 2026-10-08

### Added
- **Semantic cache** (`semanticCache`): answers tool calls whose text arguments are similar enough (cosine ≥
  `threshold`) to an earlier successful call of the same tool, in the same tenant / client / global scope; non-text
  arguments must match exactly. Embeddings: `local` (offline hashed n-grams) or any OpenAI-compatible `/embeddings`
  API. Hits carry `_meta["mcp-gateway/semantic-cache"]`. Admin: `GET/DELETE /api/v1/admin/semantic-cache`,
  `POST /api/v1/admin/semantic-cache/similarity`. [Guide](docs/guides/semantic-cache.md).
- Call hooks: `before` may return `{ respond }` to answer a call without the upstream (after hooks still run).

## [7.3.0] - 2026-10-08

### Added
- **Prompt-injection defence & tool-output sanitisation** (`sanitize`): removes hidden Unicode (zero-width, bidi,
  tag characters), ANSI escapes, `<script>`-style HTML blocks and markdown images to non-allowed hosts (zero-click
  exfiltration); optional truncation and **spotlighting** (`<<tool-output server/tool>>` delimiters). Injection scoring
  of results with `flag` / `mark` / `block`, and `inbound: block` for arguments — refusals use JSON-RPC error **-32017**.
- `GET /api/v1/admin/sanitize`, `POST /api/v1/admin/sanitize/preview`. [Guide](docs/guides/sanitize.md).

## [7.2.0] - 2026-10-08

### Added
- **SaaS console** — organisations on top of tenants with **plans** (`console.plans`: servers, `callsPerDay`):
  onboarding (`POST /api/v1/admin/console/orgs` creates the tenant + owner), plan changes that re-scope the tenant's
  servers, suspension and offboarding; usage today / remaining per organisation. Calls over the daily limit or from a
  suspended organisation are refused with JSON-RPC error **-32016**. [Guide](docs/guides/console.md).

## [7.1.0] - 2026-10-08

### Added
- **Terraform** — manage servers, tenants and API keys with the generic `Mastercard/restapi` provider:
  `GET/POST /api/v1/admin/terraform/:kind`, `GET/PUT/DELETE /api/v1/admin/terraform/:kind/:id` (`ETag` / `If-Match`,
  `?dryRun=true`, `<redacted>` keeps secrets), each write validated and hot-applied (`controlPlane.configApi: true`).
- `GET /api/v1/admin/terraform/export` — `main.tf` for the running config with `import` blocks; secrets become
  sensitive variables. [Guide](docs/guides/terraform.md).
- Feature context `applyConfig()` (validate + diff + hot-apply a full config) for feature modules.

### Notes
- A native Go `mcp-gateway` provider is deferred: it needs a Go toolchain and Terraform Registry signing; the resource
  API is designed so it can be layered on later.

## [7.0.0] - 2026-10-08

### Breaking
- **Config schema v7 only.** `version: 6` is refused with a hint to run `mcp-gateway migrate --to 7` (6.9 reads both).
- **Top-level `admin` and `dashboard` removed** — use `controlPlane.configApi` and `controlPlane.dashboard`
  (`migrate --to 7` moves them). For embedders: `GatewayConfig.admin` / `.dashboard`, the `AdminConfig` type and
  `normalizeControlPlane()` are gone; `GatewayConfig.controlPlane` (`ControlPlaneConfig`) replaces them.

### Added
- **Control plane / data plane split** — `controlPlane.role: all | control | data` (default `all` = 6.x behaviour).
  - Control plane: `GET /api/v1/admin/data-planes` (nodes, config ETag, in sync, online / stale),
    `GET /api/v1/admin/data-planes/config` (`ETag` / `If-None-Match` → 304), `POST /api/v1/admin/data-planes/heartbeat`,
    `DELETE /api/v1/admin/data-planes/:nodeId`.
  - Data plane (`url`, `token`, `pullIntervalMs`, `nodeId`): pulls and hot-applies the control plane's config, sends
    heartbeats, blocks `/api/v1/admin/*` (403) and fails closed (503) until its first config arrives;
    `GET /api/v1/data-plane` shows the sync state.
  - Exports: `ControlPlaneSchema`, `DataPlaneSync`, `createControlPlaneRouter`, `configEtag`, `distributedConfig`.
- [Control plane guide](docs/guides/control-plane.md).

### Changed
- No deprecations are active in 7.0. Helm chart values and examples use `version: 7`.
- Pages demo: control-plane data-plane list, empty deprecations, demo config on schema v7.
- New roadmap for 7.1 → 8.0 in [docs/ROADMAP.md](docs/ROADMAP.md).

See [docs/guides/migrating-to-v7.md](docs/guides/migrating-to-v7.md).

## [6.9.0] - 2026-10-08

### Added
- **Schema v7 preview** — 6.9 reads `version: 7`, where the control-plane settings live under `controlPlane`
  (`configApi`, `dashboard`). `admin` / `dashboard` are not part of v7; setting both forms is an error.
- **`mcp-gateway migrate --to 7`** (now the default): `version: 7`, `admin.configApi` → `controlPlane.configApi`,
  `dashboard.enabled` → `controlPlane.dashboard`, on top of every earlier step (v3/v4/v5 → v7 in one go).
- [Migrating to 7.0](docs/guides/migrating-to-v7.md).

### Deprecated (removed in 7.0)
- Config schema v6 (`version: 6`), the top-level `admin` section and the top-level `dashboard` section — listed by
  `mcp-gateway validate` and `GET /admin/deprecations`.

### Changed
- Examples use `version: 7`. Pages demo lists the 6.9 deprecations.

## [6.8.0] - 2026-10-08

### Added
- **Helm chart** (`deploy/helm/mcp-gateway`): ConfigMap from `values.config`, hardened Deployment (non-root,
  read-only root FS, config-hash rollouts), Service, optional HPA, PDB, ServiceMonitor and the operator with RBAC.
  Linted and rendered in CI (`.github/workflows/helm.yml`).
- **Kubernetes operator** — `McpGateway` custom resource (`mcp-gateway.dev/v1alpha1`, CRD in
  `deploy/crd/mcpgateways.yaml`) reconciled by `mcp-gateway operator` with server-side apply, owner references and
  status conditions.
- `GET /admin/k8s/manifests` renders manifests for the running config (API keys excluded); `GET /admin/k8s/crd`.
  See [docs/guides/kubernetes.md](docs/guides/kubernetes.md).
- Library: `renderManifests`, `K8sOperator`, `inClusterApi`, `configHash`, `MCPGATEWAY_CRD`.

## [6.7.0] - 2026-10-08

### Added
- **Usage billing and invoices** — `billing` meters successful calls per account (tenant, else client id) by month
  and `server/tool` (calls, tokens, duration), prices them with a glob-matched price book (per call / input token /
  output token / second), and builds invoices with discounts, monthly minimums and tax. `GET /admin/billing/usage`,
  `/admin/billing/invoices`, `/admin/billing/invoices/:account` (JSON or CSV). Optional persistence. See
  [docs/guides/billing.md](docs/guides/billing.md).
- Library: `BillingSchema`, `BillingUsageMeter`, `priceFor`, `buildInvoice`, `invoiceCsv`.
- Pages demo: invoices.

## [6.6.0] - 2026-10-08

### Added
- **Anomaly detection** — `anomaly` watches each client for traffic bursts against its EWMA baseline, error spikes
  and tool enumeration, and scores arguments / results for prompt injection (weighted signals: instruction override,
  role override, tool hijacking, exfiltration URLs, hidden Unicode, base64 blobs …). `action: quarantine` refuses an
  abusive client's calls (`-32015`) for `quarantineSeconds` and blocks injected arguments. `GET /admin/anomaly`,
  `POST /admin/anomaly/score`, `POST /admin/anomaly/release`. See [docs/guides/anomaly.md](docs/guides/anomaly.md).
- Library: `AnomalySchema`, `AnomalyDetector`, `injectionScore`, `ERR_ANOMALY_QUARANTINED`.
- Pages demo: anomaly alerts.

## [6.5.0] - 2026-10-08

### Added
- **Policy simulation and dry-run** — `POST /admin/policy-sim/simulate` diffs a candidate policy against past calls
  (replay capture with arguments, recent metrics, or calls in the request): transitions, impact by client / tool /
  rule, examples. `POST /admin/policy-sim/dry-run` decides a hypothetical call. **Shadow mode** (`policyShadow`)
  evaluates a second policy on live traffic without enforcing it and records divergences
  (`GET /admin/policy-sim/shadow`). See [docs/guides/policy-sim.md](docs/guides/policy-sim.md).
- Library: `simulatePolicy`, `CandidatePolicySchema`, `PolicyShadowSchema`, `ShadowRecorder`.

### Changed
- The policy rule schema moved to `src/policy/rule-schema.ts` (shared by the loader and simulation).

## [6.4.0] - 2026-10-08

### Added
- **Enterprise SSO and SCIM** — `identity` adds a SCIM 2.0 provisioning endpoint
  (`/admin/identity/scim/v2/Users|Groups`, filters, PATCH incl. group members, ServiceProviderConfig), OIDC ID-token
  verification (`POST /admin/identity/sso/verify`, JWKS or inline keys) and an authorization-code + PKCE login URL,
  and maps IdP groups to tenant roles (`groupRoles`, highest role wins; deactivated users lose access). Optional JSON
  persistence. See [docs/guides/identity.md](docs/guides/identity.md).
- Library: `IdentitySchema`, `ScimDirectory`, `scimFilter`, `resolveMemberships`, `verifyIdToken`, `authorizeUrl`.
- Pages demo: identity status, SCIM users, memberships.

## [6.3.0] - 2026-10-08

### Added
- **OpenTelemetry GenAI semantic conventions** — `genaiTelemetry` describes tool calls as `execute_tool` spans (and
  LLM servers listed in `systems` as `chat` operations) with `gen_ai.*` attributes, token usage read from OpenAI /
  Anthropic result shapes, and the `gen_ai.client.operation.duration` / `gen_ai.client.token.usage` histograms.
  Optional OTLP/HTTP JSON push; content capture is opt-in. `GET /admin/genai-otel`, `/spans`, `/otlp`. See
  [docs/guides/genai-otel.md](docs/guides/genai-otel.md).
- Library: `GenaiTelemetrySchema`, `GenaiRecorder`, `genaiAttributes`, `extractUsage`.
- Pages demo: GenAI metrics and spans.

## [6.2.0] - 2026-10-08

### Added
- **Workflow engine** — `workflows[]` defines multi-tool DAGs: nodes with `needs`, maximal parallelism bounded by
  `concurrency`, `if` conditions, retries with exponential backoff and `onError: fail | continue`. Async runs with
  per-node status: `GET /admin/workflows`, `POST /admin/workflows/run`, `GET /admin/workflows/runs[/:id]`. Config
  validation rejects cycles and unknown dependencies. See [docs/guides/workflows.md](docs/guides/workflows.md).
- Library: `WorkflowsSchema`, `runWorkflow`, `topoLayers`, `WorkflowRuns`.
- Pages demo: workflow DAG and run.

## [6.1.0] - 2026-10-08

### Added
- **GraphQL / gRPC upstreams** — `apiUpstreams[]` exposes GraphQL operations (input schema derived from the variable
  definitions) and unary gRPC methods (Connect protocol / gRPC-JSON transcoding) as tools `<upstream>.<operation>`.
  `GET /admin/api-upstreams`, `POST /admin/api-upstreams/call`. See
  [docs/guides/api-upstreams.md](docs/guides/api-upstreams.md).
- Library: `ApiUpstreamsSchema`, `apiUpstreamTools`, `callApiUpstream`, `graphqlVariables`.
- Pages demo: API upstream tools.

## [6.0.0] - 2026-10-08

### Breaking
- **Config schema v6 only.** `version: 5` is refused with a hint to run `mcp-gateway migrate --to 6` (5.9 reads both).
- **`compliance.pii` removed** — configure PII handling with `dlp` (5.6). `GET /api/v1/compliance` and the SOC 2 /
  GDPR reports now read their PII settings and counters from `dlp`; findings are keyed by category.
- **Plugin API v3 refused** — declare `apiVersion: 4` (adds `ctx.state`, nothing else changes).
- **Node.js 22+** is enforced by the CLI with a clear message (`engines.node` was already `>=22`).

### Changed
- No deprecations are active in 6.0; `GET /api/v1/admin/deprecations` is empty for a clean config.
- Pages demo: deprecations list empty, demo plugins on API v4.
- New roadmap for 6.1 → 7.0 in [docs/ROADMAP.md](docs/ROADMAP.md).

See [docs/guides/migrating-to-v6.md](docs/guides/migrating-to-v6.md).

## [5.9.0] - 2026-10-08

### Deprecated (removed in 6.0)
- **Config schema v5** — `version: 5` logs a deprecation; 6.0 reads `version: 6` only.
- **`compliance.pii`** — superseded by `dlp` (5.6).
- Plugin API v3 (since 5.0).

### Added
- **Schema v6 preview** — 5.9 reads `version: 6` (v5 without `compliance.pii`); `mcp-gateway init` and the
  examples write v6.
- **`mcp-gateway migrate --to 6`** (now the default) — `version: 6` and `compliance.pii` → `dlp` (action, scope,
  servers, categories and `enabled` mapped; comments kept); notes for plugins and the DLP error code.
  `--to 5` / `--to 4` still available.
- [Migrating to 6.0](docs/guides/migrating-to-v6.md) guide.
- Pages demo: the deprecations card lists the 6.0 config deprecations.

## [5.8.0] - 2026-10-08

### Added
- **Adaptive routing 2.0** — `adaptive.pools[]` of interchangeable candidates (server + tool + fixed `args`, e.g. a
  model, + `costPerCall`) with objective weights for quality, cost and latency and an optional `maxCostPerCall`.
  Latency / errors are learned from live traffic; quality from `POST /admin/adaptive/feedback`. Picks use Thompson
  sampling over a Beta posterior. `GET /admin/adaptive`, `POST /admin/adaptive/pick`, `POST /admin/adaptive/call`.
  See [docs/guides/adaptive-routing.md](docs/guides/adaptive-routing.md).
- Library: `AdaptiveRouter`, `adaptiveRouter`, `sampleBeta`, `AdaptiveSchema`.
- Pages demo: adaptive pools and picks.

## [5.7.0] - 2026-10-08

### Added
- **Python SDK 5.7.0** — `stream_tool()` (SSE from `POST /api/v1/tools/stream`), `McpSession` (Streamable HTTP
  `/mcp`: initialize, paginated `list_tools`, `call_tool` with JSON or SSE replies, `ping`, `DELETE` on close),
  `McpError`, `parse_sse`; PyPI-ready metadata (classifiers, project URLs, keywords).
- **Go SDK 5.7.0** — `Client.StreamTool()`, `Client.MCP()` → `MCPSession` (`ListTools`, `CallTool`, `Ping`,
  `Close`), `ParseSSE`, `RPCError`.
- `test/sdk-python.test.ts` runs the Python SDK against a live gateway (MCP session + streaming).
- [docs/guides/sdk-release.md](docs/guides/sdk-release.md): per-SDK version / build / publish checklist and feature
  parity table.

### Notes
- Publishing to PyPI / Go module tags / Swift Package Index is documented but not performed (needs registry
  credentials). Swift and Kotlin streaming + MCP sessions are deferred.

## [5.6.0] - 2026-10-08

### Added
- **Data loss prevention** — `dlp: { scope, servers, default, tenants, detectors, levels }`: PII and custom
  detectors get sensitivity levels (`public` < `internal` < `confidential` < `restricted`); data above a tenant's
  clearance is masked (`mask`, `redact`, stable `hash` pseudonyms) or the call is refused (`block`, `-32013`), on
  arguments and / or results. `GET /admin/dlp` (policy + counters), `POST /admin/dlp/classify` (test bench).
  See [docs/guides/dlp.md](docs/guides/dlp.md).
- **Call hooks** — `registerCallHook({ id, before, after })` lets feature modules and embedders inspect / rewrite /
  refuse tool calls inside the invoker pipeline.
- Pages demo: DLP policy and classification.

## [5.5.0] - 2026-10-08

### Added
- **Agent session recording, replay and evals** — record an agent's tool calls from the replay capture
  (`POST /admin/sessions { name, clientId?, since?, until?, tools? }`), import / export recordings as JSON, and
  replay them through the full pipeline graded by `success`, `structure` or `exact` mode
  (`POST /admin/sessions/:name/replay`) → pass rate, per-step diffs, latency before / after.
  `sessions: { dir, maxRecordings }` persists recordings. See [docs/guides/session-evals.md](docs/guides/session-evals.md).
- `ReplayRecorder.list()`; library: `recordFrom`, `replayRecording`, `gradeStep`, `RecordingStore`.
- Pages demo: recordings and a replay eval.

### Fixed
- Feature-module tool invocations (5.1+) pass tool arguments correctly.

## [5.4.0] - 2026-10-08

### Added
- **Signed plugins** — Ed25519 signatures (`<plugin>.sig`: `{ keyId, sha256, signature }`) checked at load against
  `pluginTrust: { keys[], requireSigned }`; tampered, unknown-key or (with `requireSigned`) unsigned plugins are
  refused. `plugins[].signature` overrides the signature path. Hot reloads.
- **CLI** — `mcp-gateway plugin keygen | sign | verify`.
- **Plugin marketplace** — `marketplace: { dir, indexes[], maxBytes }`; `GET /admin/marketplace` browses indexes
  (`trusted` flag), `POST /admin/marketplace/install` downloads, checks size + sha256 + signature and writes the
  plugin and its `.sig`, returning the `plugins:` entry to add. See [docs/guides/plugins.md](docs/guides/plugins.md#signed-plugins-and-the-marketplace-54).
- Library: `generateSigningKey`, `signArtifact`, `verifyArtifact`, `PluginTrustSchema`, `MarketplaceSchema`,
  `parseMarketplaceIndex`, `installMarketplaceEntry`, `compareVersions`.
- Pages demo: marketplace list and install.

## [5.3.0] - 2026-10-08

### Added
- **Managed edge nodes** — `edgeFleet: { nodes[{ id, url, apiKey, labels }], pushTimeoutMs, offlineAfterMs }`.
  `GET /admin/edge-fleet` merges configured and seen edges and classifies config drift (`in-sync`, `stale`,
  `never-synced`, `offline`, `unmanaged`); `POST /admin/edge-fleet/push` makes selected edges (`nodes`, `labels`
  ring, `onlyDrifted`) sync now via their `POST /api/v1/edge/sync`. See [docs/guides/edge.md](docs/guides/edge.md#managed-edge-fleet-53).
- Dashboard: **Edge nodes** card (drift badges, queued calls, *Push config*).
- Library: `fleetView()`, `selectNodes()`, `pushToNodes()`, `EdgeFleetSchema`.
- Pages demo: edge fleet view and push.

## [5.2.0] - 2026-10-08

### Added
- **Multi-region active-active** — `regions: { self, peers[], syncIntervalMs, downAfter }`. Regions replicate a
  last-writer-wins key-value state (monotonic per-region clock, tombstones, relay) and gossip online upstream
  servers; `GET /admin/regions/route/:serverId` picks `local`, the best healthy peer, or `none`.
  Endpoints: `GET /admin/regions`, `POST /admin/regions/sync`, `GET|PUT|DELETE /admin/regions/kv/:key`.
  Library: `RegionMesh`, `RegionsSchema`. See [docs/guides/multi-region.md](docs/guides/multi-region.md).
- Feature-module config sections hot reload (`FEATURE_CONFIG_KEYS`); feature modules can register stop hooks.
- Pages demo: regions status and routing.

## [5.1.0] - 2026-10-08

### Added
- **MCP conformance suite** — `mcp-gateway conformance <url>` runs 11 black-box checks (initialize, version
  negotiation, JSON-RPC error codes, ping, 202 notifications, tools/list shape, unknown tool, `MCP-Protocol-Version`
  header, unknown session) against any Streamable HTTP MCP endpoint; `--only`, `-H`, `--json`; exit 1 on failure.
  Library: `runConformance()`, `formatConformanceReport()`. See [docs/guides/conformance.md](docs/guides/conformance.md).
- **Feature modules** — `GET /api/v1/admin/features`; modules mount under `/api/v1/admin/<id>` (operators only).
  `registerFeature()` / `createFeatureRouter()` exported for embedders.
- `POST /api/v1/admin/conformance/run` self-tests the running gateway's `/mcp`; `GET /admin/conformance/checks`.
- Pages demo: features list and conformance run.

### Notes
- The roadmap's "authorization extension passthrough" item is deferred (no new upstream auth extension to pass
  through yet); the gateway already forwards `_meta` and OAuth protected-resource metadata.

## [5.0.0] - 2026-10-08

⚠ **Breaking release** — see [Migrating to 5.0](docs/guides/migrating-to-v5.md). A config or plugin that 4.9 loads
without deprecation warnings runs on 5.0 unchanged; `mcp-gateway migrate` rewrites v3 / v4 files to v5.

### Removed
- Config schema v4: `version: 4` is refused — use `version: 5` (or omit it).
- `servers[].timeout` — use `servers[].timeoutMs`.
- Plugin API v2 is refused at load — declare `apiVersion: 4`.
- `normalizeV4Preview()` (library) — use `normalizeApiKeyScopes()`.

### Changed
- **Config schema v5** is the only schema; `mcp-gateway init` writes v5; examples migrated.
- **Plugin API v4** (`ctx.state`) is the current contract; `PLUGIN_API_MIN_VERSION` is 3.
- The admin API (`GET /api/v1/admin/config`) and the dashboard Config tab use `timeoutMs`; the Pages demo config is v5.
- `mcp-gateway migrate` keeps YAML flow collections compact (`["a", "b"]`).
- `docs/ROADMAP.md` now holds the post-5.0 plan (v5.1 → v6.0).
- Test PKI for the mTLS tests is generated at run time (`test/helpers/mtls-certs.ts`, needs `openssl`); the committed
  test keys under `test/fixtures/mtls/` were removed.

### Deprecated (removed in 6.0)
- Plugin API v3 — declare `apiVersion: 4`.

### Unchanged
- REST / MCP / edge APIs, the JS / Kotlin / Python / Go / Swift clients (no client upgrade needed; the JS client is not
  republished), Docker base image (Node 22), dashboard CSP.

## [4.9.0] - 2026-10-08

### Added
- **Schema v5 preview**: 4.9 reads `version: 5` configs, where servers use `timeoutMs` (instead of `timeout`).
  The admin API returns v5 field names for v5 configs, so GET → edit → PUT round trips keep working.
- **`mcp-gateway migrate --to 5`** (now the default target): `version` → 5 and `servers[].timeout` → `timeoutMs`
  (renamed in place, comments kept), plus the 4.0 steps, so 3.x files go straight to v5; `--to 4` still works.
- **Plugin API v4**: v3 plus `ctx.state`, a per-plugin key-value store with TTLs (`get` / `set(key, value, ttlMs)` /
  `has` / `delete` / `size` / `clear`, ≤ 10 000 keys). `PLUGIN_API_VERSION` is 4; v3 plugins load unchanged.
- Migration guide `docs/guides/migrating-to-v5.md`.

### Deprecated (removed in 5.0)
- `version: 4` (`config-version-4`) and `servers[].timeout` (`config-server-timeout`) — listed by `mcp-gateway validate`,
  `GET /api/v1/admin/deprecations` and logged once at start-up.
- Plugin API v2 (refused by 5.0; the warning now points to `apiVersion: 4`).
- `normalizeV4Preview()` (library) — use `normalizeApiKeyScopes()`.

## [4.8.0] - 2026-10-08

### Added
- **Offline / edge sync** for the edge gateway (`@winstonsayno/mcp-gateway/edge`, new `EdgeSync`, `memoryStore`):
  - **Config snapshots** from a Node gateway acting as control plane (`GET /api/v1/admin/edge/snapshot`, ETag /
    `If-None-Match`): enabled `streamable-http` servers with their known tool catalog, unscoped API keys as `sha256:`
    digests, tool naming, CORS. The last good snapshot is kept in a KV store (Workers KV compatible), so a cold isolate
    boots while the control plane is down. Local servers / headers / settings win over the snapshot.
  - Upstream headers are only included with `includeSecrets` (`?secrets=true`), which needs `admin.configApi: true`.
  - **Offline tool lists**: when an upstream is unreachable, `tools/list` serves the last list or the snapshot catalog.
  - **Offline queue** (`offline.queueTools` globs): calls to an unreachable / 5xx upstream are queued (REST `202`
    with `queued`, MCP `structuredContent: { queued: true, id }`) and replayed on the next sync; rejected calls are
    dropped and reported.
  - **Usage outbox**: live / queued / replayed calls are pushed to `POST /api/v1/admin/edge/sync` and show up in the
    control plane's metrics as client `edge:<edgeId>`; `GET /api/v1/admin/edge/nodes` lists edges.
  - `gw.sync()`, background sync on requests (`syncIntervalMs`, Workers `waitUntil`), `GET /api/v1/edge/status`,
    `POST /api/v1/edge/sync`; `workersHandler()` gains `scheduled` (Cron Triggers); `configFromEnv` reads
    `MCP_GATEWAY_CONTROL_PLANE`, `_CONTROL_KEY`, `_EDGE_ID`, `_QUEUE_TOOLS`, `_SYNC_INTERVAL_MS` and the `MCP_GATEWAY_KV` binding.
- The GitHub Pages demo simulates the edge control plane endpoints.

## [4.7.0] - 2026-10-08

### Added
- **Python SDK** (`clients/python`, package `mcp-gateway-client`): stdlib-only (`urllib`), Python ≥ 3.9, typed
  `health` / `ready` / `metrics`, `servers`, `list_tools`, `tool_schemas` + `call_llm_tool`, `call_tool`, resources,
  prompts, approvals; `GatewayError` with `status`, `code`, `retry_after`, `is_policy_error`. `py.typed`.
- **Go SDK** (`clients/go`, module `github.com/HarrisonCN/mcp-gateway/clients/go`): `net/http` only, Go ≥ 1.21,
  context-aware `Health`, `Ready`, `Servers`, `ListTools`, `ToolSchemas` + `CallLLMTool`, `CallTool`, `Approve` / `Deny`;
  `*mcpgateway.Error` with `Code()`, `IsPolicyError()`, `RetryAfter`.
- **Swift SDK** (`clients/swift`, SwiftPM `MCPGateway`): async/await, `URLSession` by default with a pluggable
  transport, macOS 12 / iOS 15 / Linux; `GatewayError.isPolicyError`.
- New **SDKs** CI workflow (`.github/workflows/sdks.yml`): Python 3.9 / 3.12 / 3.13 tests + sdist/wheel build,
  Go 1.21 / stable `vet` + `test -race`, Swift 6.0 `build` + `test` on Linux. Package-registry publishing (PyPI, Go
  module tags, Swift Package Index) is not automated yet.

## [4.6.0] - 2026-10-08

### Added
- **Graphical config editor** in the dashboard (new **Config** tab): edit general settings (log level, tool naming,
  rate limit) and the server list (add / remove, transport, URL or command, timeout, enabled) in forms, or the full
  schema-v4 JSON; **Validate**, **Preview changes** (diff) and **Apply** (hot reload, with confirmation) use the admin
  API (`/api/v1/admin/config…`). Secrets stay `<redacted>` and keep their running values.
- The tab is read-only (Apply disabled, with a hint) unless `admin.configApi: true`; operators only.
- Bilingual (English / 中文), no inline handlers — the dashboard CSP (hashed inline script) is unchanged.
- The GitHub Pages demo has a simulated config backend (validate / diff / dry run / apply).

## [4.5.0] - 2026-10-08

### Added
- **Zero-trust upstream mTLS** (`mtls:` + `servers[].tls`): the gateway presents its X.509 identity (e.g. a SPIRE
  X.509-SVID written by `spiffe-helper`) to HTTPS upstreams (`streamable-http`, `sse`) and verifies them against a
  trust bundle — with `tls.spiffeId` (globs) the peer's SPIFFE URI SAN replaces the hostname check.
- **Certificate rotation**: identity files are re-read every `reloadIntervalSeconds`; a new certificate replaces the
  connection pool without a restart, mismatched keys are rejected, and expiry is warned `expiryWarningHours` ahead.
- `GET /api/v1/mtls`: identity (SPIFFE ID, expiry, rotations), observed peer identities and per-server mode; shown in
  the GitHub Pages demo.
- New runtime dependency: `undici` (connection pools with client certificates).

## [4.4.0] - 2026-10-08

### Added
- **Streaming tool results**: `POST /api/v1/tools/stream` answers with SSE — `progress`, `partial` (progress messages
  as result chunks), `result` / `error` and `end`; a client disconnect cancels the upstream call.
- **Backpressure**: SSE writes respect the socket buffer — above `streaming.highWaterBytes` droppable events are
  coalesced (latest kept, flushed on drain), control events are never dropped, and consumers more than
  `streaming.maxBufferedBytes` behind are disconnected.
- **Load shedding**: `servers[].maxQueue` bounds the calls waiting for a `maxConcurrency` slot; beyond it calls fail
  fast with `-32015` (REST `503` + `Retry-After: 1`) instead of queueing until they time out.
- `SseWriter` exported for embedders; the GitHub Pages demo streams a sample call.

## [4.3.0] - 2026-10-08

### Added
- **Cost accounting per LLM call** (`costs:`): flat per-call prices by `server/tool` glob plus per-token model prices
  applied to the usage an upstream reports in `_meta.usage` (gateway, OpenAI and Anthropic field names). Costs accrue
  per client, tenant, server, tool and model; spans get `mcp.cost` and `gen_ai.usage.*` attributes.
- **Budgets and alerts**: per pool, per client (`perClient`) or per tenant, per UTC day or month; `alertAt` thresholds
  fire once per period (log, `GET /api/v1/costs`, optional webhook); `action: block` refuses calls with `-32013`
  until the period resets.
- `GET /api/v1/costs?by=client|tenant|server|model|tool&period=day|month|all` (operators); costs panel data in the
  GitHub Pages demo.

## [4.2.0] - 2026-10-08

### Added
- **Tool chains & multi-agent orchestration** (`chains:`): declarative pipelines of tool calls across servers —
  sequential steps, `forEach` fan-out with `concurrency` (one call per item, e.g. one sub-agent per document),
  `parallel` groups, `when` conditions, `continueOnError`, `{{input.*}}` / `{{steps.<id>.*}}` / `{{item}}` templates,
  an `output` template and a run `timeoutMs`.
- Every step runs through the normal invoker as the caller (scopes, policy, plugins, quotas, audit, tracing); a chain
  that touches a tool outside the caller's scope is refused before anything runs.
- Chains are MCP tools (`chain_<name>`, prefix configurable) on `/mcp`, and REST: `GET /api/v1/chains`,
  `POST /api/v1/chains/:name/run`. The GitHub Pages demo lists two sample chains.

## [4.1.0] - 2026-10-08

### Added
- **MCP 2025-11-25** is the newest revision on `/mcp` (2025-06-18, 2025-03-26 and now 2024-11-05 are still accepted)
  and is accepted from upstream servers. Each downstream session negotiates its own revision; `mcp.protocolVersions`
  pins the list.
- **Per-revision shaping** (`src/mcp/compat.ts`): structured tool output (`outputSchema` / `structuredContent`),
  resource links (`resource_link` content) and tool `title` / `annotations` pass through to clients that understand
  them and are downgraded (text blocks / stripped) for older ones. A text block is added when an upstream returns only
  `structuredContent`.
- `GET /api/v1/mcp/protocol`: supported revisions, feature matrix and the revision each upstream negotiated (also in
  the GitHub Pages demo).
- Exports: `PROTOCOL_VERSIONS`, `negotiateVersion`, `adaptTool`, `adaptToolResult`, `protocolSupports`.

## [4.0.0] - 2026-10-08

### ⚠ Breaking
- **Config schema v4 is required.** `version: 3`, `servers` / `tools` / `rateLimit` directly on an API key, and
  `loadBalancing.strategy: least-latency` are validation errors naming the replacement — run `mcp-gateway migrate`
  (available since 3.9). `version` may be `4` or omitted.
- **Plugin API v1 is refused** (plugins without `apiVersion`). Declare `apiVersion: 3`.
- `least-latency` removed from the balancer and the `LoadBalancingConfig` type (use `smart` with a latency-only score).

### Added
- **Plugin API v3**: `ctx.secrets.get(name)` for secrets granted in the plugin's new `secrets:` config
  (`secret://` references, resolved by the secret providers), `ctx.tenant` (`{ id, name, role }`) on call hooks, and
  the `onConfigChange(change, ctx)` hook after every applied hot reload. `grantSecrets()` for plugins passed in code.
- The admin config API, `diff` / `apply` and the generated default config use schema v4 (nested `scope`).
- Final [Migrating to 4.0](docs/guides/migrating-to-v4.md) guide; new [docs/ROADMAP.md](docs/ROADMAP.md) (v4.1 → v5.0).

### Deprecated (removed in 5.0)
- Plugin API v2 (`apiVersion: 2`) — loads with a warning; declare `apiVersion: 3`.

The REST / `/mcp` APIs and the JS / Kotlin clients are unchanged.

## [3.9.0] - 2026-10-08

### Added
- **`mcp-gateway migrate`** rewrites a config file to schema v4 — `version: 4`, API-key scope nested under `scope:`,
  `least-latency` → `smart` with a latency-only score — keeping YAML comments and layout. `--write` (keeps a `.bak`),
  `-o <file>`, `--check` (exit 3 when a migration is needed, for CI).
- **v4 preview:** 3.9 already reads `version: 4` and `auth.apiKeys[].scope`, so a migrated file runs on 3.9 before
  the 4.0 upgrade.
- **`mcp-gateway bench`**: in-process benchmark (REST, REST with auth, cache hit, `/mcp`) with req/s and p50 / p95 / p99;
  `runBenchmark()` exported. Reference numbers in [docs/benchmarks.md](docs/benchmarks.md).
- [Migrating to 4.0](docs/guides/migrating-to-v4.md) (preview). The GitHub Pages demo lists the new deprecations.

### Deprecated (removed in 4.0)
- `version: 3` → `version: 4`.
- `servers` / `tools` / `rateLimit` directly on an API key → `scope: { servers, tools, rateLimit }`.
- `loadBalancing.strategy: least-latency` → `smart` with `score: { latency: 1, errorRate: 0, cost: 0 }`.
- (Already scheduled) plugin API v1.

`mcp-gateway validate` and `GET /api/v1/admin/deprecations` list each with the affected keys / servers.

## [3.8.0] - 2026-10-08

### Added
- **Developer portal** at `/portal` (`portal.enabled`, needs `auth.strategy: api-key`): self-service API keys
  (`signup: open | approval | closed`, allowed e-mail domains, keys per e-mail, default scope / rate limit / TTL),
  shown once and stored as SHA-256 digests (`portal.keysFile` to persist).
- **Usage view:** a key holder sees 7-day calls, errors, latency, calls per tool and per day; can rotate or revoke
  the key.
- **Interactive tool docs:** every tool in the key's scope with its input schema, generated example arguments,
  curl / JavaScript / Python snippets and a live **Try it**.
- Portal keys join `auth.apiKeys` as `portal-<id>`, so scopes, quotas, policy, audit and compliance apply unchanged.
  Operators approve / deny / revoke via `/api/v1/portal/keys`.
- The GitHub Pages demo publishes `portal.html` with a simulated backend; `dashboard/portal.html` ships in the npm
  package and the Docker image.

### Security
- Self-contained page with a hash-based CSP (no inline handlers, no CDN); signups throttled per IP; key records
  never expose digests.

## [3.7.0] - 2026-10-08

### Added
- **PII detection & redaction.** `compliance.pii` scans tool arguments (before the upstream) and/or results (before
  the client) for e-mail, phone, payment card (Luhn), US SSN, IBAN (mod-97), IPv4 and PRC resident ID (checksum).
  `action: redact` (default) masks matches as `[REDACTED:<category>]`, `block` refuses the call (`-32012`), `tag`
  counts only. Per-server globs and categories.
- **Data residency.** Servers declare a `region`; `compliance.residency.rules` pin tenants to region globs. Calls
  (including federation failover and `<id>@<peer>` calls) that would leave the allowed regions are refused
  (`-32011`).
- **Compliance reports.** `GET /api/v1/compliance/report?framework=soc2|gdpr` (JSON or `format=md`) maps
  configuration and request history to SOC 2 criteria / GDPR articles with pass / warn / fail and evidence.
  `GET /api/v1/compliance` shows PII findings and blocks. The GitHub Pages demo serves the new endpoints.
- `scanPii`, `ComplianceEngine`, `buildReport`, `reportMarkdown` exported.

## [3.6.0] - 2026-10-08

### Added
- **Federated gateways.** `federation:` peers gateways across regions. Requests between peers are signed with
  HMAC-SHA256 over a shared secret (`x-mcp-federation`, ±5 min skew); only configured peer ids are accepted.
- **Catalog sync:** each gateway exports servers matching `federation.export` (status, tool names) at
  `GET /api/v1/federation/catalog` and pulls its peers' catalogs every `sync.intervalSeconds` (filtered by `import`).
- **Cross-region failover:** calls to a local server matching `failover.servers` that is not connected go to the best
  healthy peer exporting it online (priority, then latency); the peer runs them through its own policy, quotas and
  audit as `peer:<gatewayId>`, and never forwards them again.
- **Remote servers:** `POST /api/v1/tools/call` with `server: "<id>@<peer>"`.
- `GET /api/v1/federation`, `POST /api/v1/federation/sync`. `Federation`, `signFederation`, `verifyFederation`
  exported. The GitHub Pages demo serves the new endpoints.

## [3.5.0] - 2026-10-08

### Added
- **Secrets management.** `secrets.providers`: HashiCorp Vault KV v2 (token or AppRole, namespaces), AWS KMS
  (`Decrypt`, SigV4), Google Cloud KMS, files, and env. `secret://<provider>/<path>[#field]` references in server
  `env`, `headers`, `url` and `args` are resolved at (re)connect; the registry, `GET /servers`, the audit log and
  config diffs only ever see references. A provider outage keeps serving the last good value.
- **Token rotation:** `secrets.rotation.intervalSeconds` re-reads references and reconnects servers whose
  credentials changed; `POST /api/v1/secrets/rotate` does it on demand.
- **Per-tenant injection:** `servers[].inject` adds a credential per call (tool argument or `_meta`), templated with
  `{tenant}` / `{client}`, after plugins, policy, cache keys and request capture. Missing tenant → `-32010`.
- `GET /api/v1/secrets` (references, versions, rotation times — no values). `SecretManager` and the providers are
  exported. The GitHub Pages demo serves the new endpoints.

### Security
- Resolved values never appear in API responses, the request log, the audit log or the replay debugger.

## [3.4.0] - 2026-10-08

### Added
- **Traffic splits (canary / A-B).** `routing.splits` sends a weighted share of the calls for a server (optionally
  only matching `tools`) to other servers that expose the same tools. Sticky per client by default (stable hash),
  or random per call (`sticky: none`). Disconnected variants get no traffic.
- **Automatic canary rollback:** a variant `guard` (`maxErrorRate`, `maxLatencyMs`, `minCalls`) rolls the variant
  back to weight 0 when it trips; `POST /api/v1/routing/splits/:name/reset` re-enables it.
- **`loadBalancing.strategy: smart`:** replicas ordered by a weighted score of EWMA latency, EWMA error rate and a
  per-member `cost` (`loadBalancing.score`).
- `GET /api/v1/routing`; spans carry `mcp.route.split` / `mcp.route.variant`. `SmartRouter` exported. The GitHub
  Pages demo serves the new endpoints.

## [3.3.0] - 2026-10-08

### Added
- **WASM plugin sandbox.** A `plugins:` entry with `wasm: ./plugin.wasm` (instead of `module:`) runs a WebAssembly
  module — Rust, TinyGo, AssemblyScript, C, Zig… — in a worker thread with no WASI and no host access (only
  `env.log`). Small JSON ABI: `alloc`, `on_tool_call`, `on_response` (deny / rewrite arguments / respond / replace
  result).
- **Per-tenant isolation:** `isolation: tenant` (default) | `client` | `shared` — one sandbox (worker + module
  instance) per key, so tenants never share memory or globals. `limits`: `timeoutMs` (100), `memoryMb` (16),
  `maxInstances` (64, LRU).
- `GET /api/v1/plugins` (operators): plugins, hooks, kind, and live WASM sandboxes. `PluginCall.tenant`.
  `WasmPlugin`, `loadWasmPlugin` exported. The GitHub Pages demo serves the new endpoint.

### Security
- Fail closed: traps, timeouts, memory overruns and invalid output refuse the call (`-32006`); the sandbox is
  recreated on the next call. Modules with any import other than `env.log` are refused at load.

## [3.2.0] - 2026-10-08

### Added
- **Request replay & debugger.** `replay.enabled` keeps the redacted arguments and results of recent calls in memory
  (`maxEntries`, `maxBytes`, `results`). `GET /api/v1/requests/:id` shows a captured call;
  `POST /api/v1/requests/:id/replay` runs it again — same or edited `arguments` / `server` — with the caller's own
  credentials through the full pipeline, and returns both results with a structural `diff`. Replays are captured
  too and point back via `replayOf`.
- **Dashboard:** History rows open a request dialog (arguments, result, metadata) with an editable-arguments
  **Replay** button and a highlighted diff; works at mobile width. The GitHub Pages demo simulates it.
- `POST /tools/call` responses carry `requestId`. `ReplayRecorder`, `jsonDiff` exported.

### Fixed
- `PASSTHROUGH_METHODS`, `passthroughCapabilities` and the passthrough types (3.1) are now exported from the package
  root as the 3.1 notes said.

### Security
- Restricted clients only see / replay their own calls; captured payloads are redacted and never written to disk.

## [3.1.0] - 2026-10-08

### Added
- **Sampling / elicitation / roots passthrough.** Upstream servers can now ask the downstream MCP client for an LLM
  completion (`sampling/createMessage`), user input (`elicitation/create`) and its workspace roots (`roots/list`).
  The gateway announces these client capabilities upstream and relays each request to the MCP session whose call is
  in flight (on the call's SSE reply, or the session's `GET` stream), then returns the client's answer unchanged.
  `notifications/roots/list_changed` from a client is forwarded to the servers in its scope.
- Config: `mcp.passthrough` (`sampling`, `elicitation`, `roots`, `timeoutSeconds`; all on by default) and
  `servers[].passthrough: false` to isolate a server.
- Proxy API: `McpProxy.setClientRequestHandler()`, `notifyAll()`, `relaysTo()`, `RequestOptions.caller`;
  `PASSTHROUGH_METHODS`, `passthroughCapabilities()` exported.

### Notes
- Clients without the capability get `-32601`; REST calls have no client to ask (`-32001`, `roots/list` → `[]`).
- The gateway's own upstream progress token is stripped before the request reaches the client.
- Routing is by the gateway's upstream progress token; without it, only when all in-flight calls come from one client — a request never reaches another client.

## [3.0.1] - 2026-10-08

Patch release: bug sweep of the 1.3 – 3.0 features and the dashboard demo.

### Fixed
- **Dashboard:** pending approvals, workspaces and the server catalog were laid out inside the 8px status-dot
  column of the list grid (stacked meta, stretched Approve button, unusable role selects), on desktop and at
  mobile width. They now use a row layout that wraps cleanly at ~390px.
- **Dashboard:** the workspaces card threw when a tenant had neither `serverIds` nor `servers`.
- **Dashboard:** quotas, load-balancing groups and the result cache (1.8 / 2.1 / 2.2) had no UI; the Servers view
  now shows them (operator views, hidden when the endpoint is unavailable), with a cache Purge button.
- **Demo (GitHub Pages):** the simulated backend reported v1.2.0 and had no `/quotas`, `/usage`, `/cache`,
  `/load-balancing`, `/policy`, `/servers/:id` or `/admin/deprecations`; the single demo approval never came back
  after approve / deny. All added; the version now follows the package.
- **Redis state store:** a failed `AUTH` / `SELECT` left the half-initialised connection in place, so the next
  command ran unauthenticated / on the wrong database instead of re-authenticating.
- **Hot reload:** if the config file was briefly missing (atomic save, delete + recreate) the watcher failed to
  re-attach once and hot reload stopped for good. It now retries and reloads when the file is back.
- **Policy files:** merging `policy.files` was not idempotent, so a `GET → PUT /admin/config` round trip (or a
  diff against it) duplicated every file rule and test. File rules already present are now replaced, not appended.
- **OpenAI bridge:** an unreachable or timed-out `openai.upstream` returned `500 Internal Server Error`; it now
  returns `502 Bad Gateway` / `504 Gateway Timeout`.

### Tests
- Regression tests for each fix, plus `test/dashboard.test.ts` (i18n key parity, demo backend endpoints and
  version, row layout).

## [3.0.0] - 2026-10-07

**Breaking release.** Config schema v3, the 2.9 deprecations removed, plugin API v2. Migration:
[docs/guides/migrating-to-v3.md](docs/guides/migrating-to-v3.md). Roadmap: [docs/ROADMAP.md](docs/ROADMAP.md).

### Breaking
- `corsOrigins` removed → `cors.origins`; `healthCheckIntervalMs` removed → `health.intervalMs`. Old keys are
  validation errors that name the replacement.
- Config schema v3: `version`, when set, must be `3`.
- A2A: `/.well-known/agent.json` removed → `/.well-known/agent-card.json`.
- Plugin API v2 (`PLUGIN_API_VERSION = 2`): hooks receive a hook context (`{ plugin, logger, gatewayVersion,
  apiVersion }`) as their last argument. v1 plugins still load with a deprecation warning (removed in 4.0).
- TypeScript: `GatewayConfig.corsOrigins` / `healthCheckIntervalMs` removed. `/admin/deprecations` entries carry
  their own `removedIn`.

### Added
- Plugin `onError(call, error, hook)` hook (observe-only, never fails a call).
- `docs/ROADMAP.md` (3.1 – 4.0 plan), migration guide, docs refreshed for the v3 schema.

Unchanged: REST `/api/v1`, `/mcp`, JS / Kotlin clients (2.x work against 3.0), Node 22+, Docker `node:22-alpine`,
dashboard CSP.

## [2.9.0] - 2026-10-07

Admin REST API, declarative config (`mcp-gateway diff` / `apply`) and 3.0 deprecation warnings.

### Added
- **Admin API** (`/api/v1/admin`, operators only): `GET config` (secrets redacted), `POST config/validate`,
  `POST config/diff`, `PUT config[?dryRun=true]` (hot-apply), `POST reload` (re-read the file), `GET deprecations`.
  Writes need `admin.configApi: true`. `<redacted>` values keep the running value.
- **`mcp-gateway diff`** (against a running gateway, or another file with `--against`; exit 3 on changes) and
  **`mcp-gateway apply [--dry-run]`**; `--url` / `--key` or `MCP_GATEWAY_URL` / `MCP_GATEWAY_ADMIN_KEY`.
- 3.0 config names accepted now: `cors.origins`, `health.intervalMs`; optional `version: 2`.

### Deprecated (removed in 3.0)
- `corsOrigins` → `cors.origins`; `healthCheckIntervalMs` → `health.intervalMs`.
- `/.well-known/agent.json` → `/.well-known/agent-card.json` (responses carry `Deprecation: true`).
- Warnings are logged at startup, printed by `mcp-gateway validate` and listed by `GET /api/v1/admin/deprecations`.

- Docs: [Declarative config](docs/guides/declarative-config.md).

## [2.8.0] - 2026-10-07

Policy as code and audit export to SIEMs.

### Added
- **Policy files** (`policy.files`): YAML / JSON rule files (relative to the config) appended after inline rules;
  optional `default` and `tests`. Re-read on every config reload; invalid files reject the reload.
- **Policy tests**: `policy.tests` / file `tests` (`call`, `expect`, optional `rule`) and the
  `mcp-gateway policy test [--json]` command (exit 1 on failure) for CI.
- **SIEM export** (`audit.export`): RFC 5424 syslog over UDP / TCP (octet counting) / TLS, and batched HTTP webhooks
  (JSON or NDJSON) with retries, a bounded queue, `failuresOnly` and `kinds` filters. Works with or without the
  SQLite audit store. `Gateway#auditExportStats()` / `flushAuditExport()`.
- Docs: [Policy as code and SIEM export](docs/guides/policy-as-code.md).

## [2.7.0] - 2026-10-07

Bridges: OpenAI-compatible tools proxy and A2A agent card.

### Added
- **OpenAI-compatible tools proxy** (`openai:`): `GET /openai/v1/tools` (function tools + name mapping),
  `POST /openai/v1/tool_calls` (execute `tool_calls`, get `role: "tool"` messages) and
  `POST /openai/v1/chat/completions` (forward to `openai.upstream`, inject gateway tools, run the tool loop up to
  `maxToolRounds`; caller-supplied tools are returned untouched; `stream: true` passes through).
- **A2A bridge** (`a2a:`): Agent Card at `/.well-known/agent-card.json` (and `/.well-known/agent.json`), one skill per
  visible tool; JSON-RPC `message/send` / `tasks/get` at `a2a.path` (default `/a2a`); results as A2A Tasks with
  artifacts.
- Bridge calls run through the regular REST checks (auth, scopes, tenants, policy, quotas, cache, output filter).
- `validateConfig()` exported from the config loader.
- Docs: [Bridges](docs/guides/bridges.md).

## [2.6.0] - 2026-10-07

Edge runtimes: Cloudflare Workers, Deno and Bun adapters for the HTTP transport.

### Added
- **`@winstonsayno/mcp-gateway/edge`** (new package export): a dependency-free Fetch-API gateway —
  `createEdgeGateway({ servers, apiKeys, toolNaming, corsOrigins })` → `fetch(request)`. Fronts remote Streamable
  HTTP upstreams (sessions, JSON and SSE replies, paging, re-initialize on `404`), aggregates tools (collision or
  always-prefixed names, per-server allow / deny), serves `/mcp` (initialize, ping, tools/list, tools/call, batches;
  stateless JSON) and `GET /api/v1/health`, `GET /api/v1/tools`, `POST /api/v1/tools/call`. API keys plain or
  `sha256:` (Web Crypto), constant-time compare, CORS.
- **Adapters**: `workersHandler()` (Cloudflare Workers module syntax, config from bindings), `serveDeno()`,
  `serveBun()`, `serveNode()`; `configFromEnv()`. Examples in `examples/edge` (worker + `wrangler.toml`, Deno, Bun).
- Docs: [Edge runtimes](docs/guides/edge.md).

## [2.5.0] - 2026-10-07

Usage quotas and metering export.

### Added
- **`quotas.rules`**: tool-call limits per `hour` / `day` / `month` (UTC calendar periods), per client (default, with
  `clients` globs) or per tenant (`per: tenant`, shared pool), optionally for some `servers` / `tools`. Over quota →
  `-32007`; REST `429` + `Retry-After` + quota details. Checked after the policy, before cache and upstream.
- **Metering**: every tool call is counted in hourly buckets per client, tenant, server and tool (calls, errors,
  duration). `GET /api/v1/usage` exports JSON or CSV (`format=csv`, formula-injection safe) grouped by `client`,
  `tenant`, `server`, `tool`, `hour`, `day`, with `since` / `until` / `client` / `tenant` / `server` filters;
  `quotas.meteringRetentionDays` (35).
- `GET /api/v1/quotas` — live counters with `resetsAt`. Tenant admins / owners can read their own tenant's usage.
- Exports: `UsageMeter`, `usageCsv`, `periodBounds`, `ERR_QUOTA_EXCEEDED`.

## [2.4.0] - 2026-10-07

Upstream catalog / registry with one-click add.

### Added
- **`catalog:`** — built-in entries for the reference MCP servers (filesystem, memory, everything,
  sequential-thinking, fetch, git, time, GitHub remote) plus `sources` (JSON files or URLs) merged by id.
- **One-click install** (`catalog.install: true`, off by default): `POST /api/v1/catalog/:id/install` with `serverId`,
  `env` (process env for stdio, `${VAR}` substitution for remote `url` / `headers`) and `args`; validation of required
  inputs; `409` on id clashes. `DELETE /api/v1/catalog/servers/:id` removes it. Operator keys only.
- `catalog.serversFile` persists installed servers (atomic write, mode 600) and loads them on start; they survive hot
  reloads; config-file ids win on clashes.
- **Dashboard**: *Add a server* card on the Servers tab (prompts for id, env and args; shows where an entry is
  installed), also in the demo (read-only).
- Exports: `Catalog`, `InstalledServers`, `BUILTIN_CATALOG`, `buildServerConfig`, `loadCatalogSource`.

## [2.3.0] - 2026-10-07

Tenants / workspaces with role-based access control.

### Added
- **`tenants:`** — workspaces that own servers (`servers` globs) and members (client id globs) with roles
  **owner / admin / viewer**. Members are confined to their tenants' servers on top of their key / token scope; tool
  calls (REST and `/mcp`) need `admin` or `owner` on the server's tenant (viewers are read-only: `403` / `-32003`).
  Clients outside every tenant keep operator access.
- Tenant-aware approvals: admins / owners list and decide held calls for their tenants' servers only.
- **API**: `GET /api/v1/tenants[/:id]`, `PUT /api/v1/tenants/:id/members`, `DELETE /api/v1/tenants/:id/members/:client`
  (owners / operators; last owner protected; runtime changes are not persisted). MCP sessions pick up membership
  changes.
- **Dashboard**: *Workspaces* card (role badges, member role selectors for owners), also in the demo.
- Hot reloadable; exports `withTenantScope`, `membershipsOf`, `roleIn`, `canCall`, `ROLE_RANK`.

## [2.2.0] - 2026-10-07

Tool result caching and in-flight de-duplication.

### Added
- **`cache:`** — per-tool opt-in result cache (`rules` by server / tool glob, `ttlSeconds`, `scope: client | shared`),
  LRU bounded by `maxEntries`, `defaultTtlSeconds`. Keys use canonical argument JSON; only successful, non-`isError`
  results are stored. Refused calls never reach it; the output filter and `onResponse` hooks run on cached results.
- **In-flight de-duplication** (`dedupe`, default on for cached tools; `dedupeOnly` to share without caching).
- `GET /api/v1/cache` stats, `DELETE /api/v1/cache[?server=]` purge; trace attribute `mcp.cache` (`hit` / `miss` /
  `shared`); hot reload purges the cache when `cache:` changes.
- Exports: `ToolCache`, `canonicalJson`, and `LoadBalancer` / `expandReplicas` (missing from the 2.1 entry point).

## [2.1.0] - 2026-10-07

Multi-upstream load balancing, failover and member health checks.

### Added
- **`servers[].replicas`**: extra upstream endpoints for one logical server (each overrides transport fields of the
  primary — `url`, `command`, `args`, `env`, `headers`, `transport` — plus `weight`). Replicas are connected as
  internal servers `<id>~<n>` (`replicaOf`), supervised and reconnected individually; their tools are served under the
  logical id only (a replica's tool list stands in while the primary has none).
- **`servers[].loadBalancing`**: `strategy` `round-robin` (default) / `random` / `weighted` / `least-latency` (EWMA) /
  `failover`; `failoverOn` (`not-connected` default, opt-in `timeout` / `error`), `retries`, passive ejection after
  `ejectAfter` consecutive failures for `ejectMs`.
- Health-aware routing: the periodic ping runs on every member; disconnected, `degraded` / `offline` and ejected
  members are skipped (all are tried when none is healthy). REST and `/mcp` accept calls while any member is up.
- `GET /api/v1/load-balancing` (operator): members, connection, health, latency, calls / errors, ejections.
  Trace attributes `mcp.upstream.id` / `mcp.upstream.attempts`.
- `LoadBalancer`, `expandReplicas` exported for embedders. `"~"` is now reserved in server ids.

## [2.0.0] - 2026-10-07

Plugins and signal-driven reloads. **Breaking** — see [docs/guides/migrating-to-v2.md](docs/guides/migrating-to-v2.md).

### Breaking
- **Node.js ≥ 22** (`engines.node`); CI runs on Node 22 and 24 (the JS client on 20 / 22 / 24). Docker stays on `node:22-alpine`.
- **`SIGHUP` reloads the configuration** (also with `--no-watch`) instead of terminating the process.
- Plugin refusals add JSON-RPC **`-32006`** to the policy error codes the REST API maps to `403`.

### Added
- **Plugin hooks** (`plugins:` config, or `new Gateway(config, { plugins })`): `onRequest` Express middleware (after the
  network guards, before CORS / auth / routes), `onToolCall` before the policy rules (rewrite arguments, `deny`, or
  `respond` without contacting the server), `onResponse` after the output filter (replace the result), `close`.
  Module paths resolve against the config file; factory exports get `ctx.options`, `ctx.logger`, `ctx.apiVersion`.
  Hooks fail closed (`-32006`); a plugin requiring a newer plugin API is refused. `PLUGIN_API_VERSION = 1`.
- **Hot reload of `plugins:`** — changed entries are reloaded and the old instances closed; a broken plugin keeps
  the current set. `ConfigWatcher.reloadNow()`; `Gateway.getPlugins()`.
- Clients 2.0.0: `isPolicyError` covers `-32006`.
- Docs: [Plugins](docs/guides/plugins.md), [Migrating to v2](docs/guides/migrating-to-v2.md).

## [1.7.0] - 2026-10-07

Clients 1.7: policy-aware JS and Kotlin clients, release-ready packaging.

### Added
- **JS client 1.7.0** (`@winstonsayno/mcp-gateway-client`): `approvals()`, `approve(id, reason?)`, `deny(id, reason?)`;
  `GatewayError.code` and `GatewayError.isPolicyError` for `-32003` (policy denied), `-32004` (approval rejected) and
  `-32005` (output blocked). The client version now follows the gateway version.
- **Kotlin client 1.7.0** (`io.github.harrisoncn:mcp-gateway-client`): same approvals API and `GatewayException.code` /
  `isPolicyError`; Maven Central ready POM (license, SCM, developers), sources + javadoc jars, in-memory PGP signing
  when a key is supplied, local `staging` repository for Central Portal bundles; `-PreleaseVersion` override.
- **`.github/workflows/clients-publish.yml`**: on release, publishes the JS client to npm (`NPM_TOKEN`) and the Kotlin
  client to Maven Central (`MAVEN_CENTRAL_USERNAME` / `MAVEN_CENTRAL_PASSWORD` / `SIGNING_KEY` / `SIGNING_PASSWORD`);
  each job is skipped with a notice when its secrets are missing.

## [1.6.0] - 2026-10-07

Tool policy: argument rules, human approval and output filtering.

### Added
- **`policy.rules`** — ordered allow / deny / approve rules per client (`clients` globs on client ids), server and
  tool, with argument conditions on dotted paths: `exists`, `equals`, `in`, `glob`, `notGlob`, `regex`, `notRegex`,
  `longerThan`, `under` / `notUnder` (path containment after resolving `..`). First match wins; `policy.default`
  (allow) applies otherwise. Enforced for REST and `/mcp` tool calls; refusals are recorded in the request / audit
  log. REST `403` + `code: -32003` + `policy.rule`; `/mcp` JSON-RPC `-32003` with `data.rule`.
- **Human approval** (`effect: approve`): the call is held until an operator approves or denies it, or
  `policy.approval.timeoutSeconds` (300) passes. `GET /api/v1/approvals[/:id]`, `POST /api/v1/approvals/:id/approve|deny`
  (with optional `reason`), self-approval refused unless `allowSelfApproval`, cancelled when the client disconnects.
  Dashboard: *Pending approvals* card with Approve / Deny (also in the demo). Rejections → `403` / `-32004`.
- **Output filtering** (`policy.outputFilter`): built-in prompt-injection detectors (instruction override, fake role
  tags, system-prompt exfiltration, tool hijack, markdown-image exfiltration, hidden Unicode) plus custom `patterns`;
  `action` `redact` (default) / `flag` (annotate `_meta["mcp-gateway/flags"]`) / `block`; per-tool scoping.
  `GET /api/v1/policy` reports rules, pending approvals and findings per detector.
- Policy settings are validated at load (regexes compile) and hot reloadable.

## [1.5.0] - 2026-10-07

Observability: tracing, a Prometheus latency histogram and more dashboard charts.

### Added
- **Optional distributed tracing** (`observability.tracing`): one span per upstream call (tools, `resources/read`,
  `prompts/get`) from REST and `/mcp`, W3C Trace Context (`traceparent` in → child span, `traceparent` out on the
  response), attributes `mcp.server.id` / `mcp.tool.name` / `mcp.via` / `mcp.client.id` / `mcp.duration_ms` /
  `mcp.success` / `mcp.error.code`. Exporters: built-in batched **OTLP/HTTP JSON** (`endpoint`, `headers`,
  `serviceName`, `resourceAttributes`, `sampleRatio`; honours `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`), `console`, or
  `otel-api` (delegates to `@opentelemetry/api` and your registered SDK). No new dependency.
- **`GET /metrics`**: conventional Prometheus scrape path when `monitor.prometheus` is on (respects
  `auth.protect.metrics`), plus a per-server latency histogram `mcp_gateway_request_duration_seconds`.
- **Dashboard**: *Calls per server* chart (calls, errors, p95) next to request rate, latency, error rate, top tools and
  usage per key (also in the GitHub Pages demo).
- `ToolInvoker`: a single pipeline for every upstream call (REST + `/mcp`) — metrics, request log and tracing live in
  one place (the hook point for upcoming policy, caching and plugin features). Exported for embedders together with the
  tracing helpers.

## [1.4.0] - 2026-10-07

Multi-instance deployments: a pluggable shared state store.

### Added
- **`state` config block** with a pluggable `StateStore` (`memory` default, `redis`):
  - Built-in Redis adapter (RESP2 client, pipelining, `MULTI`/`EXEC`, `AUTH` incl. ACL user, `SELECT`, `rediss://`
    TLS, connect / command timeouts, lazy reconnect) — no new dependency. `keyPrefix` namespaces several gateways.
  - **Shared rate limits**: global and per-key sliding windows are counted in the store, so limits hold across replicas
    (denied requests are not counted).
  - **Shared brute-force lockout**: failures on any replica count, a locked IP is locked everywhere.
  - **Shared MCP sessions**: session metadata is stored with the idle TTL; a session opened on one replica is adopted
    by the others (same client only) — no sticky sessions for `POST /mcp`. `DELETE` removes it cluster-wide.
  - `state.failureMode`: `open` (default; a Redis outage lets requests through, logged at most every 10 s) or `closed`.
  - `MCP_GATEWAY_REDIS_URL` environment override; `/api/v1/health` reports `state`.
- Embedding: `new Gateway(config, { stateStore })` accepts any `StateStore`; `createStateStore`, `MemoryStateStore`,
  `RedisStateStore`, `RedisClient`, `createStoreRateLimiter`, `StoreAuthLockout` are exported. `OAuthVerifier` and the
  OAuth metadata helpers are exported too.
- CI runs the state tests against a real Redis service container (`REDIS_URL`).
- Docs: *Shared state* (configuration), *Multiple instances* (deployment).

### Changed
- `RateLimiter.take()` and the lockout tracker may be asynchronous (`LockoutTracker` interface); in-memory behaviour
  is unchanged.

## [1.3.0] - 2026-10-07

MCP authorization (OAuth 2.1) and resumable streams.

### Added
- **`auth.strategy: oauth2`** — the gateway is an OAuth 2.1 protected resource per the MCP authorization spec
  (2025-06-18):
  - RFC 9728 *Protected Resource Metadata* at `/.well-known/oauth-protected-resource` and
    `/.well-known/oauth-protected-resource/<mcp path>` (`resource`, `authorization_servers`, `scopes_supported`,
    `bearer_methods_supported`, `resource_signing_alg_values_supported`).
  - Bearer token validation: JWTs against `auth.oauth.jwksUrl` or the `jwks_uri` discovered from the issuer's RFC 8414 /
    OpenID metadata (asymmetric algorithms only, `exp` required, `iss` and `aud` = resource URI per RFC 8707), or RFC
    7662 token introspection for opaque tokens (client-secret basic auth, cached up to `cacheSeconds` / token expiry).
  - RFC 6750 challenges: `401` + `WWW-Authenticate: Bearer resource_metadata="…"` (with `error="invalid_token"` when a
    token was presented), `403` + `error="insufficient_scope", scope="…"` for missing `requiredScopes`.
  - `mcp_servers` / `mcp_tools` claims scope OAuth clients like JWT clients; client ids are `oauth:<sub>`.
  - `GET /api/v1/security` reports OAuth settings; new `oauth-no-resource` hint.
- **Streamable HTTP resumability**: events on the `GET` SSE stream carry session-wide ids and are buffered per session
  (`mcp.eventBufferSize`, default 256, `0` = off). Reconnecting with `Last-Event-ID` replays missed events, including
  ones emitted while no stream was open (previously dropped).
- `docs/configuration.md`: *OAuth 2.1* section and resumability notes.

### Changed
- `auth.strategy: oauth2` now requires `auth.oauth`; the old unused `auth.oauth2 { issuer, audience }` type was removed
  (it was never accepted by the config loader).

## [1.2.0] - 2026-10-07

Security hardening and more of the MCP spec on `/mcp`. Every new protection that could reject traffic that 1.1
accepted is **opt-in**; see *Upgrade notes*.

### Security
- **Hashed API keys**: `auth.apiKeys` entries (plain strings or `key`) may be `sha256:<64 hex>` digests, so the config
  file never holds a usable key. Digest and plain form of a key share the same client id. New CLI commands
  `mcp-gateway gen-key` (random `mgw_…` key + digest, `--bytes`, `--prefix`, `--json`) and
  `mcp-gateway hash-key [key]` (reads stdin when no argument is given). Malformed `sha256:` values are a config error.
- **Key expiry / disabling**: `expiresAt` (ISO 8601) and `disabled` on object keys → `401`; open `/mcp` sessions of
  such keys end on the next reload. Keys expiring within 7 days produce a warning.
- **JWT hardening** (`auth.jwt`): `issuer`, `audience` (string or list), `algorithms` allowlist, `clockToleranceSeconds`,
  `requireExp`, `maxTokenAgeSeconds`; verification keys from `jwtSecret` (HS*), a PEM `publicKey` (RS/PS/ES/EdDSA) or
  a `jwksUrl` (HTTPS, cached `jwksCacheSeconds`, refetch on unknown `kid`). HMAC and asymmetric algorithms are never
  mixed (algorithm-confusion protection); exactly one key source must be configured.
- **Security headers** (`security.headers`, default on): `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`,
  `Referrer-Policy: no-referrer`, `Cross-Origin-Opener-Policy`, `Cross-Origin-Resource-Policy`, a deny-all CSP on API
  responses and a dashboard CSP that allows exactly its inline script by SHA-256 hash. Optional `security.hsts`.
- **Network guards**: `security.ipAllowlist` (IPv4 / IPv6 / CIDR, via `net.BlockList`), `security.allowedHosts` (Host
  header allowlist with `*.domain` wildcards), `security.trustProxy` (Express "trust proxy": decides `req.ip` for rate
  limits, lockout, allowlist and logs). Liveness / readiness probes stay reachable.
- **DNS-rebinding protection** (`security.dnsRebindingProtection`): Host must be a loopback name / the bind address
  (or `allowedHosts`), and `/mcp` accepts browser `Origin`s only when same-origin, loopback or explicitly listed.
- **Size limits**: `security.maxBodyBytes` (default 10 MiB as before, now configurable for REST and `/mcp`) and
  `security.maxToolArgumentsBytes` for `tools/call`, `prompts/get` and `completion/complete` arguments (`413` on REST,
  `-32602` on `/mcp`).
- **Brute-force lockout** (`security.authLockout`): after `maxFailures` (10) failed authentications from one IP within
  `windowSeconds` (300), the IP gets `429` + `Retry-After` for `lockoutSeconds` (900) on every authenticated route,
  including `/mcp` and `/api/v1/events`.
- **Secret redaction**: log lines and metadata, recorded `errorMessage`s (request log, audit log, `/requests`,
  `/stats`, `/events`, dashboard) mask Bearer / Basic tokens, JWTs, common provider keys (OpenAI, Anthropic, GitHub,
  GitLab, Slack, AWS, Google), `password=` / `token=` / `api_key=` pairs, URL credentials and values under
  secret-looking keys. `GET /servers` now also masks secret-looking stdio `args` (`--token x`, `--api-key=x`). Extra
  patterns via `security.redactPatterns`.
- **Secure-defaults check**: startup warnings / hints (auth off on a public bind, DNS rebinding, `/mcp` open to any
  origin, plain-text / short / expiring keys, JWT without iss / aud / exp, no lockout, `corsOrigins: ["*"]` with auth,
  headers disabled, error details exposed). `mcp-gateway validate` prints them; `--strict` exits with code 2.
- `GET /api/v1/security`: auth strategy, warnings, key hygiene counts and upcoming expiries, JWT settings, effective
  security settings and lockout state — never key material; scoped clients get `403`. The dashboard's *Connect*
  page shows it as a *Security posture* card (demo mock updated).
- `SECURITY.md`: hardening table and scope; `docs/deployment.md` security checklist extended.

### Fixed (security)
- Unexpected errors (500) no longer return their message and stack trace whenever `NODE_ENV` was not `production`
  (the default for `npm i -g` installs). They are shown only with `NODE_ENV=development` or the new
  `security.exposeErrorDetails: true`. Deliberate `GatewayError` details are unchanged.

### Added (MCP)
- **Progress notifications**: a single `tools/call` with `params._meta.progressToken` from a client that accepts
  `text/event-stream` is forwarded with a gateway-generated token; upstream `notifications/progress` are mapped back
  and the reply becomes an SSE stream (progress events, then the result). Plain JSON otherwise.
- **Logging**: `logging` capability, `logging/setLevel` per session; upstream `notifications/message` are forwarded to
  sessions in scope at or above their level (`logger: "<serverId>/<logger>"`), and upstream servers announcing
  `logging` are set to the most verbose level any session requested (re-applied after reconnects).
- **Completion**: `completions` capability and `completion/complete` routed by prompt (exposed name translated back)
  or resource template / URI; servers without the capability answer an empty completion.
- **Resource subscriptions**: `resources.subscribe` capability, `resources/subscribe` / `resources/unsubscribe`
  (routed like `resources/read`; `-32601` when the owning server does not support subscriptions) and
  `notifications/resources/updated` forwarding. One upstream subscription per (server, URI) is shared and
  reference-counted across sessions, released when the last session unsubscribes or ends, and restored after an
  upstream reconnect.
- Proxy: `RequestOptions.onProgress`, `connected` and `notification` events.
- Library exports: `hashApiKey`, `isHashedKey`, `buildJwtVerifier`, `HMAC_ALGORITHMS`, `ASYMMETRIC_ALGORITHMS`,
  `redactString`, `redactValue`, `redactArgs`, `configureRedaction`, `securityWarnings`, `AuthLockout`,
  `createIpMatcher`, `hostAllowed`, `dashboardCsp`, `inlineScriptHashes`, `LOG_LEVELS`; types `SecurityConfig`,
  `JwtConfig`, `AuthLockoutConfig`, `SecurityWarning`, `McpLogLevel`, `RequestOptions`, `ProgressUpdate`.

### Changed
- `auth.jwtSecret` is no longer required for `strategy: jwt` when `auth.jwt.publicKey` or `auth.jwt.jwksUrl` is set.
- `initialize` on `/mcp` now also announces `logging`, `completions` and `resources.subscribe` (clients ignore
  capabilities they do not use).
- JWT verification failures are logged with the client IP.

### Upgrade notes
- No configuration changes are required. New behaviour that is on by default: security headers (disable with
  `security.headers: false`), secret redaction in logs / recorded error messages, hidden 500 error details, and the
  extra capabilities on `/mcp`.
- If you embedded the dashboard in an `<iframe>` on another origin, set `security.headers: false` (the new
  `frame-ancestors 'none'` / `X-Frame-Options: DENY` block that).
- Tests or tooling that relied on 500 responses carrying `error.message` / `details` outside production need
  `NODE_ENV=development` or `security.exposeErrorDetails: true`.
- Everything else (`ipAllowlist`, `allowedHosts`, `dnsRebindingProtection`, `authLockout`, `maxToolArgumentsBytes`,
  `hsts`, `trustProxy`, JWT checks, key expiry) is opt-in.

## [1.1.0] - 2026-10-07

### Added
- **Dashboard v2** (`/dashboard`, still one self-contained HTML file: no build step, no CDN, no runtime dependencies):
  - First-run **guided onboarding** (dismissible, reopen with **?**): connect with an API key (tested live), see the upstream servers, try a tool (`tools` list → form generated from the tool's JSON schema, or raw JSON → call → result), and copy-paste snippets for Claude Desktop (via `mcp-remote`), Cursor, Claude Code, the JS and Kotlin clients and curl, all pointing at this gateway's `/mcp` URL.
  - **Live overview**: requests/min, p50 / p95 / p99 latency, error rate and servers-online cards with sparklines; hand-drawn SVG charts for request rate, latency and error rate (5 m / 15 m / 1 h / 6 h windows, hover / touch tooltips); top tools; usage per API key; live request stream; server health.
  - Servers page with tool chips and one-click reconnect; Playground; request history with filters and cursor paging (cards on phones); Connect page.
  - English / 中文 toggle, dark / light theme, responsive down to phone widths with a bottom tab bar, keyboard navigation (arrow-key tabs, focus-trapped dialog, Esc), `prefers-reduced-motion`, View Transitions, skeleton loaders; animations use transform / opacity only.
- `GET /api/v1/stats`: windowed time series (count, errors, p50 / p95 per bucket), summary, top tools, per-server and per-client usage (`?window=`, `?bucket=`).
- `GET /api/v1/events`: Server-Sent Events stream with a `request` event per recorded call and a `snapshot` (server health + summary) every 2 s; heartbeats, max 50 concurrent streams, closed on shutdown. Both new endpoints require auth and show restricted clients only their own calls. The dashboard falls back to polling every 2 s when the stream is unavailable.

## [1.0.1] - 2026-10-07

Bug-fix release; no API or configuration changes.

### Fixed
- A server whose MCP handshake (`initialize` → `notifications/initialized` → `tools/list`) was still in progress was already reported as connected: `mcp_gateway_server_up` / `up` in `/api/v1/metrics` showed `1`, `/health/ready` counted it, and REST / `/mcp` calls could be forwarded to it before `initialize` had been answered. `McpProxy#isConnected` and `McpProxy#request` now require a completed handshake (calls during it get the usual "not connected" / `503`).
- Flaky tests: `GET /api/v1/tools?format=mcp` assertion depended on server connect order; the reconnect-metrics test could observe a handshaking server as up (fixed by the above).

### Changed (maintenance)
- Dependabot ignores semver-major updates (npm root + JS client, Gradle) and keeps the Docker base image on Node 22; majors are adopted deliberately.

## [1.0.0] - 2026-10-07

First stable release. From here on mcp-gateway follows semver: `/api/v1`, `/mcp`, configuration keys, CLI and
root library exports only change in backward-compatible ways within 1.x (see
[docs/api-reference.md#stability-and-versioning](docs/api-reference.md#stability-and-versioning)).
This release contains everything developed as v0.5 – v0.8.

### Added
- **Documentation** in `docs/`: API reference (REST, `/mcp`, error codes, stability policy), configuration reference and deployment guide (Docker, Kubernetes manifests, reverse proxy, security checklist, systemd).
- **Container image** workflow `.github/workflows/docker.yml`: on release publish, builds `linux/amd64` + `linux/arm64` and pushes `ghcr.io/<owner>/mcp-gateway` tagged `<version>`, `<major>.<minor>`, `<major>` and `latest` (with provenance + SBOM).
- Dependabot config (npm root + JS client, Gradle Kotlin client, GitHub Actions, Docker), pull-request template, issue-template links, `SECURITY.md`.
- **Resources & prompts passthrough**: resources, resource templates and prompts of servers announcing those capabilities are listed at connect time and refreshed on `notifications/resources|prompts/list_changed`. REST: `GET /api/v1/resources`, `GET /api/v1/resources/templates`, `POST /api/v1/resources/read`, `GET /api/v1/prompts`, `POST /api/v1/prompts/get` (auto-routing, `409` on ambiguous prompt names, `403` out of scope, `502` / `503` / `504` like tool calls). `/mcp`: `resources/list`, `resources/templates/list`, `resources/read`, `prompts/list`, `prompts/get` (paginated; prompt names follow `toolNaming`; duplicate resource URIs collapsed, lowest server id wins; reads routed by URI, then template, then the only resource server), `resources` / `prompts` capabilities with `list_changed` notifications. Scopes apply by server. Rate limited and recorded with `kind: "resource" | "prompt"`.
- **Persistent audit log** (`audit: { enabled, path, retentionDays }`, default off): every request record is also written to SQLite through the built-in `node:sqlite` (Node 22.5+, no new dependency; clear startup error on older Node). Metadata only, never arguments or results. Hourly retention pruning.
- `GET /api/v1/requests` filters (`server`, `tool`, `client`, `success`, `via`, `kind`, `since`, `until`) and cursor paging (`nextCursor`), from the audit log when enabled, else the in-memory log; responses carry `source`. The dashboard's *Request History* panel has filters and *Load older*.
- JS client: `history()` (filters + cursor), `listResources`, `listResourceTemplates`, `readResource`, `listPrompts`, `getPrompt`.
- `SessionInfo.capabilities`; `McpProxy#getCatalog`, `#hasCapability`; registry `setCatalog` / `getAllResources` / `getAllResourceTemplates` / `getAllPrompts`; `MetricsCollector#setAuditStore` / `#queryRequests`; exports `SqliteAuditStore`, `sqliteAvailable`, `AuditStore`, catalog helpers and resource / prompt types.
- **LLM tool schemas**: `GET /api/v1/tools?format=openai|openai-responses|anthropic` returns function-calling definitions (`tools`) plus a `mapping` from LLM tool name to `{ server, tool }`. Names follow `mcp.toolNaming`, are sanitised to `^[a-zA-Z0-9_-]{1,64}$` and de-duplicated; scopes and `?server=` / `?tag=` apply. Exports `toLlmToolSchemas`, `sanitizeToolName`, `LLM_SCHEMA_FORMATS`.
- **TypeScript client** `@winstonsayno/mcp-gateway-client` in `clients/js` (not published): zero dependencies, `fetch`-based (browser + Node 18+), typed `health`, `ready`, `metrics`, `servers`, `server`, `reconnect`, `listTools`, `toolSchemas`, `callTool`, `callLlmTool`, `requests`, `GatewayError`; `connectMcp()` / `McpSession` helper for `/mcp` (pagination, SSE replies, cancellation). Own tests + an integration test against a real gateway.
- **Kotlin client** in `clients/kotlin` (not published): OkHttp 4.12 + kotlinx.serialization 1.6, Java 11 bytecode (Android-friendly), same API surface, `McpSession`; Gradle 8.7 wrapper and MockWebServer tests.
- CI jobs for both clients.
- **Per-key scopes**: `auth.apiKeys` entries may be objects `{ key, name?, servers?, tools?, rateLimit? }` (plain strings still mean full access). `servers` / `tools` are glob allow-lists (`tools` patterns containing `/` match `<serverId>/<tool>`); `rateLimit` gives the key its own bucket; `name` makes the client id `key:<name>`; `${VAR}` is expanded in object keys. JWTs carry scopes in the `mcp_servers` / `mcp_tools` claims. Enforced on REST (`/tools`, `/servers`, `/servers/:id` hide; `/tools/call`, `/servers/:id/reconnect` → `403`; auto-routing only among allowed servers; restricted keys see only their own `/requests`) and on `/mcp` (`tools/list` hides, `tools/call` → `-32003`, key rate limits). Hot reloadable: open `/mcp` sessions are notified, sessions of removed keys closed. Exports: `isServerInScope`, `isToolInScope`, `filterToolsByScope`, `scopeFromJwt`, types `AccessScope`, `ApiKeyConfig`.
- **Downstream MCP endpoint** `POST/GET/DELETE /mcp`: the gateway is now an MCP server over Streamable HTTP (protocol `2025-06-18`, `2025-03-26` accepted). Sessions via `Mcp-Session-Id` (bound to the authenticated key / JWT subject, idle expiry, LRU eviction at `maxSessions`), `initialize`, `ping`, aggregated and paginated `tools/list`, `tools/call` routed upstream, `notifications/tools/list_changed` on the `GET` SSE stream whenever the aggregated list changes, and `notifications/cancelled` propagated to the upstream server. JSON-RPC batches are accepted. Reuses auth, the rate limiter (per `tools/call`), `maxConcurrency`, timeouts, metrics and the request log. Origin validation (`mcp.allowedOrigins`, default `corsOrigins`) against DNS rebinding.
- `mcp` config block: `enabled`, `path`, `toolNaming` (`auto` — prefix `<serverId>__` only on name collisions — or `prefix`), `pageSize`, `sessionIdleTimeoutSeconds`, `maxSessions`, `allowedOrigins`, `instructions`. Everything except `enabled` / `path` hot reloads.
- `McpProxy.request()` for arbitrary upstream methods and an optional `AbortSignal` on `callTool()` (`ERR_CANCELLED`).
- Tool `title`, `outputSchema` and `annotations` are kept from upstream `tools/list` and exposed on `/api/v1/tools` and `/mcp`.
- Request records carry `via: "rest" | "mcp"`.
- Library exports: `McpEndpoint`, `buildToolIndex`, `prefixedName`, `DOWNSTREAM_PROTOCOL_VERSIONS`, `ERR_RATE_LIMITED`, types `McpEndpointConfig`, `ToolNaming`, `McpSessionSummary`; `Gateway#getMcpEndpoint()`.
- Conformance tests with the official `@modelcontextprotocol/sdk` client (list, call, ping, `list_changed`, cancellation, session termination, auth).
- CORS allows the `Mcp-Session-Id`, `MCP-Protocol-Version` and `Last-Event-ID` request headers and exposes `Mcp-Session-Id`.

### Changed
- Docker image is based on `node:22-alpine` (was 20) so the optional audit log works; it has a writable `/app/data` volume and OCI labels. The npm package still supports Node 20+.
- README: npm badge points at `@winstonsayno/mcp-gateway`, CI badge, ghcr image name lowercased (`ghcr.io/harrisoncn/mcp-gateway`), library import uses the scoped package name, API-stability section.
- `AuthConfig.apiKeys` is typed `Array<string | ApiKeyConfig>` (was `string[]`); existing configs are unchanged. `createAuthMiddleware()` returns an `AuthMiddleware` (a `RequestHandler` with an optional `resolveClient`).

## [0.4.0] - 2026-10-07

### Added
- **Readiness probe** `GET /api/v1/health/ready`: always public, `200` when every enabled server is connected and not `degraded` (or at least `?min=N`), otherwise `503`; `503 shutting_down` during graceful shutdown. Body carries only counts. `computeReadiness()` is exported for library use. README documents liveness vs. readiness with a Kubernetes example.
- **Per-server tool filtering**: `servers[].tools.allow` / `servers[].tools.deny` glob patterns (`*`, `?`; deny wins). Hidden tools are removed from discovery, counts and routing; calling one with an explicit `server` returns `403`. Applied to `tools/list_changed` updates and on hot reload. `isToolAllowed` / `filterTools` are exported for library use.

## [0.3.0] - 2026-10-07

### Added
- **Remote upstream transports are routable**: `streamable-http` (MCP 2025-03-26+: `Mcp-Session-Id`, `MCP-Protocol-Version`, JSON or SSE responses, `DELETE` on close), `sse` (MCP 2024-11-05 HTTP+SSE) and `websocket` (`mcp` subprotocol). Per-server `headers` (with `${VAR}` expansion) and `subprotocol` options.
- The proxy is now a transport-independent session layer over small channels (`src/transport/*`), so timeouts, upstream cancellation, `maxConcurrency` and server→client `ping` work identically on every transport. `notifications/tools/list_changed` refreshes the tool registry.
- **Automatic reconnect** of crashed / disconnected / never-connected servers with exponential backoff and jitter (`reconnect` block, per-server overrides). New `reconnecting` status, `health.reconnect` and `session` details in `/servers`, `POST /api/v1/servers/:id/reconnect`, `503` responses carry `status` and `Retry-After`.
- Health checks send a real MCP `ping` and record latency; a connected server that stops answering is `degraded`. Interval configurable via `healthCheckIntervalMs`.
- Prometheus: `mcp_gateway_server_up`, `mcp_gateway_server_status`, `mcp_gateway_server_reconnects_total`, `mcp_gateway_server_reconnect_attempt`, `mcp_gateway_server_ping_ms`. JSON `/metrics` includes a `servers` array.
- **Optional auth for `/health` and `/metrics`** (`auth.protect.health`, `auth.protect.metrics`, default off); always-public `GET /api/v1/health/live` liveness probe; `dashboard.enabled` switch.
- **Dashboard works with auth on**: API key / JWT field (sessionStorage, optional localStorage) sent as a Bearer token; shows reconnect state; fields aligned with the actual API.
- **Hot reload** now also applies `auth` (strategy, keys, secret, protect flags), `rateLimit`, `corsOrigins`, `monitor.requestLog` / `monitor.prometheus` and `reconnect`. An unusable auth config is rejected and the current one kept.
- Conformance tests against the official `@modelcontextprotocol/sdk` servers (Streamable HTTP, SSE, WebSocket adapter); supervisor, hot-reload and auth-protection tests.
- `examples/docker/prometheus.yml` (the compose file referenced it but it was missing) and `examples/remote-servers/`.

### Changed
- `initialize` requests protocol `2025-06-18` and accepts `2025-03-26` / `2024-11-05` answers (the version the server picks is used).
- `@modelcontextprotocol/sdk` moved to `devDependencies` (used only by tests); no runtime dependency was added.
- `/health` reports `degraded` while any server is `reconnecting`; its `servers` summary has a `reconnecting` count.
- `/servers` redacts `headers` values and URL credentials / query values in addition to `env`.
- Docker `HEALTHCHECK` and the compose example use `/api/v1/health/live`.
- The SSE / WebSocket classes in `src/transport/` were rewritten as channels; they no longer reconnect on their own (the supervisor re-runs the full MCP handshake instead).

### Security
- API-key comparison is now constant-time; client ids are key fingerprints instead of key prefixes.
- Unsupported auth strategies (`oauth2`, unknown values) and `api-key`/`jwt` without keys/secret now refuse to start instead of silently disabling auth.
- JWT verification is pinned to HS256/384/512.
- `/servers` responses redact `env` values.
- Client-supplied `X-Request-Id` values are validated; tool-call arguments are no longer logged.

### Fixed
- `${VAR}` references in stdio `args` are now expanded (the multi-server and Docker examples relied on it; only `env` was expanded before).
- Docker compose example referenced a missing `prometheus.yml` and `mcp-gateway.yml`; both are now included.
- Dashboard read fields the API never returned (`healthy`, `uptimeSeconds`, `errorRate`, `p50LatencyMs`, …), could not authenticate, and inserted server-provided strings as raw HTML.
- Project did not compile (`tsc` errors in transports, watcher and JWT auth); `npm start` pointed at `dist/cli.ts`.
- Failed `initialize` left the child process running and the server reported as connected.
- Reconnecting a server id leaked the previous process; an old process' exit could remove the new session.
- SIGKILL escalation never ran (`proc.killed` check); EPIPE on a dead child's stdin crashed the gateway.
- Multi-byte UTF-8 split across stdout chunks was corrupted; server→client requests with colliding ids were taken as responses.
- `maxConcurrency` was ignored; timed-out calls are now cancelled upstream; `tools/list` pagination is followed.
- CORS with several origins produced an invalid `Access-Control-Allow-Origin` header.
- The SSE parser lost events split across chunks, ignored the MCP `endpoint` event and dropped the `sessionId` query; SSE/WS reconnected after an intentional disconnect.
- WebSocket transport relied on a global `WebSocket` missing on Node 20; now uses `ws`.
- Rate limiter was fixed-window (README said sliding) and its timer kept the process alive.
- Prometheus `*_total` series were last-minute counts (not counters); `*/*` requests got Prometheus text, breaking the dashboard.
- Listen errors (EADDRINUSE) hung startup; `stop()` hung on keep-alive sockets and was not idempotent.
- Malformed JSON bodies returned 500/HTML; upstream errors now map to 502 and timeouts to 504; ambiguous tool names return 409.
- Hard-coded `0.1.0` version strings; startup summary always reported 0 failed servers.
- Config hot reload, request ids, CORS, error handler and `/dashboard` were implemented but never wired in.
- Docker: `npm ci` needed a lockfile (now committed), dashboard copied, runs as non-root; compose healthcheck used `curl` (not in image).

### Added
- Test suite (vitest) with a fake stdio MCP server; GitHub Actions CI on Node 20 and 22.
- Config validation: unique server ids, `command` for stdio, `url` for sse/websocket.

---

## [0.2.0] - 2026-03-27

### New Features

**SSE Transport (`src/transport/sse.ts`)**
Full Server-Sent Events transport implementation for MCP servers that expose an SSE endpoint. Supports automatic reconnection with exponential back-off (up to `maxReconnectAttempts`), pending-request correlation by JSON-RPC id, and a companion POST `/message` endpoint for sending requests.

**WebSocket Transport (`src/transport/websocket.ts`)**
Full-duplex WebSocket transport for lower-latency MCP server communication. Includes automatic reconnection, keep-alive pings at a configurable interval, and the same pending-request correlation model as the SSE transport.

**Config Hot Reload (`src/config/watcher.ts`)**
The gateway now watches its config file for changes and applies new server registrations without requiring a restart. A 500 ms debounce prevents thrashing on rapid saves. Invalid configs are rejected with a clear error log while the previous config remains active.

**Request Tracing (`src/middleware/request-id.ts`)**
Every request now carries a unique `X-Request-Id` header. The middleware honours existing `X-Request-Id` or `X-Correlation-Id` headers sent by clients, falling back to a generated UUID v4. The id is reflected in the response and included in all log lines for that request.

**CORS Middleware (`src/middleware/cors.ts`)**
Configurable CORS support with wildcard, exact-origin, and regex-pattern matching. Exposes `X-Request-Id` and `X-RateLimit-*` headers to browsers by default.

**Web Dashboard (`dashboard/index.html`)**
A zero-dependency, single-file HTML dashboard served at `/dashboard`. Displays server health, tool inventory, recent requests, and aggregate metrics. Auto-refreshes every 10 seconds.

### Bug Fixes

**[BUG-001] Concurrent restart race condition**
When multiple requests arrived simultaneously while a server process was restarting, the proxy could spawn duplicate processes. Fixed by introducing a per-server `Mutex` that serialises all `connect()` calls for the same server id.

**[BUG-002] JSON-RPC id collision under high concurrency**
`Date.now()` was used as the JSON-RPC request id, which could produce collisions when multiple requests were dispatched within the same millisecond. Replaced with a monotonic integer counter (`_idSeq`).

**[BUG-003] Leaked stdio handles on process crash**
When an MCP server process crashed, its `stdin` and `stdout` streams were not explicitly destroyed, leaving file-descriptor leaks. The `exit` and `error` handlers now call `.destroy()` on both streams before removing the session.

**[BUG-004] Silent spawn failures**
A `spawn error` event (e.g., command not found) was logged but did not reject pending requests, leaving callers hanging until their timeout fired. The `error` handler now immediately rejects all pending requests for that session.

**[BUG-005] Unhandled errors leaked raw stack traces**
Express errors were passed through without a centralised handler, causing raw `Error` objects (including stack traces) to be serialised into responses in production. A new `errorHandler` middleware normalises all errors into a consistent `{ error: { code, message, requestId } }` envelope and suppresses stack traces outside of development mode.

**[BUG-006] Requests hung indefinitely on slow servers**
Tool-call requests to unresponsive MCP servers could block the event loop indefinitely. A new `timeoutMiddleware` enforces a per-request deadline (default: 30 s) and returns a `504 Gateway Timeout` with a `Retry-After` header.

### Internal Changes

- Added `src/utils/mutex.ts` — lightweight async mutex with no external dependencies
- Added `src/middleware/error-handler.ts` — centralised error normalisation and `GatewayError` class
- Added `src/middleware/timeout.ts` — per-request timeout enforcement
- Updated `src/proxy/index.ts` — incorporates all bug fixes above; private methods renamed with `_` prefix for clarity
- Updated client info version string from `0.1.0` to `0.2.0` in MCP `initialize` handshake

---

## [0.1.0] - 2026-03-24

### Added

Initial public release. See the [v0.1.0 release notes](https://github.com/HarrisonCN/mcp-gateway/releases/tag/v0.1.0) for the full feature list.
