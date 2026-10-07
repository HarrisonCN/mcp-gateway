# Remote servers, reconnect and hot reload

## Transports

| `transport` | Spec | How the gateway talks to the server |
|-------------|------|--------------------------------------|
| `stdio` | all versions | Spawns `command` with `args`/`env`; newline-delimited JSON-RPC over stdin/stdout |
| `streamable-http` | 2025-03-26, 2025-06-18 | `POST url` per message (`Accept: application/json, text/event-stream`); JSON or SSE responses; echoes `Mcp-Session-Id` and `MCP-Protocol-Version`; `DELETE url` on disconnect |
| `sse` | 2024-11-05 | `GET url` opens an event stream; the `endpoint` event names the POST URL (must be same origin); responses arrive as `message` events |
| `websocket` | (community convention) | One JSON-RPC message per text frame; requests the `mcp` subprotocol (override with `subprotocol`) |

`url`, `headers` (values support `${VAR}`) and `timeout` apply to all network transports.
Header values and URL query values are redacted in `/servers`.

If you are unsure which HTTP transport a server speaks: servers built on a recent
official SDK expose Streamable HTTP (usually at `/mcp`); older ones expose `/sse`.

Not implemented yet for `streamable-http`: the optional standalone `GET` stream
for unsolicited server notifications and SSE resumption (`Last-Event-ID`).
Tool calls do not need either. Server notifications that are sent on a request's
response stream (and every notification on `sse` / `websocket` / `stdio`) are
handled, including `notifications/tools/list_changed`.

## Automatic reconnect

When a server crashes (stdio exit), its socket/stream closes, its HTTP session
expires (`404`), it becomes unreachable, or it fails to connect at startup, the
gateway retries with exponential backoff:

```
delay(attempt) = min(maxDelayMs, initialDelayMs * multiplier^(attempt-1)) ± jitter
```

```yaml
reconnect:            # gateway-wide (defaults shown)
  enabled: true
  initialDelayMs: 1000
  maxDelayMs: 60000
  multiplier: 2
  jitter: 0.2
  maxAttempts: 0      # 0 = forever

servers:
  - id: flaky
    # ...
    reconnect:        # per-server override (any subset)
      maxAttempts: 5
```

Every reconnect re-runs the full MCP handshake (`initialize` → `notifications/initialized` → `tools/list`)
on a fresh connection, so the tool list is always current.

While a server is down, tool calls get `503` with `{"status": "reconnecting"}` and `Retry-After`.
`POST /api/v1/servers/:id/reconnect` reconnects immediately and resets the backoff.

### Where to see it

- `GET /api/v1/servers` / `GET /api/v1/servers/:id` → `health.status` (`online`, `degraded`,
  `reconnecting`, `offline`, `unknown`), `health.reconnect`
  (`state`: `idle | scheduled | connecting | gave-up | disabled`, `attempt`, `nextAttemptAt`,
  `lastError`, `lastDisconnectAt`, `reconnects`) and `session`
  (`transport`, `protocolVersion`, `serverInfo`, `connectedAt`).
- `GET /api/v1/health` → `status: degraded` while any server is reconnecting; `servers.reconnecting` count.
- `GET /api/v1/metrics` (JSON) → `servers: [{ id, status, up, reconnects, reconnectAttempt, latencyMs }]`.
- Prometheus → `mcp_gateway_server_up`, `mcp_gateway_server_status{status=…}`,
  `mcp_gateway_server_reconnects_total`, `mcp_gateway_server_reconnect_attempt`, `mcp_gateway_server_ping_ms`.
- The dashboard's server table shows the status, the next retry and the reconnect count.

## Protecting health and metrics

```yaml
auth:
  strategy: api-key
  apiKeys: ["..."]
  protect:
    health: true    # GET /api/v1/health requires auth
    metrics: true   # GET /api/v1/metrics requires auth
```

`GET /api/v1/health/live` always stays public and returns only `{"status":"ok"}` — use it
for Docker / Kubernetes liveness probes. For Prometheus, configure a bearer token
(see `examples/docker/prometheus.yml`).

## Hot reload

Saving the config file applies `servers`, `auth`, `rateLimit`, `corsOrigins`,
`monitor.requestLog`, `monitor.prometheus`, `reconnect` and `logLevel` immediately.
`port`, `host`, `monitor.retentionHours`, `healthCheckIntervalMs` and `dashboard` are
logged as “restart required”. Rate-limit counters restart when the rate-limit block changes.
An invalid file — or an auth block that cannot be used — is rejected and the running
settings are kept.
