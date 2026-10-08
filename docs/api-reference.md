# API reference

mcp-gateway exposes two downstream interfaces on one HTTP port:

- the **REST API** under `/api/v1` (JSON), and
- the **MCP endpoint** at `/mcp` (MCP Streamable HTTP), for MCP clients such as Claude Code or Cursor.

Both use the same authentication, scopes, rate limits, concurrency limits, metrics and request history.
See the [configuration reference](configuration.md) for every setting mentioned here and the
[stability policy](#stability-and-versioning) for what is covered by semver.

---

## Authentication

| `auth.strategy` | Send |
|---|---|
| `none` (default) | nothing |
| `api-key` | `Authorization: Bearer <key>` or `X-API-Key: <key>` |
| `jwt` (HMAC secret, PEM public key or JWKS) | `Authorization: Bearer <jwt>` |

Missing / invalid / expired / disabled credentials → `401 {"error":"Unauthorized","message":"…"}`.
With `security.authLockout`, an IP with too many recent failures gets
`429 {"error":"Too Many Requests","retryAfter":…}` + `Retry-After` on every authenticated route (incl. `/mcp`).

**Network guards** (`security`): clients outside `ipAllowlist` and requests whose `Host` is not allowed
(`allowedHosts` / `dnsRebindingProtection`) get `403` on every route except `/health/live` and `/health/ready`.
Bodies larger than `maxBodyBytes` → `413`; `arguments` larger than `maxToolArgumentsBytes` → `413` (REST) /
`-32602` (`/mcp`). Responses carry security headers (`X-Content-Type-Options`, `X-Frame-Options`,
`Referrer-Policy`, `Content-Security-Policy`, optional `Strict-Transport-Security`).

Always public: `GET /api/v1/health/live`, `GET /api/v1/health/ready`. Public unless
`auth.protect.health` / `auth.protect.metrics`: `GET /api/v1/health`, `GET /api/v1/metrics`. Everything else
requires auth when it is enabled.

**Scopes.** API keys configured as objects (`servers`, `tools`, `rateLimit`) and JWTs carrying
`mcp_servers` / `mcp_tools` claims are restricted: discovery endpoints hide what the client may not use, and
calls to it return `403` (REST) or JSON-RPC `-32003` (`/mcp`). Restricted clients only see their own request
history. See [Per-key scopes](configuration.md#per-key-scopes).

**Rate limits.** Calls (`POST /tools/call`, `/resources/read`, `/prompts/get`, `/servers/:id/reconnect`, and
`tools/call` / `resources/read` / `prompts/get` on `/mcp`) count against `rateLimit` (or the key's own
`rateLimit`). Responses carry `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset`; when exceeded,
`429` with `Retry-After` (REST) or JSON-RPC `-32029` with `data.retryAfter` (`/mcp`).

Every response has an `X-Request-Id` header (a valid client-supplied one is echoed).

---

## REST API (`/api/v1`)

### Health

#### `GET /health/live`
Liveness. Always `200 {"status":"ok"}` while the process serves HTTP.

#### `GET /health/ready`
Readiness. `200` when at least `?min=N` (default: all) enabled servers are connected and not `degraded`,
else `503`; `503 {"status":"shutting_down"}` during graceful shutdown. `400` for an invalid `min`.

```json
{ "status": "ready", "servers": { "ready": 2, "total": 2, "required": 2 } }
```

#### `GET /health`
`200` (`"ok"`) or `207` (`"degraded"` — some server offline / reconnecting).

```json
{ "status": "ok", "version": "1.0.0", "uptime": 123.4,
  "servers": { "total": 2, "online": 2, "offline": 0, "degraded": 0, "reconnecting": 0, "unknown": 0, "totalTools": 34 } }
```

#### `GET /metrics`
JSON aggregation by default (`?window=<ms>`, default 1 h):
`totalRequests`, `successRate`, `avgLatencyMs`, `p95LatencyMs`, `p99LatencyMs`, `requestsPerMinute`,
`topTools`, `topServers`, `errorsByServer`, `servers[]` (`id`, `status`, `up`, `reconnects`, `reconnectAttempt`, `latencyMs`).

With `monitor.prometheus: true`, Prometheus text format when `Accept` is `text/plain` / OpenMetrics or
`?format=prometheus` (`?format=json` forces JSON). Series:

| Series | Type |
|---|---|
| `mcp_gateway_requests_total`, `mcp_gateway_errors_total` | counter |
| `mcp_gateway_server_requests_total{server}`, `mcp_gateway_server_errors_total{server}`, `mcp_gateway_server_duration_ms_sum{server}` | counter |
| `mcp_gateway_success_rate`, `mcp_gateway_latency_avg_ms`, `mcp_gateway_latency_p95_ms`, `mcp_gateway_latency_p99_ms` (last minute) | gauge |
| `mcp_gateway_server_up{server}`, `mcp_gateway_server_status{server,status}`, `mcp_gateway_server_reconnect_attempt{server}`, `mcp_gateway_server_ping_ms{server}` | gauge |
| `mcp_gateway_server_reconnects_total{server}` | counter |

### Servers

#### `GET /servers`
```json
{ "servers": [ { "id": "github", "name": "GitHub", "transport": "stdio", "tags": ["vcs"], "enabled": true,
    "timeout": 30000, "maxConcurrency": 10, "env": { "GITHUB_TOKEN": "***" },
    "health": { "serverId": "github", "status": "online", "lastChecked": "…", "latencyMs": 3, "toolCount": 26,
                "connectedSince": "…", "reconnect": { "state": "idle", "attempt": 0, "reconnects": 0 } },
    "session": { "transport": "stdio", "protocolVersion": "2025-06-18", "capabilities": { "tools": {} },
                 "serverInfo": { "name": "github", "version": "1.0" }, "connectedAt": "…" },
    "toolCount": 26 } ], "total": 1 }
```
`env` and `headers` values, URL credentials and query values are redacted. Status is one of
`online`, `degraded`, `reconnecting`, `offline`, `unknown`.

#### `GET /servers/:id`
Same fields plus `tools` (instead of `toolCount`). `404` when unknown or outside the caller's scope.

#### `POST /servers/:id/reconnect`
Reconnect now, resetting backoff. `200 {"server","connected":true,"health"}`, `502` when the attempt failed,
`403` outside scope, `404` unknown.

### Tools

#### `GET /tools`
`?server=<id>`, `?tag=<tag>`. Returns `{ "tools": Tool[], "total": n }` where
`Tool = { name, title?, description?, inputSchema?, outputSchema?, annotations?, serverId, serverName }`.

`?format=openai | openai-responses | anthropic` returns LLM function-calling schemas instead:

```json
{ "format": "openai",
  "tools": [ { "type": "function", "function": { "name": "github__create_issue", "description": "…", "parameters": { "type": "object", "properties": {} } } } ],
  "mapping": { "github__create_issue": { "server": "github", "tool": "create_issue" } },
  "total": 1 }
```
`openai-responses` entries are `{type:"function", name, description, parameters}`; `anthropic` entries are
`{name, description, input_schema}`. Names follow `mcp.toolNaming`, are sanitised to `^[a-zA-Z0-9_-]{1,64}$` and
de-duplicated. Unknown format → `400`.

#### `POST /tools/call`
```json
{ "tool": "create_issue", "server": "github", "arguments": { "title": "Hi" } }
```
`server` is optional when the name is unique among the servers the caller may use.

| Status | Body / meaning |
|---|---|
| `200` | `{ "result": <MCP CallToolResult>, "server", "tool", "durationMs" }` |
| `400` | invalid body or malformed JSON |
| `403` | hidden by the server's `tools` filter, or outside the caller's scope |
| `404` | unknown tool or server |
| `409` | the name exists on several servers — `{"servers":[…]}`; pass `server` |
| `429` | rate limited (`Retry-After`) |
| `502` | the MCP server returned a JSON-RPC error (`code`, `message`) |
| `503` | server not connected (`status`, `Retry-After` when a reconnect is scheduled) |
| `504` | no answer within the server's `timeout` |

A tool that runs but fails is a `200` whose `result.isError` is `true` (that is the MCP server's answer).

### Resources & prompts

| Endpoint | Body / query | Response |
|---|---|---|
| `GET /resources` | `?server=` | `{ resources: [{ uri, name, title?, description?, mimeType?, size?, serverId, serverName }], total }` (duplicate URIs collapsed, lowest server id wins) |
| `GET /resources/templates` | `?server=` | `{ resourceTemplates: [{ uriTemplate, name, …, serverId, serverName }], total }` |
| `POST /resources/read` | `{ "uri", "server"? }` | `{ result: { contents: [...] }, server, uri, durationMs }` |
| `GET /prompts` | `?server=` | `{ prompts: [{ name, title?, description?, arguments?, serverId, serverName }], total }` |
| `POST /prompts/get` | `{ "name", "server"?, "arguments"? }` | `{ result: { description?, messages: [...] }, server, name, durationMs }` |

Without `server`, reads are routed by exact URI, then by resource template, then to the only server offering
resources (`404` otherwise); prompt names must be unique among allowed servers (`409` otherwise). Error statuses
match `POST /tools/call`.

### Request history

#### `GET /requests`
Newest first. From the persistent audit log when `audit.enabled`, otherwise from memory.

| Query | |
|---|---|
| `limit` | 1–500, default 50 |
| `server`, `tool`, `client` | exact match (`tool` is the tool name, resource URI or prompt name) |
| `success` | `true` / `false` |
| `via` | `rest` / `mcp` |
| `kind` | `tool` / `resource` / `prompt` |
| `since`, `until` | ISO 8601 or epoch milliseconds (`since` inclusive, `until` exclusive) |
| `cursor` | `nextCursor` of the previous page |

```json
{ "requests": [ { "id": "…", "timestamp": "…", "serverId": "github", "toolName": "create_issue", "durationMs": 120,
                  "success": true, "clientId": "key:aura", "via": "mcp" } ],
  "nextCursor": "s1234", "source": "audit" }
```
`kind` is present for resources and prompts. Invalid parameters → `400`.

### mTLS (4.5)

`GET /mtls` (operators) → `{ enabled, identity?: { spiffeId, subject, notAfter, fingerprint, expiresInHours, loadedAt, rotations, error? }, peers: [{ server, spiffeIds, at }], servers: [{ id, mtls, spiffeId }] }`.

### Streaming tool calls (4.4)

`POST /tools/stream` — body as `/tools/call`; `text/event-stream` with `progress`, `partial`, `result` | `error`, `end`
events. Progress events are coalesced when the client reads slowly; a client more than `streaming.maxBufferedBytes`
behind is disconnected. A server whose `maxQueue` is full answers `503` with `Retry-After: 1` (`code: -32014`).

### Costs and budgets (4.3)

`GET /costs?by=client|tenant|server|model|tool&period=day|month|all` (operators) →
`{ currency, period, by, totals: [{ key, cost, calls, inputTokens, outputTokens }], budgets: [{ name, subject, period, limit, spent, used, action }], alerts: [{ budget, subject, threshold, spent, limit, at, period }] }`.
A call refused by an exhausted `action: block` budget fails with `-32013` (`data.decision: "budget"`, `resetsAt`).

### Tool chains (4.2)

`GET /chains` → `{ toolPrefix, chains: [{ name, tool, description, inputSchema, steps, targets, allowed }], recent: [run summaries] }`.
`POST /chains/:name/run` with `{ input }` → `{ chain, success, output, steps: [{ id, tool, status, durationMs, calls, error? }], durationMs }`
(`404` unknown chain, `403` a step is outside the caller's scope, `502` a step failed). Chains are also MCP tools named
`chain_<name>` on `/mcp`. See [configuration](configuration.md#tool-chains-42).

### MCP revisions (4.1)

`GET /mcp/protocol` → `{ latest, supported: string[], features: { "<revision>": { annotations, structuredContent, outputSchema, resourceLink, toolTitle, elicitation } }, upstream: [{ server, protocolVersion }] }`.

Each `/mcp` session negotiates its own revision (`mcp.protocolVersions` restricts the list). Results are shaped per
session: structured tool output (`outputSchema` / `structuredContent`) and resource links pass through to 2025-06-18+
clients and are turned into text blocks for older ones; tool `title` / `annotations` are stripped for revisions that
predate them. When an upstream returns only `structuredContent`, a serialized text block is added (spec "SHOULD").

### Plugins (3.3)

`GET /plugins` (operators): `{ plugins: [{ name, apiVersion, kind: "module" | "wasm", hooks, isolation?, sandboxes?: [{ key, calls, alive }] }] }`.

### Request details and replay (3.2)

Needs `replay.enabled: true` (otherwise 404). Restricted clients see and replay only their own calls.

| Method | Path | |
|---|---|---|
| GET | `/requests/:id` | The captured call: metadata, redacted `arguments`, `result` / `error`, `replayOf`, `truncated` |
| POST | `/requests/:id/replay` | Run the tool call again with the caller's credentials. Body (optional): `{ "arguments": {…}, "server": "…" }`. Returns `{ original, replay: { status, requestId, body, … }, diff, identical }` |

`diff` is a structural diff of the two results (`[{ path, change: added \| removed \| changed, before, after }]`).
`POST /tools/call` responses now carry `requestId`, the id of the history record.

### Usage and quotas

| | |
|---|---|
| `GET /usage` | `{ group, rows: [{ <group dims>, calls, errors, durationMs }], generatedAt }`; `group` = comma list of `client`, `tenant`, `server`, `tool`, `hour`, `day`; filters `since`, `until` (ISO or ms), `client`, `tenant`, `server`; `format=csv` for a CSV download |
| `GET /quotas` | `{ rules, usage: [{ rule, period, limit, subject, used, resetsAt }] }` |

Tool calls over a quota: `429` + `Retry-After`, `{ code: -32007, quota: { quota, limit, resetsAt } }`.

### Catalog

| | |
|---|---|
| `GET /catalog` | `{ install, entries: [{ id, name, description, template, env?, args?, installed: [serverIds] }], installedServers }` |
| `POST /catalog/:id/install` | `{ "serverId": "fs", "env": { "TOKEN": "…" }, "args": ["/data"] }` → `201`; `403` when `catalog.install` is off, `400` missing input, `404`, `409` id taken |
| `DELETE /catalog/servers/:id` | remove a catalog-installed server |

### Tenants

| | |
|---|---|
| `GET /tenants` | `{ tenants: [{ id, name, role, servers, serverIds, members? }], clientId, operator }` — all tenants for operators, own memberships otherwise; `members` for admins / owners |
| `GET /tenants/:id` | one tenant (404 when not a member) |
| `PUT /tenants/:id/members` | `{ "client": "key:dave", "role": "viewer" }` — owners / operators; runtime only |
| `DELETE /tenants/:id/members/:client` | 409 when it would remove the last owner |

Viewers get `403` (REST) / `-32003` (`/mcp`) on tool calls.

### Cache

`GET /api/v1/cache` (operator) → `{ "enabled": true, "entries": 12, "maxEntries": 1000, "hits": 40, "misses": 12, "deduped": 3, "evictions": 0 }`.
`DELETE /api/v1/cache[?server=<id>]` → `{ "purged": 12 }`. Cached REST responses report `durationMs: 0`.

### Load balancing

`GET /api/v1/load-balancing` (operator keys) — one entry per server with `replicas`:

```json
{ "groups": [ { "server": "github", "strategy": "round-robin", "failoverOn": ["not-connected"],
  "members": [ { "id": "github", "weight": 1, "connected": true, "healthy": true, "latencyMs": 41, "calls": 120, "errors": 0 },
               { "id": "github~1", "weight": 1, "connected": false, "healthy": false, "calls": 3, "errors": 3,
                 "ejectedUntil": "2026-10-07T18:00:30.000Z" } ] } ] }
```

### Developer portal (3.8)

Public (no credentials): `GET /portal/info`, `POST /portal/signup` (`{ name, email }` → `201 { id, status, key, … }`; the key is shown once; `429` after 10 signups per IP per hour).
Portal-key holders: `GET /portal/me` (key + 7-day usage: `calls`, `errors`, `avgLatencyMs`, `byTool`, `byDay`), `POST /portal/me/rotate`, `DELETE /portal/me`.
Any authenticated caller: `GET /portal/tools` (tools in scope with `inputSchema`, `example`, `snippets: { curl, javascript, python }`).
Operators: `GET /portal/keys[?status=]`, `POST /portal/keys/:id/approve|deny|revoke`. Key records never include the digest.

### Compliance (3.7)

`GET /compliance` (operators): `{ pii: { action, scope, categories, servers } | null, residency: { rules, allowUnknown, servers: [{ id, region }] }, findings: { "<category>": n }, blocked: { pii, residency } }` — 6.0: `pii` and the counters come from `dlp`.
`GET /compliance/report?framework=soc2|gdpr&since=&until=&format=json|md` (operators): `{ framework, generatedAt, gatewayVersion, period, summary: { pass, warn, fail }, controls: [{ id, title, status, evidence }], activity, warnings }`, or Markdown.
Refusals: JSON-RPC `-32011` (data residency), `-32012` (PII with `action: block`); REST `403`.

### Federation (3.6)

`GET /federation` (operators): `{ enabled, gatewayId, region, exported, peers: [{ id, url, region, priority, healthy, lastSync, lastError?, latencyMs, servers: [{ id, status, tools }], forwarded }] }`.
`POST /federation/sync` (operators): pull every peer catalog now.
Peer-to-peer (HMAC header `x-mcp-federation`, no client credentials): `GET /federation/catalog`, `POST /federation/call` (`{ server, tool, arguments }` → `/tools/call` response).
`POST /tools/call` accepts `server: "<id>@<peer>"`; the response adds `peer`.

### Secrets (3.5)

`GET /secrets` (operators): `{ providers: [{ id, type }], rotation: { intervalSeconds }, secrets: [{ ref, provider, type, version, fetchedAt?, rotatedAt?, error?, usedBy }] }` — values are never returned.
`POST /secrets/rotate`: re-read every reference now; `{ rotated: [serverId] }` lists the servers reconnected with new credentials.
Calls whose `inject` credential cannot be resolved fail with JSON-RPC `-32010`.

### Smart routing (3.4)

`GET /routing` (operators): `{ splits: [{ name, server, tools?, sticky, variants: [{ server, label, weight, effectiveWeight, calls, errors, errorRate, latencyMs?, rolledBack? }] }], groups: [<load-balancing group with member score>] }`.
`POST /routing/splits/:name/reset` clears the split's stats and rollbacks.

### Security posture

#### `GET /security`

Requires auth; scoped (restricted) clients get `403`. Never contains key material.

```json
{
  "authStrategy": "api-key",
  "warnings": [{ "id": "plaintext-api-keys", "level": "info", "message": "…" }],
  "apiKeys": { "total": 3, "hashed": 2, "disabled": 0, "expired": 0,
               "expiring": [{ "name": "ci", "expiresAt": "2027-01-01T00:00:00.000Z" }] },
  "jwt": null,
  "settings": { "headers": true, "hsts": false, "dnsRebindingProtection": false, "allowedHosts": null,
                "ipAllowlist": 0, "trustProxy": false, "maxBodyBytes": 10485760, "maxToolArgumentsBytes": 0,
                "redactPatterns": 0, "authLockout": { "maxFailures": 10, "windowSeconds": 300, "lockoutSeconds": 900 } },
  "lockout": { "lockedClients": 0, "trackedClients": 1, "lockoutsTotal": 0 }
}
```

`warnings[].level` is `warn` (likely exposure) or `info` (hardening hint); ids are listed in
[Security warnings](configuration.md#security-warnings). `jwt` (for the jwt strategy) is
`{ keySource: "secret" | "publicKey" | "jwks", issuer, audience, requireExp }`. `authLockout` / `lockout` are
`null` when lockout is off. The dashboard shows this on its *Connect* page.

### Live data (dashboard)

Both endpoints require auth (like `/servers`). Clients restricted by a scope only see their own calls and
in-scope servers, the same rule as `GET /requests`. Both read the in-memory log (`monitor.retentionHours`).

#### `GET /stats`
Windowed time series and breakdowns, computed on request.

| Query | |
|---|---|
| `window` | ms, 10 000 – 86 400 000, default 900 000 (15 min) |
| `bucket` | ms, default `window / 60`; clamped so there are at most 360 buckets (min 1 000) |

```json
{ "windowMs": 900000, "bucketMs": 15000, "now": 1791380000000,
  "summary": { "total": 222, "errors": 10, "errorRate": 0.045, "requestsPerMinute": 14.8, "p50": 53, "p95": 163, "p99": 181 },
  "series":  [ { "t": 1791379115000, "count": 4, "errors": 0, "p50": 41, "p95": 120 } ],
  "tools":   [ { "name": "get_weather", "serverId": "weather", "count": 108, "errors": 4, "p95": 67 } ],
  "servers": [ { "id": "weather", "count": 131, "errors": 5, "p95": 66 } ],
  "clients": [ { "id": "key:admin", "count": 120, "errors": 5, "lastSeen": 1791379988000 } ] }
```
Buckets are aligned to `bucket`; the last one is the current, partial bucket. Percentiles use nearest rank.
`tools` is the top 10, `clients` the top 20 (calls without a client id count as `anonymous`).

#### `GET /events`
[Server-Sent Events](https://html.spec.whatwg.org/multipage/server-sent-events.html) stream
(`text/event-stream`). Takes the same `window` / `bucket` as `/stats` for its snapshots.

| Event | `data` |
|---|---|
| `request` | one request record, same shape as in `GET /requests`, as soon as it is recorded |
| `snapshot` | every 2 s: `{ now, health: [ServerHealth…], summary, last }` (`summary` as in `/stats`, `last` = current bucket) |

A `: ping` comment is sent every 15 s; `retry: 3000` is sent first. At most 50 streams are open at once (`503`
beyond that). Streams end when the gateway shuts down. Browsers cannot set headers on `EventSource`, so the
dashboard reads the stream with `fetch()`; with curl:

```bash
curl -N -H "Authorization: Bearer $KEY" http://localhost:4000/api/v1/events
```

---

## Admin API (`/api/v1/admin`)

The dashboard's **Config** tab (4.6) is a graphical client of these endpoints: it loads `GET /admin/config`, checks
`PUT /admin/config?dryRun=true` to decide whether it may apply (403 → read-only), and uses `POST /admin/config/validate`,
`POST /admin/config/diff` and `PUT /admin/config`.

Operators only. Writes need `controlPlane.configApi: true`. On a data plane (7.0) the whole admin API answers 403. See [Declarative config](guides/declarative-config.md).

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/admin/config` | Running config (secrets `<redacted>`) |
| `POST` | `/admin/config/validate` | Validate a config body |
| `POST` | `/admin/config/diff` | Diff a config body against the running config |
| `PUT` | `/admin/config?dryRun=` | Hot-apply a config body |
| `POST` | `/admin/reload` | Re-read the config file |
| `GET` | `/admin/deprecations` | Deprecated keys / usages |
| `GET` | `/admin/edge/snapshot?secrets=` | Edge config snapshot (`ETag` / `If-None-Match`; `secrets=true` needs `controlPlane.configApi`) (4.8) |
| `POST` | `/admin/edge/sync` | Ingest an edge's usage events `{ edgeId, events, queued }` (4.8) |
| `GET` | `/admin/edge/nodes` | Edges seen: last sync, snapshot ETag, events / errors / queued (4.8) |
| `GET` | `/admin/features` | Feature modules mounted under `/admin/<id>` (5.1) |
| `GET` | `/admin/conformance/checks` | MCP conformance checks (5.1) |
| `POST` | `/admin/conformance/run` | Run the conformance suite against this gateway's `/mcp` `{ only? }` (5.1) |
| `GET` | `/admin/regions` | Multi-region status: this region, peers (health, last sync, servers online), replicated keys (5.2) |
| `POST` | `/admin/regions/sync` | Peer exchange `{ region, since, entries, servers }` (5.2) |
| `GET` / `PUT` / `DELETE` | `/admin/regions/kv/:key` | Replicated state, last-writer-wins (`PUT { value }`) (5.2) |
| `GET` | `/admin/regions/route/:serverId` | Where a call should run: `local`, a peer, or `none` (5.2) |
| `GET` | `/admin/edge-fleet` | Managed edge nodes with config drift (`in-sync` / `stale` / `never-synced` / `unmanaged` / `offline`) (5.3) |
| `POST` | `/admin/edge-fleet/push` | Ask edges to sync now `{ nodes?, labels?, onlyDrifted? }` → per-node results (5.3) |
| `GET` | `/admin/marketplace` | Plugin marketplace entries from `marketplace.indexes` (`trusted` = signed by a `pluginTrust` key) (5.4) |
| `POST` | `/admin/marketplace/install` | Download + verify (sha256, Ed25519) + write a plugin `{ name, version? }` → `plugins:` entry (5.4) |
| `GET` / `POST` | `/admin/sessions` | Agent session recordings; `POST { name, clientId?, since?, until?, tools? }` records from captured calls (5.5) |
| `GET` / `PUT` / `DELETE` | `/admin/sessions/:name` | Export / import `{ steps }` / delete a recording (5.5) |
| `POST` | `/admin/sessions/:name/replay` | Replay and grade `{ mode: success\|structure\|exact, stopOnFailure? }` → eval report (5.5) |
| `GET` | `/admin/dlp` | DLP policy (levels, default + tenant clearance / strategy) and counters (5.6) |
| `POST` | `/admin/dlp/classify` | Classify a value `{ value, tenant? }` → findings and the masked value (5.6) |
| `GET` | `/admin/adaptive` | Adaptive pools with per-candidate calls, error rate, latency, quality, picks (5.8) |
| `POST` | `/admin/adaptive/pick` | Pick a candidate `{ pool, explore? }` → server, tool, args, scores (5.8) |
| `POST` | `/admin/adaptive/call` | Pick and call `{ pool, arguments }` (5.8) |
| `POST` | `/admin/adaptive/feedback` | Report quality `{ pool, candidate, quality: 0..1 }` (5.8) |
| `GET` | `/admin/api-upstreams` | GraphQL / gRPC upstreams and the tools they expose, with input schemas (6.1) |
| `POST` | `/admin/api-upstreams/call` | Call `{ tool: "<upstream>.<operation>", arguments }` (6.1) |
| `GET` | `/admin/workflows` | Workflows (DAGs) with nodes and execution layers (6.2) |
| `POST` | `/admin/workflows/run` | Start a run `{ workflow, input?, wait? }` → `202 { runId }` or the finished run (6.2) |
| `GET` | `/admin/workflows/runs` | Run history, newest first (`?workflow=`) (6.2) |
| `GET` | `/admin/workflows/runs/:id` | One run with per-node status, attempts, errors and output (6.2) |
| `GET` | `/admin/genai-otel` | GenAI telemetry settings and metric summaries (`gen_ai.client.operation.duration`, `gen_ai.client.token.usage`) (6.3) |
| `GET` | `/admin/genai-otel/spans` | Recent GenAI spans with semconv attributes, newest first (`?limit=`) (6.3) |
| `GET` | `/admin/genai-otel/otlp` | Current GenAI metrics as an OTLP/JSON `resourceMetrics` payload (6.3) |
| `GET` | `/admin/identity` | SSO / SCIM status: OIDC issuer, group → tenant role mappings, user and group counts (6.4) |
| `*` | `/admin/identity/scim/v2/{Users,Groups}[/:id]` | SCIM 2.0 provisioning (RFC 7644): create, list with `filter`, read, `PUT`, `PATCH`, delete; plus `ServiceProviderConfig`, `ResourceTypes`, `Schemas` (6.4) |
| `GET` | `/admin/identity/memberships?user=` | A SCIM user's groups and effective tenant memberships (6.4) |
| `POST` | `/admin/identity/sso/verify` | Verify an OIDC ID token `{ idToken }` → user, groups, tenant memberships (6.4) |
| `GET` | `/admin/identity/sso/authorize-url` | Authorization-code + PKCE (S256) login URL (6.4) |
| `POST` | `/admin/policy-sim/simulate` | Diff a candidate policy `{ policy: { rules, default }, calls?, source? }` against past calls (replay capture, recent metrics or given calls) (6.5) |
| `POST` | `/admin/policy-sim/dry-run` | Decide one hypothetical call `{ server, tool, arguments?, clientId? }` under the enforced and shadow policies (6.5) |
| `GET` | `/admin/policy-sim/shadow` | Shadow-policy agreement, transitions and recent divergences (6.5) |
| `POST` | `/admin/policy-sim/shadow/reset` | Reset the shadow counters (6.5) |
| `GET` | `/admin/anomaly` | Anomaly alerts (newest first, `?kind=`), quarantined clients and per-client baselines (6.6) |
| `POST` | `/admin/anomaly/score` | Prompt-injection score and signals for `{ text }` or `{ value }` (6.6) |
| `POST` | `/admin/anomaly/release` | Lift a client's quarantine `{ client }` (6.6) |
| `GET` | `/admin/billing/usage` | Metered usage by account and `server/tool` (`?account=`, `?period=YYYY-MM`) (6.7) |
| `GET` | `/admin/billing/invoices` | Invoice totals for every account in a period (6.7) |
| `GET` | `/admin/billing/invoices/:account` | One invoice with line items, discount, minimum, tax (`?format=csv`) (6.7) |
| `GET` | `/admin/k8s/manifests` | Kubernetes manifests for this gateway (`?name=&namespace=&replicas=&image=&secret=&format=yaml`; API keys are never rendered) (6.8) |
| `GET` | `/admin/k8s/crd` | The `McpGateway` CustomResourceDefinition (6.8) |
| `GET` | `/admin/data-planes` | Control plane: data planes (last seen, config ETag, in sync, online / stale) and summary (7.0) |
| `GET` | `/admin/data-planes/config` | Config for data planes (`ETag` / `If-None-Match` → 304; secrets included; `role: control` only) (7.0) |
| `POST` | `/admin/data-planes/heartbeat` | Data-plane heartbeat `{ nodeId, configEtag?, version?, pullIntervalMs?, servers? }` (`role: control` only) (7.0) |
| `DELETE` | `/admin/data-planes/:nodeId` | Forget a data plane (7.0) |
| `GET` | `/admin/terraform` | Terraform: kinds, paths, provider block, writable (7.1) |
| `GET` / `POST` | `/admin/terraform/:kind[?dryRun=]` | List / create `servers`, `tenants`, `apiKeys` (restapi provider; writes need `controlPlane.configApi`) (7.1) |
| `GET` / `PUT` / `DELETE` | `/admin/terraform/:kind/:id[?dryRun=]` | Read (`ETag`) / replace (`If-Match` → 412) / delete one object (7.1) |
| `GET` | `/admin/terraform/export?format=hcl\|json&url=` | `main.tf` for the running config with `import` blocks; secrets as sensitive variables (7.1) |
| `GET` | `/admin/console` | SaaS console: plans, organisations (plan, members, usage today / remaining), totals (7.2) |
| `POST` | `/admin/console/orgs` | Onboard an organisation `{ id, name?, plan?, owner? }` (tenant + plan; `controlPlane.configApi`) (7.2) |
| `GET` / `PATCH` / `DELETE` | `/admin/console/orgs/:id` | One organisation / change `{ plan?, name?, suspended? }` / offboard (7.2) |
| `POST` | `/admin/console/orgs/:id/reset-usage` | Clear today's call counter (7.2) |
| `GET` | `/admin/sanitize` | Output sanitisation / injection defence: settings and counters (7.3) |
| `POST` | `/admin/sanitize/preview` | Sanitise `{ value, server?, tool? }` without a call: cleaned value, report, blocked (7.3) |
| `GET` | `/admin/semantic-cache` | Semantic cache: settings, entries, hits / misses / stores / evictions (7.4) |
| `POST` | `/admin/semantic-cache/similarity` | Similarity of `{ a, b }` with the configured embedding (7.4) |
| `DELETE` | `/admin/semantic-cache?tool=` | Purge the semantic cache (7.4) |
| `GET` | `/admin/rollouts[/:id]` | Gradual rollouts: effective percent, state, calls / error rates per version (7.5) |
| `POST` | `/admin/rollouts/:id/percent\|promote\|rollback\|reset[?persist=]` | Change a rollout at runtime (`persist=true` writes `percent` to the config) (7.5) |

## Bridges

- OpenAI-compatible: `GET /openai/v1/tools`, `POST /openai/v1/tool_calls`, `POST /openai/v1/chat/completions`.
- A2A: `GET /.well-known/agent-card.json`, `POST /a2a` (JSON-RPC `message/send`, `tasks/get`).

See [Bridges](guides/bridges.md).

## MCP endpoint (`/mcp`)

MCP Streamable HTTP, protocol **2025-06-18** (2025-03-26 accepted). Path configurable (`mcp.path`).

| Method | Purpose |
|---|---|
| `POST /mcp` | JSON-RPC requests / notifications / batches. Answers `application/json`, or `text/event-stream` for a single `tools/call` with `_meta.progressToken` once progress arrives (see below); notifications-only bodies → `202`. |
| `GET /mcp` | `text/event-stream` for server→client notifications (`Accept: text/event-stream`, else `406`). |
| `DELETE /mcp` | End the session → `204`. |

**Session.** `initialize` returns `Mcp-Session-Id`; every later request must send it (`400` missing, `404`
unknown / expired / created by another client). `MCP-Protocol-Version`, when sent, must be a supported version
(`400`). Requests with an `Origin` header must match `mcp.allowedOrigins` (default `cors.origins`), else `403`;
with `security.dnsRebindingProtection` only same-origin, loopback and explicitly listed origins pass.

**Server capabilities:** `tools`, `resources` (`subscribe: true`), `prompts` — all with `listChanged: true` —
plus `logging` and `completions`.

| Method | Notes |
|---|---|
| `initialize` | negotiates the version; `serverInfo.name = "mcp-gateway"`; optional `instructions` |
| `ping` | `{}` |
| `tools/list` | aggregated, scope-filtered, cursor-paginated (`mcp.pageSize`) |
| `tools/call` | routed upstream; see errors below |
| `resources/list`, `resources/templates/list`, `resources/read` | aggregated / routed as on REST |
| `prompts/list`, `prompts/get` | names follow `toolNaming` |
| `resources/subscribe`, `resources/unsubscribe` | routed like `resources/read`; the owning server must announce `resources.subscribe` (else `-32601`). One upstream subscription per (server, URI) is shared by all sessions and restored after a reconnect; it is released when the last session unsubscribes or ends |
| `logging/setLevel` | sets the session's minimum level (`debug` … `emergency`, else `-32602`); upstream servers with the `logging` capability are set to the most verbose level any session asked for |
| `completion/complete` | `ref/prompt` (exposed prompt name, translated back to the upstream name) or `ref/resource` (template or URI) routed to the owning server; servers without the `completions` capability answer `{ values: [], hasMore: false }` |
| `notifications/cancelled` | cancels the in-flight request; the upstream receives its own `notifications/cancelled` |

Notifications sent on the `GET` stream: `notifications/tools/list_changed`,
`notifications/resources/list_changed`, `notifications/prompts/list_changed` — only when the list *that session
sees* changed; `notifications/resources/updated` for subscribed URIs; `notifications/message` from upstream
servers in the session's scope at or above its `logging/setLevel` level (none before the client sets a level),
with `logger` set to `<serverId>` or `<serverId>/<upstream logger>`.

**Progress.** A `tools/call` whose `params._meta.progressToken` is set, sent alone (not in a batch) by a client
that accepts `text/event-stream`, is forwarded with a gateway-generated token; upstream
`notifications/progress` are translated back to the client's token and the response switches to an SSE stream
(progress events, then the result). Without progress the answer stays `application/json`.

**Tool names.** `toolNaming: auto` keeps names unless two (visible) servers share one; then each copy is
`<serverId>__<tool>`. `prefix` always prefixes. In `auto` mode the prefixed alias is also accepted.

**Errors**

| Situation | Answer |
|---|---|
| unknown tool / prompt, bad params, bad cursor | JSON-RPC `-32602` |
| unknown method | `-32601` |
| tool / server outside the caller's scope | `-32003` |
| rate limited | `-32029`, `data.retryAfter` |
| resource not found | `-32002` |
| request cancelled | `-32800` |
| server offline, upstream timeout (tools) | result with `isError: true` and a text explanation |
| upstream JSON-RPC error | forwarded unchanged |
| malformed JSON | HTTP `400`, `-32700` |

---

## Stability and versioning

mcp-gateway follows [Semantic Versioning](https://semver.org/) from 1.0.0. Within 1.x:

**Stable (breaking changes only in a new major version)**

- REST paths, methods, query parameters, status codes and documented response fields under `/api/v1`.
  New fields, endpoints, query parameters and enum values may be **added** in minor releases — clients must
  ignore unknown fields.
- `/mcp` behaviour described above (session handling, naming rules, error codes). New MCP protocol versions and
  capabilities may be added.
- Configuration keys and their meaning (YAML / JSON and `MCP_GATEWAY_*` variables). New keys may be added;
  existing keys are only deprecated with a warning before removal in the next major.
- CLI commands and flags (`start`, `init`, `validate`, `hash-key`, `gen-key`, `-c`, `-p`, `--log-level`,
  `--no-watch`, `--strict`).
- Library exports from the package root (`@winstonsayno/mcp-gateway`) and their documented signatures.
- Prometheus metric names and labels listed above.

**Not covered**

- Deep imports (`@winstonsayno/mcp-gateway/dist/...`), anything not exported from the package root.
- Log line format, dashboard HTML/JS, exact error `message` texts (including security warning messages; their
  `id`s are stable).
- The audit log's on-disk SQLite schema (use `GET /requests` or `AuditStore`).
- `node:sqlite` itself is still marked experimental by Node.js.
- The client packages in `clients/` are versioned separately and are pre-1.0.

Deprecations are announced in the CHANGELOG and, where possible, logged at startup.
