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
| `version` | — | | config schema version; optional, must be `3` when set |
| `cors.origins` | `["*"]` | ✓ | allowed browser origins: exact values, `*`, or `/regex/` |
| `health.intervalMs` | `30000` | restart | MCP `ping` interval (min 1000) |
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
  strategy: api-key            # none | api-key | jwt | oauth2
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

### OAuth 2.1 (MCP authorization spec)

`strategy: oauth2` makes the gateway an OAuth 2.1 *protected resource* as required by the MCP authorization
specification. MCP clients discover the authorization server from the gateway itself.

```yaml
auth:
  strategy: oauth2
  oauth:
    authorizationServers: ["https://auth.example.com"]   # issuers advertised in the metadata
    resource: "https://gw.example.com/mcp"               # canonical resource URI (RFC 8707); default: derived from Host
    # issuer / audience default to authorizationServers / resource
    # jwksUrl: https://auth.example.com/jwks             # default: jwks_uri from the issuer's RFC 8414 / OIDC metadata
    introspection:                                       # optional, for opaque tokens (RFC 7662)
      url: https://auth.example.com/oauth/introspect
      clientId: mcp-gateway
      clientSecret: "${INTROSPECTION_SECRET}"
      cacheSeconds: 60
    scopesSupported: ["mcp:tools", "mcp:resources"]
    requiredScopes: ["mcp:tools"]
    algorithms: ["RS256", "ES256"]                       # asymmetric only
```

- `GET /.well-known/oauth-protected-resource` and `/.well-known/oauth-protected-resource/mcp` serve RFC 9728 metadata.
- Missing / invalid tokens → `401` with `WWW-Authenticate: Bearer resource_metadata="…", error="invalid_token"`;
  missing `requiredScopes` → `403` with `error="insufficient_scope", scope="…"`.
- JWTs must carry `exp`, an accepted `iss` and an `aud` matching the resource; introspected tokens must be `active`.
- The `mcp_servers` / `mcp_tools` claims restrict a token like a scoped key (see *Per-key scopes*).
- Client ids are `oauth:<sub>` (or `oauth:<client_id>`).

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

## Quotas and metering

```yaml
quotas:
  meteringRetentionDays: 35        # hourly usage buckets kept for the export
  rules:                            # every matching rule must have room
    - name: per-key-daily
      limit: 10000
      period: day                   # hour | day | month (UTC calendar periods)
    - name: free-tier
      clients: ['key:free-*']
      servers: [search]
      tools: ['search_*']
      limit: 100
      period: month
    - name: team-pool
      per: tenant                   # one counter per tenant (shared by its members)
      tenants: [acme]
      limit: 50000
      period: month
```

- Over quota → JSON-RPC `-32007`; REST `429` with `Retry-After` (seconds to the period reset) and `quota` details.
  Quotas are checked after the policy, before the cache and the upstream server.
- **Metering export**: `GET /api/v1/usage?group=client,tenant,server,tool,hour,day&since=&until=&client=&tenant=&server=`
  as JSON, or `&format=csv` (RFC 4180, formula-injection safe). `GET /api/v1/quotas` — current counters per rule and
  subject with `resetsAt`. Operators see everything; tenant admins / owners see their tenant (`?tenant=`).
- Counters and buckets are in memory per instance (reset on restart).

## Upstream catalog

```yaml
catalog:
  builtins: true                 # reference servers: filesystem, memory, everything, sequential-thinking, fetch, git, time, github
  sources:                       # extra catalogs: JSON files (relative to this file) or http(s) URLs
    - ./catalog.json
    - https://example.com/mcp-catalog.json
  install: true                  # allow one-click install via API / dashboard (default false — it spawns processes)
  serversFile: installed-servers.json   # keep installed servers across restarts (default: runtime only)
```

A catalog source is `[...]` or `{ "entries": [...] }` of:

```json
{ "id": "my-db", "name": "My DB", "description": "…", "homepage": "https://…", "tags": ["db"],
  "template": { "transport": "stdio", "command": "npx", "args": ["-y", "my-db-mcp"] },
  "env": [{ "name": "DB_URL", "required": true, "secret": true }],
  "args": [{ "name": "schema", "default": "public" }] }
```

- `GET /api/v1/catalog` — entries plus where each is installed; `POST /api/v1/catalog/:id/install`
  `{ serverId?, name?, env?, args?, tags? }` → `201 { server, connected, persisted }`; `DELETE /api/v1/catalog/servers/:id`.
  Operator keys only (scoped / tenant-confined keys get `403`).
- `env` values go to the process environment (stdio) or replace `${VAR}` in the template's `url` / `headers` (remote).
- Installed servers are tagged `catalog` and `catalog:<entry id>`; ids from the config file win on clashes; they survive
  hot reloads. The dashboard's *Servers* tab has an *Add a server* card.

## Tenants and roles (RBAC)

```yaml
tenants:
  - id: platform
    name: Platform team
    servers: ['github', 'fs-*']        # server id globs that belong to the workspace
    members:                           # client id globs: key:<api key name>, jwt:<sub>, oauth:<sub>
      - { client: 'key:alice', role: owner }
      - { client: 'key:ci-*',  role: admin }
      - { client: 'jwt:*',     role: viewer }
```

| Role | Sees the tenant's servers, tools, resources | Calls tools, decides approvals | Manages members |
|---|:-:|:-:|:-:|
| `viewer` | ✓ | | |
| `admin` | ✓ | ✓ | |
| `owner` | ✓ | ✓ | ✓ |

- A client that is a member of at least one tenant is confined to the union of its tenants' servers, on top of its own
  key / token scope; tool calls (REST and `/mcp`) need `admin` or `owner` on the target server's tenant.
- Clients that belong to no tenant keep full (operator) access, so adding tenants never locks operators out.
- Approvals: tenant admins / owners see and decide held calls for their tenants' servers only.
- API: `GET /api/v1/tenants`, `GET /api/v1/tenants/:id`, `PUT /api/v1/tenants/:id/members` `{client, role}`,
  `DELETE /api/v1/tenants/:id/members/:client` (owners and operators; a tenant keeps at least one owner). Runtime
  member changes are **not written back** to the config file. The dashboard shows a *Workspaces* card with role
  selectors for owners. Hot reloadable.

## Load balancing and failover

A server can be backed by several upstream endpoints. The primary keeps the server id; each entry in `replicas`
overrides transport fields of the primary and is connected as an internal server `<id>~<n>` (its tools are served
under the logical id, never on their own).

```yaml
servers:
  - id: github
    name: GitHub
    transport: streamable-http
    url: https://mcp-a.example.com/mcp
    headers: { Authorization: "Bearer ${GITHUB_TOKEN}" }
    replicas:
      - url: https://mcp-b.example.com/mcp
      - url: https://mcp-c.example.com/mcp
        weight: 2
    loadBalancing:
      strategy: round-robin        # round-robin (default) | random | weighted | least-latency | failover
      failoverOn: [not-connected]  # also: timeout, error (may run a non-idempotent tool twice)
      retries: 2                   # extra attempts per call (default: members - 1)
      ejectAfter: 3                # consecutive failed calls before a member is skipped (0 = never)
      ejectMs: 30000
```

Health checks: the periodic ping (`health.intervalMs`) runs on every member; members that are disconnected,
`degraded` / `offline`, or ejected are skipped. When all members are unhealthy, all are tried in order. Each member
reconnects on its own with the `reconnect` policy. Tools come from the primary, or from a replica while the primary
has none. `GET /api/v1/load-balancing` shows members, health, latency (EWMA) and ejections. Hot reloadable.

## Federation (3.6)

```yaml
federation:
  gatewayId: us-east                  # this gateway, as its peers know it
  region: us-east-1
  sharedSecret: "${FEDERATION_SECRET}" # ≥ 32 chars, same on every peer (HMAC-SHA256 request signing)
  peers:
    - { id: eu-west, url: https://eu.gateway.example, region: eu-west-1, priority: 1 }
    - { id: ap-south, url: https://ap.gateway.example, priority: 2 }
  export: ["*"]                       # local servers visible to peers (default all)
  import: ["*"]                       # peer servers accepted (default all)
  sync: { intervalSeconds: 30 }       # catalog pull
  failover: { servers: ["github", "search*"] }   # forward calls when the local server is down
```

- **Peering:** peers call `GET /api/v1/federation/catalog` and `POST /api/v1/federation/call` with an
  `x-mcp-federation: <gatewayId>:<ms>:<hmac>` header (±5 min skew). Only configured peer ids are accepted; client
  credentials are not used on these two endpoints.
- **Catalog sync:** every peer's exported servers (status, tool names) are pulled every `sync.intervalSeconds`;
  `GET /api/v1/federation` shows peers, health, latency, last sync and forwarded calls.
- **Cross-region failover:** a call to a local server matching `failover.servers` that is not connected (all
  replicas down) is forwarded to the best healthy peer exporting it online (lowest `priority`, then latency). The
  peer runs it under client id `peer:<gatewayId>` through its own policy, quotas and audit. Forwarded calls are never
  forwarded again.
- **Remote servers:** `POST /api/v1/tools/call` with `server: "<id>@<peer>"` calls a server that only a peer has
  (client scopes apply to the full `<id>@<peer>` id).

## Secrets (3.5)

```yaml
secrets:
  cacheSeconds: 300                 # resolved values are cached this long
  rotation: { intervalSeconds: 900 }   # re-resolve and reconnect servers whose credentials changed
  providers:
    - { id: vault, type: vault, address: https://vault.example:8200, token: "${VAULT_TOKEN}", mount: secret }
    # or AppRole: roleId / secretId (re-login on 403); namespace for Vault Enterprise
    - { id: kms, type: aws-kms, region: eu-west-1 }      # credentials from AWS_* env when not set here
    - { id: gkms, type: gcp-kms, token: "${GCP_TOKEN}" }
    - { id: files, type: file }                          # paths relative to this file
    # `env` is always available: secret://env/NAME

servers:
  - id: github
    env: { GITHUB_PERSONAL_ACCESS_TOKEN: "secret://vault/mcp/github#token" }
  - id: search
    url: https://search.example/mcp
    headers: { Authorization: "Bearer secret://kms/AQICAHh…" }   # KMS: path = base64 ciphertext
    inject:                                                     # per-call, per-tenant credentials
      - { ref: "secret://vault/tenants/{tenant}/search#key", argument: api_key }
      - { ref: "secret://vault/clients/{client}/search#token", meta: authorization, format: "Bearer {value}" }
```

- `secret://<provider>/<path>[#field]` may appear in a server's `env`, `headers`, `url` and `args`. References are
  resolved when the server (re)connects; the registry, `GET /servers`, the audit log and config diffs only see the
  reference. A provider outage keeps the last good value.
- **Rotation:** every `rotation.intervalSeconds` (or `POST /api/v1/secrets/rotate`) the references are read again;
  a server whose resolved credentials changed is reconnected with them.
- **Per-tenant injection:** `inject` adds a credential to every call — a tool argument or a `_meta` field — after
  plugins, policy, cache keys and request capture, so it never reaches logs or the replay debugger. `{tenant}` is
  the caller's first tenant, `{client}` its client id. A call that needs `{tenant}` from a caller without one is
  refused (`-32010`) unless `required: false`.
- `GET /api/v1/secrets` lists providers and references with version / fetched / rotated times — never values.

## Smart routing (3.4)

```yaml
routing:
  splits:
    - name: search-canary
      server: search            # the id clients call
      tools: ["brave_*"]        # optional tool globs (default: all tools)
      sticky: client            # client (default): one client always sees one variant | none: per call
      variants:
        - { server: search, weight: 90, label: stable }
        - server: search-v2     # another server exposing the same tools
          weight: 10
          label: canary
          guard: { maxErrorRate: 0.2, maxLatencyMs: 2000, minCalls: 20 }   # automatic rollback

servers:
  - id: postgres
    cost: 3                     # relative cost per call (smart strategy)
    replicas: [{ url: https://replica.example/mcp, cost: 1 }]
    loadBalancing:
      strategy: smart           # score = latency·w + errorRate·w + cost·w, lowest first
      score: { latency: 1, errorRate: 2, cost: 0.5 }
```

- **Splits** are A/B or canary traffic shares between servers. Variant selection is a stable hash of client id +
  split name (`sticky: client`) or random per call. A variant whose `guard` trips (error rate or EWMA latency over
  `minCalls` calls) is rolled back to weight 0 until `POST /api/v1/routing/splits/:name/reset`; a disconnected
  variant gets no traffic.
- **`strategy: smart`** orders replicas by a score of EWMA latency, EWMA error rate and `cost`, each normalised to
  the group maximum. Defaults: `latency: 1, errorRate: 1, cost: 0`.
- `GET /api/v1/routing` shows split stats and smart scores. Hot reloadable.

## Tool result caching

Caching is opt-in per tool. Calls that match no rule are never cached.

```yaml
cache:
  maxEntries: 1000            # LRU
  defaultTtlSeconds: 60
  rules:                      # first match wins
    - tools: ['github/search_*', 'docs/*']
      ttlSeconds: 300
      scope: client           # default: a cache per caller; `shared` = one for everybody
    - servers: [weather]
      tools: [forecast]
      scope: shared
    - tools: [expensive_report]
      dedupeOnly: true        # share identical in-flight calls, never cache
```

- Key: server, tool, canonical JSON of the arguments (key order does not matter) and — with `scope: client` — the
  caller id. Only successful results that are not `isError` are cached.
- **In-flight de-duplication** (`dedupe`, default on): identical calls arriving while the first one runs share its
  upstream request (they also share its cancellation).
- Order: plugins `onToolCall` → policy → **cache** → upstream → output filter → `onResponse`. Refused calls never
  reach the cache; the output filter runs on cached results too.
- `GET /api/v1/cache` (stats: entries, hits, misses, deduped, evictions), `DELETE /api/v1/cache[?server=id]` (purge).
  Changing `cache:` purges the cache (hot reload). The cache is in memory per instance.

## Replay debugger

```yaml
replay:
  enabled: true        # default false: keep redacted arguments / results of recent calls in memory
  maxEntries: 500      # calls kept
  maxBytes: 65536      # per captured arguments / result; larger payloads are not kept
  results: true        # also capture results (for diffs)
```

The audit log stores metadata only. With `replay.enabled` the History view of the dashboard opens any captured call
(arguments, result) and replays it — with the same or edited arguments — through the normal pipeline (auth,
scopes, policy, quotas), then diffs the two results. Captured payloads are redacted with the secret patterns
(`security.redactPatterns` included), so a replay sends `***` where a secret was. Restart not required.

## Admin API

```yaml
admin:
  configApi: true   # allow PUT /api/v1/admin/config and POST /api/v1/admin/reload (default false)
```

See [Declarative config](guides/declarative-config.md). 3.0 removed `corsOrigins` and `healthCheckIntervalMs` — use
`cors.origins` and `health.intervalMs` ([migration guide](guides/migrating-to-v3.md)).

## Bridges (OpenAI / A2A)

```yaml
openai:                 # OpenAI-compatible tools proxy (on when the block is present)
  path: /openai/v1
  maxToolRounds: 5
  upstream: { baseUrl: https://api.openai.com/v1, apiKey: sk-... }
a2a:                    # Agent2Agent bridge (off by default)
  enabled: true
  path: /a2a
  public: false
```

See the [bridges guide](guides/bridges.md).

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

## Tool policy

```yaml
policy:
  default: allow               # decision when no rule matches: allow | deny | approve
  rules:                       # first match wins
    - name: no-deletes
      effect: deny
      tools: ["delete_*", "github/delete_*"]
      message: "Deleting is disabled on this gateway"
    - name: fs-sandbox
      effect: deny
      tools: ["fs/write_file", "fs/edit_file"]
      args: [{ path: path, notUnder: ["/workspace"] }]      # ".." is resolved first
    - name: aura-may-file-issues
      effect: allow
      clients: ["key:aura"]
      tools: ["github/create_issue"]
    - name: review-github-writes
      effect: approve           # held until approved in the dashboard / API
      servers: ["github"]
      tools: ["create_*", "update_*", "merge_*"]
    - name: no-shell-pipes
      effect: deny
      tools: ["shell/run"]
      args: [{ path: command, regex: "[|;&`$]" }]
  approval:
    timeoutSeconds: 300        # unanswered → denied
    allowSelfApproval: false   # the calling client cannot approve its own call
  outputFilter:
    action: redact             # redact (default) | flag | block
    builtins: true             # built-in prompt-injection detectors
    patterns: ["(?i)BEGIN PRIVATE KEY"]
    tools: ["web/*", "fetch"]  # default: every tool
```

**Rule conditions** (all must hold): `clients` (globs on client ids: `key:<name>`, `jwt:<sub>`, `oauth:<sub>`,
`anonymous`), `servers`, `tools` (a pattern with `/` matches `<server>/<tool>`) and `args`, a list of matchers on
argument values addressed by dotted path (`path`, `options.mode`, `files.0`) with operators `exists`, `equals`, `in`,
`glob`, `notGlob`, `regex`, `notRegex`, `longerThan`, `under`, `notUnder`. The `not…` operators only match when the
value is present. Policies apply to tool calls from REST and `/mcp` and are hot reloadable.

**Results:** `deny` → REST `403` / JSON-RPC `-32003` with `data.rule`; an approval that is denied, expires or is
cancelled → `403` / `-32004`. Refusals appear in the request log as failed calls.

**Approvals:** `GET /api/v1/approvals` (pending + recent), `GET /api/v1/approvals/:id`,
`POST /api/v1/approvals/:id/approve` / `deny` (optional `{"reason": "…"}`). The dashboard shows a *Pending approvals*
card with Approve / Deny buttons. Scoped clients cannot list or decide approvals.

**Output filter:** scans `content[].text`, embedded resource text and `structuredContent` of tool results for
prompt-injection phrasings ("ignore previous instructions", fake `<system>` tags, system-prompt exfiltration, tool
hijacking, markdown-image exfiltration URLs, hidden Unicode). `redact` replaces matches with `[filtered]`, `flag` keeps
the text; both add `_meta["mcp-gateway/flags"]`. `block` replaces the result with an error (`502` on REST,
`isError: true` result on `/mcp`). `GET /api/v1/policy` shows findings per detector. These are heuristics: they
lower, not remove, injection risk.

Policy rules can also live in version-controlled files (`policy.files`) with unit tests run by
`mcp-gateway policy test` — see [Policy as code](guides/policy-as-code.md).

## Plugins

```yaml
plugins:
  - module: ./plugins/my-plugin.mjs   # path relative to this file, or a package name
    name: my-plugin                   # optional override
    enabled: true
    options: { any: value }           # passed to a factory export as ctx.options
```

Hooks: `onRequest` (Express middleware after the network guards), `onToolCall` (before policy; rewrite arguments,
`deny`, or `respond`), `onResponse` (after the output filter). Hook failures refuse the call (`-32006`). Hot
reloadable (file change or `SIGHUP`). See [Plugins](guides/plugins.md).

### WASM plugins (3.3)

```yaml
plugins:
  - wasm: ./plugins/pii-guard.wasm    # instead of module: — any language that compiles to WebAssembly
    isolation: tenant                 # tenant (default) | client | shared — one sandbox per key
    limits:
      timeoutMs: 100                  # per hook call (default 100)
      memoryMb: 16                    # linear memory cap (default 16)
      maxInstances: 64                # sandboxes kept; least recently used closed beyond this
```

Each sandbox is a worker thread with its own module instance: no WASI, no file system, no network, only an
`env.log` import. Traps, timeouts, memory overruns and invalid output refuse the call (`-32006`) and the sandbox is
recreated on the next call. `GET /api/v1/plugins` lists plugins and live sandboxes.

## Observability

```yaml
monitor:
  prometheus: true             # GET /metrics and /api/v1/metrics?format=prometheus
observability:
  tracing:
    enabled: true
    exporter: otlp-http        # otlp-http (built-in) | console | otel-api (@opentelemetry/api + your SDK)
    endpoint: http://otel-collector:4318/v1/traces   # default: $OTEL_EXPORTER_OTLP_TRACES_ENDPOINT or localhost:4318
    headers: { "x-honeycomb-team": "${HONEYCOMB_KEY}" }
    serviceName: mcp-gateway
    resourceAttributes: { deployment.environment: prod }
    sampleRatio: 1.0           # for new traces; an incoming sampled traceparent is always followed
```

- **Tracing**: one span per upstream call (`mcp.tools/call <tool>`, `mcp.resources/read <uri>`,
  `mcp.prompts/get <name>`) for REST and `/mcp`, with `mcp.server.id`, `mcp.tool.name`, `mcp.via`, `mcp.client.id`,
  `mcp.duration_ms`, `mcp.success`, `mcp.error.code`. A W3C `traceparent` request header makes the span a child of the
  caller's trace; responses carry the gateway span's `traceparent`. Spans are batched (every 2 s / 256 spans) and
  exported as OTLP/HTTP JSON — no OpenTelemetry SDK needed. `otel-api` delegates to a TracerProvider you register.
- **Prometheus**: `GET /metrics` (conventional scrape path; protected with `auth.protect.metrics`) adds a latency
  histogram `mcp_gateway_request_duration_seconds{server}` (buckets 5 ms … 30 s) to the existing counters and gauges.
- **Dashboard**: request rate, latency (p50 / p95), error rate, top tools, usage per key and calls per server charts.

## MCP endpoint

```yaml
mcp:
  enabled: true                # restart
  path: /mcp                   # restart; not "/", /api/…, /dashboard/…
  toolNaming: auto             # auto | prefix
  pageSize: 500                # items per list page (1–10000)
  sessionIdleTimeoutSeconds: 1800
  maxSessions: 1000            # least recently used idle session evicted beyond this
  allowedOrigins: ["https://app.example.com"]   # default: cors.origins
  instructions: "Tools for the ACME workspace"  # returned from initialize
  eventBufferSize: 256         # events kept per session for Last-Event-ID replay (0 = off)
  passthrough:                 # 3.1: upstream → client requests relayed to the calling MCP client
    sampling: true             # sampling/createMessage
    elicitation: true          # elicitation/create
    roots: true                # roots/list + notifications/roots/list_changed
    timeoutSeconds: 300        # how long to wait for the client's answer
```

**Sampling / elicitation / roots passthrough (3.1):** the gateway announces `sampling`, `elicitation` and `roots`
to upstream servers (per the features enabled above) and relays their requests to the downstream MCP client whose
call is in flight — on that call's SSE reply when the client accepts `text/event-stream`, else on its `GET` stream.
The client's answer goes back to the server unchanged. Matching is by the gateway's upstream progress token, else the
only when every in-flight call to that server comes from the same client (never across clients). A client that did not announce the capability gets `-32601`; calls made over REST
have no client to ask (`-32001`), and `roots/list` then answers an empty list. `notifications/roots/list_changed` from
a client is forwarded to the servers in its scope. Set `passthrough: false` on a server to keep it isolated.

**Resumability:** every server-to-client event on the `GET` stream carries a session-wide `id`. A client whose stream
dropped reconnects with `Last-Event-ID: <last id>` and receives the events it missed (up to `eventBufferSize`),
including notifications emitted while no stream was open.

## Shared state (multi-instance)

```yaml
state:
  store: redis                 # memory (default) | redis — restart required
  redis:
    url: "redis://:${REDIS_PASSWORD}@redis:6379/0"   # rediss:// for TLS; env MCP_GATEWAY_REDIS_URL also works
    keyPrefix: "mcp-gateway:"  # namespace several gateways in one Redis
    connectTimeoutMs: 5000
    commandTimeoutMs: 5000
  failureMode: open            # open: Redis outage lets requests through; closed: reject them
```

With `store: redis`, every gateway replica shares:

- **rate limits** — the global `rateLimit` and per-key `rateLimit` sliding windows count requests on all replicas;
- **brute-force lockouts** — failures on any replica count towards `security.authLockout`, and a locked IP is locked everywhere;
- **MCP sessions** — session metadata (client id, protocol version, client info) is stored with the idle TTL, so a
  session opened on one replica is accepted by the others: no sticky sessions needed for `POST /mcp`. Open `GET`
  streams stay on the replica that holds the socket (the per-session replay buffer is per replica).

The Redis client is built in (RESP2, pipelined, `AUTH` / `SELECT` / TLS); no extra dependency. Embedders can pass any
`StateStore` implementation: `new Gateway(config, { stateStore })`.

## Audit log

```yaml
audit:
  enabled: false
  path: mcp-gateway-audit.db   # relative to the working directory; parent dirs are created
  retentionDays: 30            # 0 = keep forever
```

Requires Node.js 22.5+ (`node:sqlite`); the Docker image ships Node 22. Stores request metadata only.

Forward audit records to a SIEM with `audit.export` (syslog or webhooks) — see
[SIEM export](guides/policy-as-code.md#audit-export-to-a-siem).

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
| `dnsRebindingProtection` | `Host` must be in `allowedHosts` (default: `localhost`, `127.0.0.1`, `[::1]` and the bind address), and `/mcp` accepts browser requests only from the same origin, loopback origins and origins listed in `mcp.allowedOrigins` / `cors.origins` (`*` ignored). Recommended for a local gateway without auth. |
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
(`mcp-any-origin`), API keys expiring within 7 days (`api-keys-expiring`), `cors.origins: ["*"]` with auth
(`cors-wildcard`), `security.headers: false` (`headers-disabled`), `exposeErrorDetails: true` (`error-details`).
Hints: plain-text or short API keys (`plaintext-api-keys`, `short-api-keys`), JWT without issuer / audience or
`requireExp` (`jwt-no-issuer-audience`, `jwt-no-exp`), no `authLockout` (`no-auth-lockout`).
