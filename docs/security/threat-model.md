# Threat model

Scope: the Node.js gateway (`@winstonsayno/mcp-gateway`, `src/`) as of 10.1. The edge runtime (`/edge`), the client SDKs
and the dashboard demo on GitHub Pages are out of scope except where noted. This document is reviewed in every 10.x
minor release; report gaps through [private vulnerability reporting](../../SECURITY.md#reporting-a-vulnerability).

## Assets

| Asset | Where it lives | Why it matters |
|---|---|---|
| Client credentials (API keys, JWT / OAuth tokens) | config (`auth.apiKeys`, ideally `sha256:` digests), env `MCP_GATEWAY_API_KEYS` / `MCP_GATEWAY_ADMIN_KEY`, request headers | impersonation of any client, operator access |
| Upstream credentials | server `env` / `headers`, `secret://` references, `MCP_GATEWAY_*` env | access to the systems behind the tools (files, APIs, money) |
| The upstream processes and services themselves | `servers[]` (stdio child processes, HTTP/SSE endpoints) | a tool call is code execution / side effects on the user's behalf |
| Gateway configuration | YAML file, control plane, `POST /api/v1/admin/config` | whoever writes config chooses which commands run |
| Audit / usage / replay data | SQLite / Redis / memory | tool arguments and results may hold personal or secret data |
| mTLS identity | `mtls.identity` PEM files | impersonating the gateway to upstreams |

## Data flow

```
 MCP client / REST caller / dashboard
        │  HTTPS (TLS terminated here or at a reverse proxy)
        ▼
 ┌──────────────────────────── gateway process ────────────────────────────┐
 │ 1. network guards  ip allowlist · Host check (allowedHosts / DNS-rebinding) │
 │                    · body size limit · security headers · CORS / Origin       │
 │ 2. authentication  api-key (constant-time digest match) · jwt (jose) ·         │
 │                    oauth2 resource server (JWKS / introspection) · mTLS client │
 │                    → clientId (key:<name> | jwt:<sub> | oauth:<sub>) + scope    │
 │ 3. authorization   key / token scope (servers, tools) ∩ tenant confinement     │
 │                    · operator = unrestricted client · tenant role (viewer RO)  │
 │ 4. policy          tool policy / approvals · DLP / sanitize / redaction ·      │
 │                    rate limits · quotas · argument size limit                  │
 │ 5. routing         registry → balancer → circuit breaker → transport           │
 └────────────┬───────────────────────────────┬───────────────────────────────┘
              │ stdio (JSON-RPC lines)         │ HTTP / SSE (optionally mTLS + SPIFFE)
              ▼                                ▼
     child process (spawn, no shell)    remote MCP server
```

Admin traffic (`/api/v1/admin/*`, dashboard, control plane) takes the same path 1–3 and then requires an operator
(unrestricted) client or, for tenant routes, the tenant role the route documents.

## Trust boundaries

| # | Boundary | Trusted side | Untrusted side | Controls |
|---|---|---|---|---|
| B1 | network → gateway | gateway | every request byte (headers, Host, Origin, body) | auth, Host / Origin checks, size limits, rate limits, lockout |
| B2 | client → admin API | operators | tenant members, scoped keys | operator check (`isOperator`), tenant roles, scope intersection |
| B3 | tenant ↔ tenant | — | other tenants' members | server-glob confinement, viewer read-only, owner-only member management (exact ids, no operators) |
| B4 | gateway → upstream process | gateway | the child process and its output | `spawn` with an argument array (no shell), env without `MCP_GATEWAY_*`, stdout line cap, kill on overflow |
| B5 | gateway → remote upstream | gateway | the network and the remote server | TLS / mTLS, SPIFFE ID pinning (exactly one URI SAN), fail closed without identity, timeouts |
| B6 | upstream → client | client | tool output | output filters, DLP, injection sanitizer, redaction in logs / audit |
| B7 | config author → gateway | config author | — | config is code: whoever can write config (file, control plane, admin API) can run any command |

## Threats and mitigations (STRIDE summary)

| Threat | Example | Mitigation | Status |
|---|---|---|---|
| Spoofing a client | guessed / leaked API key | digests, constant-time compare, lockout, expiry, rotation | ✅ |
| Spoofing via token audience | token for another resource replayed with a forged `Host` | `auth.oauth.resource` / `audience`; startup warning when unset (10.1) | ⚠️ configure `resource` |
| Spoofing an upstream | MITM between gateway and upstream | TLS, mTLS + SPIFFE; forged quoted SAN entries ignored and multi-ID certificates refused (10.1) | ✅ |
| Tampering with tool calls | prompt-injected arguments | policy rules, approvals, DLP, sanitizer | partial (policy-dependent) |
| Command injection into stdio servers | `$(…)` in args | `spawn(command, args)` with `shell: false`; args are never shell-interpreted (test in 10.1) | ✅ |
| Information disclosure to upstreams | third-party MCP server reading the gateway's admin key from its env | `MCP_GATEWAY_*` stripped from child env (10.1) | ✅ |
| Information disclosure in logs | secrets in arguments / errors | redaction, hidden error details | ✅ |
| Tenant escalation / lateral movement | owner enrolling `*` or an operator into their tenant | owners may only grant exact, non-operator ids (10.1) | ✅ |
| Denial of service | huge bodies, huge stdout lines, slow upstreams | body / argument limits, 16 MiB line cap, timeouts, circuit breaker, rate limits | ✅ |
| Elevation via config | admin API writes a server with an arbitrary `command` | operator-only; treat operators as root on the host (B7) | by design |

## Known limitations / accepted risks

- **Operators are root-equivalent.** Any unrestricted client (an API key without `servers` / `tools` scope, a JWT or
  OAuth token without `mcp_servers` / `mcp_tools` claims, and that is in no tenant) is an operator and can change config,
  including stdio commands. With `auth.strategy: oauth2` every token of the authorization server without scope claims is
  an operator — issue scope claims or tenant memberships for end users.
- **OAuth client ids are `oauth:<sub>`** and do not include the issuer. With several `authorizationServers`, a `sub`
  from one issuer equals the same `sub` from another; only trust issuers that share a subject namespace.
- **Host-derived audience.** Without `auth.oauth.resource` the expected audience follows the request `Host`.
- **Experimental features** (TEE attestation, post-quantum TLS) are interface-level; see their guides.
- **Upstream processes run with the gateway's OS user.** Use containers / separate users for isolation; the gateway
  does not sandbox child processes.

## Audit log (10.1 baseline)

| Area | Finding | Fix |
|---|---|---|
| `src/transport/stdio.ts` (only `child_process` call site in `src/`; `worker_threads` in `plugins/wasm.ts` and `process.execPath` in `bench/` take no external input) | children inherited the whole gateway env incl. `MCP_GATEWAY_API_KEYS` / `MCP_GATEWAY_ADMIN_KEY` | `childEnv()` drops `MCP_GATEWAY_*`; explicit server `env` still wins |
| `src/transport/stdio.ts` | args concatenation / shell | none found (argument array, no shell); pinned with `shell: false` + test |
| `src/gateway/api.ts` tenant members | non-operator owner could add globs (`*`) or operator ids → confine operators / enrol other tenants' clients | exact non-operator ids only for owners |
| `src/security/mtls.ts` | naive SAN split accepted a forged entry inside a quoted value; multiple SPIFFE IDs accepted | quote-aware `splitSan()`, exactly one SPIFFE ID |
| `src/security/mtls.ts` | identity load failure fell back to system CAs without a client cert | fail closed |
| `src/auth/oauth.ts` | audience derived from `Host` when `resource` unset | startup warning + docs |
| `src/auth/tenants.ts` | glob matching is anchored and escaped; no issue | — |

## Audit log (10.2 test depth)

Property / fuzz tests (`test/property.test.ts`, fast-check), the admin authorization matrix
(`test/admin-auth-matrix.test.ts`: every mounted `/api/v1/admin/*` route × no auth / invalid key / scoped key /
tenant owner / cross-tenant owner) and regression tests (`test/regressions-10-2.test.ts`) found:

| Area | Finding | Fix |
|---|---|---|
| config pre-validation (`utils/deprecations.ts`) | `servers: {}` / `servers: ""` / non-array `auth.apiKeys` crashed with a `TypeError` instead of a validation error | non-array values reach the schema, which reports them |
| `GET /api/v1/servers[/:id]` (any authenticated client) | replica `url` credentials and query tokens, `headers`, `env` and `args` were returned unredacted | replicas are redacted like the primary |
| `GET /api/v1/admin/config` | URLs with `user:pass@` or secret query parameters were returned verbatim | masked (`<redacted>`), restored on PUT |
| `redactValue` (logs, audit, API output) | values nested deeper than 20 levels were returned unredacted | masked past the depth limit |
| defaults (`host` loopback + `auth` off) | no Host check and CORS `*`: a web page (or a DNS-rebinding attack) could drive the gateway through the browser, including state-changing admin calls via simple cross-site POSTs | DNS-rebinding protection is on by default in that setup: loopback Host check, loopback-only CORS, foreign `Origin` refused on non-GET requests |
| admin authorization matrix | all 150+ admin routes answer 401 / 403 for every non-operator caller | no issue |
| JWT / bearer parsing, JSON-RPC framing, argument size limits, Host parsing | no issue (properties hold) | — |
