# Configuration reference

mcp-gateway reads the first file found of `mcp-gateway.yml`, `mcp-gateway.yaml`, `mcp-gateway.json`,
`.mcp-gateway.yml`, `.mcp-gateway.yaml` in the working directory, or the path given with `-c`.
Generate a commented starter file with `mcp-gateway init`; check a file with `mcp-gateway validate -c <file>`
(it also prints [security warnings](#security-warnings); `--strict` exits with code 2 when there are any).

Invalid configuration is rejected with every problem listed (`- path.to.key: message`); an invalid file during
hot reload is rejected and the running configuration kept.

## Environment overrides

| Variable | Overrides |
|---|---|
| `MCP_GATEWAY_PORT` | `port` |
| `MCP_GATEWAY_HOST` | `host` |
| `MCP_GATEWAY_LOG_LEVEL` | `logLevel` |
| `MCP_GATEWAY_API_KEYS` | comma-separated keys (plain or `sha256:<hex>`) → `auth.strategy: api-key`, `auth.apiKeys` (other `auth` settings from the file are kept) |

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
| `security` | see below | ✓ | see [Security](#security) |

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
    - "sha256:2c26b46b…"       # the SHA-256 digest of a key (mcp-gateway hash-key) — recommended
    - key: "${AURA_KEY}"       # object: optionally restricted
      name: aura               # client id "key:aura" (unique; [A-Za-z0-9._-]{1,64})
      servers: ["github", "fs-*"]
      tools: ["read_*", "github/create_issue"]
      rateLimit: { limit: 30, windowSeconds: 60 }
      expiresAt: "2027-01-01"  # rejected (401) from this moment on (ISO 8601 date / date-time)
      disabled: false          # true: rejected without removing the entry
  # jwtSecret: "…"             # strategy jwt: HS256/384/512, ≥ 32 characters recommended
  # jwt: { … }                 # see "JWT" below
  protect:
    health: false              # true → /api/v1/health requires auth
    metrics: false             # true → /api/v1/metrics requires auth
```

Misconfiguration fails closed: `api-key` without keys, `jwt` without a key source or an unknown strategy refuse to
start (and are rejected on hot reload, keeping the current auth).

### Hashed keys

`key` (or a plain string entry) may be `sha256:<64 hex chars>`: the gateway compares the SHA-256 digest of the
presented key in constant time, so the config file never contains a usable credential. Create one with:

```sh
mcp-gateway gen-key                     # random key (mgw_…) + its digest; give the key out, store the digest
echo -n "$EXISTING_KEY" | mcp-gateway hash-key
```

A digest entry and the plain form of the same key produce the same client id (`key:<fingerprint>` or `key:<name>`),
so switching to digests keeps metrics, history and rate-limit buckets. Expired / disabled keys get `401`; open
`/mcp` sessions opened with them end on the next reload.

### JWT

```yaml
auth:
  strategy: jwt
  # exactly one key source:
  jwtSecret: "${JWT_SECRET}"                    # HMAC (HS256/384/512)
  jwt:
    # publicKey: |                              # PEM SPKI public key or certificate (RS/PS/ES/EdDSA)
    #   -----BEGIN PUBLIC KEY-----
    # jwksUrl: https://idp.example.com/.well-known/jwks.json   # https (http only for localhost)
    jwksCacheSeconds: 600                       # JWKS cache; unknown "kid" triggers a refetch (30 s cooldown)
    issuer: https://idp.example.com/            # required "iss" (string or list)
    audience: mcp-gateway                       # required "aud" (string or list)
    algorithms: [RS256]                         # default: every algorithm of the key type
    clockToleranceSeconds: 30                   # skew allowed on exp / nbf / iat (default 0)
    requireExp: true                            # reject tokens without "exp" (default false)
    maxTokenAgeSeconds: 3600                    # reject tokens whose "iat" is older
```

HMAC and asymmetric algorithms are never mixed (an `algorithms` entry that does not fit the key source is a
configuration error), which rules out algorithm-confusion attacks. With `jwksUrl` the gateway acts as an OAuth 2.0
resource server for any provider that issues JWT access tokens.

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

## Security

```yaml
security:
  headers: true                # nosniff, X-Frame-Options, Referrer-Policy, COOP/CORP, CSP (default true)
  hsts: false                  # true or { maxAgeSeconds, includeSubDomains } — only behind HTTPS
  trustProxy: false            # Express "trust proxy": true, hop count, or addresses / CIDRs of your proxies
  ipAllowlist: ["10.0.0.0/8", "127.0.0.1", "::1"]   # only these clients (IPv4 / IPv6 / CIDR)
  allowedHosts: ["gateway.example.com", "*.internal.example.com"]   # Host header allowlist
  dnsRebindingProtection: false
  maxBodyBytes: 10485760       # JSON request body limit (REST and /mcp), min 1024
  maxToolArgumentsBytes: 0     # limit for tools/call, prompts/get and completion arguments; 0 = none
  authLockout: false           # true, or { maxFailures: 10, windowSeconds: 300, lockoutSeconds: 900 }
  redactPatterns: []           # extra regexes masked in logs, request / audit log and API output
  exposeErrorDetails: false    # send messages / stacks of unexpected 500s to clients
```

Everything hot reloads.

| Key | Behaviour |
|---|---|
| `headers` | API responses get `Content-Security-Policy: default-src 'none'; frame-ancestors 'none'`; the dashboard gets a CSP that allows exactly its inline script (SHA-256 hash), same-origin `fetch` and inline styles. |
| `trustProxy` | decides `req.ip`, used by rate limits, lockout, the IP allowlist and logs. Leave `false` unless a proxy you control sets `X-Forwarded-For`. |
| `ipAllowlist` | other clients get `403`. `/api/v1/health/live` and `/health/ready` stay open for probes. |
| `allowedHosts` | requests with another `Host` get `403` (probes excepted). |
| `dnsRebindingProtection` | `Host` must be in `allowedHosts` (default: `localhost`, `127.0.0.1`, `[::1]` and the bind address), and `/mcp` accepts browser requests only from the same origin, loopback origins and origins listed in `mcp.allowedOrigins` / `corsOrigins` (`*` ignored). Recommended for a local gateway without auth. |
| `maxBodyBytes` | larger bodies get `413` (REST) / `413` + JSON-RPC error (`/mcp`). |
| `maxToolArgumentsBytes` | REST: `413`; `/mcp`: JSON-RPC `-32602`. |
| `authLockout` | after `maxFailures` failed authentications (`401`) from one IP within `windowSeconds`, that IP gets `429` + `Retry-After` for `lockoutSeconds` on every authenticated route, including `/mcp`. A success resets the count. In-memory, per instance. Only active with an auth strategy. |
| `redactPatterns` | added to the built-in redaction (Bearer / Basic tokens, JWTs, OpenAI / Anthropic / GitHub / GitLab / Slack / AWS / Google keys, `password=` / `token=` / `api_key=` pairs, URL credentials, and values under secret-looking keys such as `authorization`, `token`, `password`). |
| `exposeErrorDetails` | off by default; `NODE_ENV=development` also turns it on. |

Upstream error messages are redacted before they are recorded, and `GET /servers` masks `env`, `headers`, URL
credentials / query values and secret-looking `args` (`--token x`, `--api-key=x`, token-shaped values).

### Security warnings

At startup the gateway logs warnings (and hints) for risky settings; `mcp-gateway validate` prints them and
`GET /api/v1/security` returns them. Warnings: auth disabled on a non-loopback bind (`auth-disabled-public-bind`),
local gateway without auth or DNS-rebinding protection (`dns-rebinding`), `/mcp` open to any origin
(`mcp-any-origin`), API keys expiring within 7 days (`api-keys-expiring`), `corsOrigins: ["*"]` with auth
(`cors-wildcard`), `security.headers: false` (`headers-disabled`), `exposeErrorDetails: true` (`error-details`).
Hints: plain-text or short API keys (`plaintext-api-keys`, `short-api-keys`), JWT without issuer / audience or
`requireExp` (`jwt-no-issuer-audience`, `jwt-no-exp`), no `authLockout` (`no-auth-lockout`).
