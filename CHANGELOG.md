# Changelog

All notable changes to mcp-gateway will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [Unreleased]

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
