# Changelog

All notable changes to mcp-gateway will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [Unreleased]

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
