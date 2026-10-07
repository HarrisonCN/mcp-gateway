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
| `jwt` (HS256/384/512) | `Authorization: Bearer <jwt>` |

Missing / invalid credentials → `401 {"error":"Unauthorized","message":"…"}`.

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

---

## MCP endpoint (`/mcp`)

MCP Streamable HTTP, protocol **2025-06-18** (2025-03-26 accepted). Path configurable (`mcp.path`).

| Method | Purpose |
|---|---|
| `POST /mcp` | JSON-RPC requests / notifications / batches. Answers `application/json`; notifications-only bodies → `202`. |
| `GET /mcp` | `text/event-stream` for server→client notifications (`Accept: text/event-stream`, else `406`). |
| `DELETE /mcp` | End the session → `204`. |

**Session.** `initialize` returns `Mcp-Session-Id`; every later request must send it (`400` missing, `404`
unknown / expired / created by another client). `MCP-Protocol-Version`, when sent, must be a supported version
(`400`). Requests with an `Origin` header must match `mcp.allowedOrigins` (default `corsOrigins`), else `403`.

**Server capabilities:** `tools`, `resources`, `prompts` — all with `listChanged: true`.

| Method | Notes |
|---|---|
| `initialize` | negotiates the version; `serverInfo.name = "mcp-gateway"`; optional `instructions` |
| `ping` | `{}` |
| `tools/list` | aggregated, scope-filtered, cursor-paginated (`mcp.pageSize`) |
| `tools/call` | routed upstream; see errors below |
| `resources/list`, `resources/templates/list`, `resources/read` | aggregated / routed as on REST |
| `prompts/list`, `prompts/get` | names follow `toolNaming` |
| `notifications/cancelled` | cancels the in-flight request; the upstream receives its own `notifications/cancelled` |

Notifications sent on the `GET` stream: `notifications/tools/list_changed`,
`notifications/resources/list_changed`, `notifications/prompts/list_changed` — only when the list *that session
sees* changed.

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
- CLI commands and flags (`start`, `init`, `validate`, `-c`, `-p`, `--log-level`, `--no-watch`).
- Library exports from the package root (`@winstonsayno/mcp-gateway`) and their documented signatures.
- Prometheus metric names and labels listed above.

**Not covered**

- Deep imports (`@winstonsayno/mcp-gateway/dist/...`), anything not exported from the package root.
- Log line format, dashboard HTML/JS, exact error `message` texts.
- The audit log's on-disk SQLite schema (use `GET /requests` or `AuditStore`).
- `node:sqlite` itself is still marked experimental by Node.js.
- The client packages in `clients/` are versioned separately and are pre-1.0.

Deprecations are announced in the CHANGELOG and, where possible, logged at startup.
