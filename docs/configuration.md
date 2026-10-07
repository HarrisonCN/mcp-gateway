# Configuration reference

mcp-gateway reads the first file found of `mcp-gateway.yml`, `mcp-gateway.yaml`, `mcp-gateway.json`,
`.mcp-gateway.yml`, `.mcp-gateway.yaml` in the working directory, or the path given with `-c`.
Generate a commented starter file with `mcp-gateway init`; check a file with `mcp-gateway validate -c <file>`.

Invalid configuration is rejected with every problem listed (`- path.to.key: message`); an invalid file during
hot reload is rejected and the running configuration kept.

## Environment overrides

| Variable | Overrides |
|---|---|
| `MCP_GATEWAY_PORT` | `port` |
| `MCP_GATEWAY_HOST` | `host` |
| `MCP_GATEWAY_LOG_LEVEL` | `logLevel` |
| `MCP_GATEWAY_API_KEYS` | comma-separated keys → `auth.strategy: api-key`, `auth.apiKeys` (other `auth` settings from the file are kept) |

`${VAR}` references are expanded from the gateway's environment in `servers[].env`, `servers[].args`,
`servers[].headers` and object-form `auth.apiKeys[].key`. A `.env` file in the working directory is loaded.

## Top level

| Key | Default | Hot reload | |
|---|---|---|---|
| `port` | `4000` | restart | HTTP port |
| `host` | `0.0.0.0` | restart | bind address |
| `logLevel` | `info` | ✓ | `debug` \| `info` \| `warn` \| `error` |
| `corsOrigins` | `["*"]` | ✓ | allowed browser origins: exact values, `*`, or `/regex/` |
| `healthCheckIntervalMs` | `30000` | restart | MCP `ping` interval (min 1000) |
| `dashboard.enabled` | `true` | restart | serve `/dashboard` |
| `servers` | `[]` | ✓ | see [Servers](#servers) |
| `auth` | none | ✓ | see [Authentication](#authentication) |
| `rateLimit` | none | ✓ | see [Rate limiting](#rate-limiting) |
| `reconnect` | see below | ✓ | see [Reconnect](#reconnect) |
| `monitor` | see below | partly | see [Monitoring](#monitoring) |
| `mcp` | see below | partly | see [MCP endpoint](#mcp-endpoint) |
| `audit` | off | restart | see [Audit log](#audit-log) |

## Servers

```yaml
servers:
  - id: github                 # required, unique
    name: GitHub               # required
    description: GitHub tools
    transport: stdio           # stdio | streamable-http | sse | websocket
    command: npx               # stdio: required
    args: ["-y", "@modelcontextprotocol/server-github"]
    env: { GITHUB_PERSONAL_ACCESS_TOKEN: "${GITHUB_TOKEN}" }
    tags: [vcs]
    enabled: true              # default true
    timeout: 30000             # ms per request, incl. time queued for maxConcurrency (default 30000)
    maxConcurrency: 10         # in-flight requests to this server (default 10)
    tools:                     # optional tool filter (globs * and ?; deny wins)
      allow: ["read_*", "list_*"]
      deny: ["*_secret"]
    reconnect: { maxAttempts: 5 }   # per-server override of the reconnect block

  - id: remote
    name: Remote
    transport: streamable-http # also: sse (http/https URL), websocket (ws/wss URL)
    url: https://mcp.example.com/mcp
    headers: { Authorization: "Bearer ${REMOTE_TOKEN}" }
    subprotocol: mcp           # websocket only; "" requests none
```

Changing a server (any field) reconnects it on hot reload; removing or disabling disconnects it.

## Authentication

```yaml
auth:
  strategy: api-key            # none | api-key | jwt   (oauth2 is rejected: not implemented)
  apiKeys:
    - "admin-key"              # plain string: full access
    - key: "${AURA_KEY}"       # object: optionally restricted
      name: aura               # client id "key:aura" (unique; [A-Za-z0-9._-]{1,64})
      servers: ["github", "fs-*"]
      tools: ["read_*", "github/create_issue"]
      rateLimit: { limit: 30, windowSeconds: 60 }
  # jwtSecret: "…"             # strategy jwt: HS256/384/512, ≥ 32 characters recommended
  protect:
    health: false              # true → /api/v1/health requires auth
    metrics: false             # true → /api/v1/metrics requires auth
```

Misconfiguration fails closed: `api-key` without keys, `jwt` without a secret or an unknown strategy refuse to
start (and are rejected on hot reload, keeping the current auth).

### Per-key scopes

| Field | Meaning |
|---|---|
| `servers` | server-id globs the key may use. Absent = all, `[]` = none |
| `tools` | tool globs. A pattern containing `/` matches `<serverId>/<tool>`, otherwise the tool name. Absent = all, `[]` = none |
| `rateLimit` | `{ limit, windowSeconds }` — own bucket instead of the global `rateLimit` |
| `name` | label used as client id in logs, metrics, history and MCP sessions |

JWT: claims `mcp_servers` / `mcp_tools` (array, or a space/comma-separated string). A malformed claim allows nothing.

Scopes stack with each server's `tools` filter. Resources and prompts are scoped by `servers` only.

## Rate limiting

```yaml
rateLimit:
  limit: 100                   # requests per window
  windowSeconds: 60
  perKey: true                 # false = one global bucket
```

Sliding-window counter, in memory (per gateway instance). Counters reset when the block changes.

## Reconnect

```yaml
reconnect:
  enabled: true
  initialDelayMs: 1000
  maxDelayMs: 60000
  multiplier: 2
  jitter: 0.2                  # ±20 %
  maxAttempts: 0               # 0 = forever
```

## Monitoring

```yaml
monitor:
  requestLog: true             # log every call (hot reload ✓)
  prometheus: false            # Prometheus text on /api/v1/metrics (hot reload ✓)
  retentionHours: 24           # in-memory history / metrics window (restart)
```

## MCP endpoint

```yaml
mcp:
  enabled: true                # restart
  path: /mcp                   # restart; not "/", /api/…, /dashboard/…
  toolNaming: auto             # auto | prefix
  pageSize: 500                # items per list page (1–10000)
  sessionIdleTimeoutSeconds: 1800
  maxSessions: 1000            # least recently used idle session evicted beyond this
  allowedOrigins: ["https://app.example.com"]   # default: corsOrigins
  instructions: "Tools for the ACME workspace"  # returned from initialize
```

## Audit log

```yaml
audit:
  enabled: false
  path: mcp-gateway-audit.db   # relative to the working directory; parent dirs are created
  retentionDays: 30            # 0 = keep forever
```

Requires Node.js 22.5+ (`node:sqlite`); the Docker image ships Node 22. Stores request metadata only.
