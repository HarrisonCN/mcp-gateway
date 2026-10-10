# Threat model

Scope: the Node.js gateway (`@winstonsayno/mcp-gateway`, `src/`) as of **13.3**. The edge runtime (`/edge`), the client
SDKs and the dashboard demo on GitHub Pages are out of scope except where noted. The document is reviewed in every 13.x
minor release (it was last rewritten for the modular 13.x architecture in 13.3.0; the 10.x baseline audits are kept in
the appendix). Report gaps through [private vulnerability reporting](../../SECURITY.md#reporting-a-vulnerability).

## Architecture in one page (13.x)

13.0 split the gateway into a **core** and **feature modules**:

- **Core** (always loaded): config loader and schema, network guards, authentication (`src/auth`), the central
  authorizer and the per-call identity context, tool policy, the invoker (`src/gateway/invoker.ts`), registry,
  balancer, circuit breaker, transports (`src/transport`), the state store (`src/state`), the config generation
  manager (`src/gateway/generation.ts`) and telemetry (`src/observability`).
- **Feature modules** (`src/features/*`, listed in `src/features/manifest.ts`): evaluated only when their config
  section is present (or `kernel.modules: eager`). A module may register call hooks (before / after a call), admin
  routes under `/api/v1/admin/<id>` and client routes under `/api/v1/features/<id>`. No module imports another; the
  core imports only their schemas and the manifest (enforced by `test/kernel-13-0.test.ts`).
- **Lazy dependencies** (13.3.0): `jose` (JWT / OAuth), `ws` (WebSocket transport), `yaml` (config files) and the
  plugin-signature backend are imported on first use. Loading them later does not change any check: a JWT strategy
  that cannot load `jose` refuses the request, it never skips verification.

### Call path

```
 MCP client / REST caller / dashboard
        │  HTTPS (TLS terminated here or at a reverse proxy)
        ▼
 ┌──────────────────────────────────── gateway process ────────────────────────────────────┐
 │ 1. network guards   ip allowlist · Host check (allowedHosts / DNS-rebinding) · body limit  │
 │                     · security headers · CORS / Origin                                     │
 │ 2. authentication   api-key (constant-time digest match) · jwt · oauth2 resource server ·  │
 │                     mTLS client → Principal (issuer-qualified ids with several issuers)    │
 │ 3. identity context subject (who the call is FOR) · actors (agent hops) · effective scope  │
 │ 4. generation pin   the call acquires the current config generation (13.2.0)               │
 │ 5. authorization    scope ∩ every hop's grant ∩ tenant confinement · operator / roles      │
 │ 6. call hooks       feature modules in manifest order (policy-engine, DLP, sanitize,       │
 │                     approvals, budgets, rollouts, routing splits, caches, …)                │
 │ 7. final authz      re-run against the FINAL target + arguments until stable (13.1.0/13.1.3)│
 │ 8. final snapshot   frozen {subject, actors, server, tool, args digest, credential target, │
 │                     generation}; the send refuses any call that differs (13.1.3)            │
 │ 9. send             credentials of the final server only · balancer · breaker · transport  │
 └───────────────┬──────────────────────────────────────┬────────────────────────────────────┘
                 │ stdio (JSON-RPC lines)                │ HTTP / SSE / WS (optionally mTLS + SPIFFE)
                 ▼                                       ▼
        child process (spawn, no shell)           remote MCP server
                 ┆
   state store (memory / SQLite / event log / Redis) behind the store breaker (13.3.0):
   rate-limit windows, lockouts, revocation lists, quotas, sessions
```

Admin traffic (`/api/v1/admin/*`, dashboard, control plane) takes steps 1–2 and then requires an operator
(unrestricted) client or, for tenant routes, the tenant role the route documents.

## Assets

| Asset | Where it lives | Why it matters |
|---|---|---|
| Client credentials (API keys, JWT / OAuth tokens, agent delegation tokens) | config (`auth.apiKeys`, ideally `sha256:` digests), env `MCP_GATEWAY_API_KEYS` / `MCP_GATEWAY_ADMIN_KEY`, request headers | impersonation of any client or agent, operator access |
| Upstream credentials | server `env` / `headers`, `inject:` rules, `secret://` references, `MCP_GATEWAY_*` env | access to the systems behind the tools (files, APIs, money) |
| The upstream processes and services | `servers[]` (stdio children, HTTP / SSE / WS endpoints) | a tool call is code execution / side effects on the user's behalf |
| Gateway configuration and its generations | YAML file, control plane, `POST /api/v1/admin/config`, `POST /admin/reload` | whoever writes config chooses which commands run and which policy applies |
| Security state in the store | revocation lists (agent identity), rate-limit / lockout counters, quotas, budgets, sessions | a wrong answer from the store can un-revoke a token or lift a limit |
| Audit / usage / replay data, caches | SQLite / Redis / memory, tool and semantic caches | tool arguments and results may hold personal or secret data |
| Telemetry | `/metrics`, OTLP export, spans | must not become a side channel for principal ids or arguments |
| mTLS identity | `mtls.identity` PEM files | impersonating the gateway to upstreams |

## Trust boundaries

| # | Boundary | Trusted side | Untrusted side | Controls |
|---|---|---|---|---|
| B1 | network → gateway | gateway | every request byte (headers, Host, Origin, body) | auth, Host / Origin checks, size limits, rate limits, lockout |
| B2 | client → admin API | operators | tenant members, scoped keys, agents | operator check (`isOperator`), tenant roles, scope intersection |
| B3 | tenant ↔ tenant | — | other tenants' members | server-glob confinement, viewer read-only, owner-only member management; quotas / budgets / caches / credentials keyed on the subject's tenant |
| B4 | delegator → agent | delegator | the agent acting for it | agent scope = delegator scope ∩ token grant; rules naming an agent can only restrict; revocation list checked per call |
| B5 | core ↔ feature module | core | a module that failed to load / init / reconfigure, or misbehaves in a hook | per-module failure policy (`closed` for security modules), failure scope, final authorization + snapshot after all hooks |
| B6 | config generation N ↔ N+1 | the generation a call started in | a reload committed while the call is in flight | generation pin for config, credentials, session, policy, plugins; transactional reload with rollback |
| B7 | gateway → state store | gateway | a stalled, partitioned or out-of-step store | per-connection reply queues (Redis), store breaker, bounded SQLite lock wait, explicit `failureMode` |
| B8 | gateway → upstream process | gateway | the child process and its output | `spawn` with an argument array (no shell), env without `MCP_GATEWAY_*`, stdout line cap, hung-child recycle |
| B9 | gateway → remote upstream | gateway | the network and the remote server | TLS / mTLS, SPIFFE ID pinning, fail closed without identity, timeouts, resend only when provably undelivered |
| B10 | upstream → client | client | tool output | output filters, DLP, injection sanitizer, redaction in logs / audit |
| B11 | config author → gateway | config author | — | config is code: whoever can write config (file, control plane, admin API) can run any command |

## Security invariants (what the tests pin)

1. **One identity per call (13.1.2).** The subject — never the agent, never a module's own label — selects tenants,
   client policy rules, quotas, budgets, residency, per-tenant credentials and cache partitions; actors are recorded
   (`actor` / `chain` in audit) and can only narrow. With several trusted issuers, ids are `oauth:<issuer>#<sub>` /
   `jwt:<issuer>#<sub>` (MGW-2026-007, MGW-2026-008).
2. **Authorize the call that is sent (13.1.0 / 13.1.3).** After every hook, the authorizer, policy and every guard
   whose verdict was given on other arguments re-run against the final target and arguments until stable; approval
   holds sit on the final arguments (MGW-2026-001, MGW-2026-010).
3. **Final call snapshot (13.1.3).** The send compares server, tool, argument digest, subject and credential target
   with the frozen snapshot and refuses any difference; credentials are injected only for the server the call is
   sent to (MGW-2026-009).
4. **Fail closed on security modules (13.1.0 / 13.1.1).** A failed DLP, policy-engine, agent-identity, confidential,
   privacy, sanitize, approval-flows, anomaly or console module refuses the calls in its failure scope (-32026,
   audited) — the whole gateway when the scope cannot be determined (MGW-2026-002, MGW-2026-003).
5. **Generations (13.2.0).** A call runs entirely in the generation it started in; a reload either commits a new
   generation completely or rolls back with nothing half-applied; drained generations are retired when their last
   call ends (MGW-2026-004, MGW-2026-006, MGW-2026-011).
6. **Caches follow routing (13.1.1).** Splits are decided and authorized before any cache lookup; both caches key on
   the routed target and the subject's partition (MGW-2026-005).
7. **The store answers the question that was asked (13.3.0).** A Redis reply is matched only to the command written
   before it on the same connection; a connection that timed out or lost step is discarded with every command it
   carried (MGW-2026-012). A stalled store costs one timeout, then fails fast until a probe succeeds; the
   configured `failureMode` decides open / closed exactly as before.
8. **Resend only what was not delivered (13.3.0).** A call is resent once only when the upstream refused it
   unprocessed (HTTP 404 session expired) on a session opened before the attempt; an upstream's own JSON-RPC error is
   never taken for a transport failure, so it never triggers failover to another replica (re-running side effects).
9. **Telemetry carries no principal labels (13.3.0).** Metrics use bounded labels (server, upstream, principal
   *type*, reason, module); subject / actor ids appear only on spans, as a keyed HMAC by default
   (`observability.principal.mode: hash`).

## Threats and mitigations (STRIDE)

| Threat | Example | Mitigation | Status |
|---|---|---|---|
| Spoofing a client | guessed / leaked API key | digests, constant-time compare, lockout, expiry, rotation | ✅ |
| Spoofing across issuers | user `alice` of issuer A acting as `alice` of issuer B | issuer-qualified ids with several issuers (13.1.2) | ✅ |
| Spoofing via token audience | token for another resource replayed with a forged `Host` | `auth.oauth.resource` / `audience`; startup warning when unset | ⚠️ configure `resource` |
| Agent acting beyond its delegator | agent escapes delegator's deny rules, tenant quota or residency | identity context: subject keys every module, actors only narrow (13.1.2) | ✅ |
| Revoked agent token still accepted | revocation check answered with another key's value after a Redis timeout | per-connection reply queue; out-of-step connection discarded (13.3.0, 12.0.6, 10.9.7) | ✅ |
| Spoofing an upstream | MITM between gateway and upstream | TLS, mTLS + SPIFFE; forged quoted SAN entries ignored, multi-ID certificates refused | ✅ |
| Tampering by call hooks | hook rewrites target or arguments after the checks | final authorization loop + final call snapshot (13.1.0, 13.1.3) | ✅ |
| Tampering across reloads | held call sent with the next generation's server, credentials or policy | generation pin (13.2.0) | ✅ |
| Prompt-injected arguments / output | tool output steering the model | policy rules, approvals, DLP, sanitizer, output filters | partial (policy-dependent) |
| Command injection into stdio servers | `$(…)` in args | `spawn(command, args)` with `shell: false` | ✅ |
| Credential disclosure to the wrong upstream | split target receives the source server's `inject:` secret | credential target = final server (13.1.3) | ✅ |
| Information disclosure across tenants | shared cache entry served to another tenant / split target | cache keyed on routed target + subject partition (13.1.1, 13.1.2) | ✅ |
| Information disclosure in logs / telemetry | secrets in arguments; principal ids in metric labels | redaction, hidden error details; bounded labels, HMAC principal on spans (13.3.0) | ✅ |
| Repudiation | delegated call audited as the agent only | audit `clientId` = subject, `actor` / `chain` recorded | ✅ |
| Denial of service: requests | huge bodies, huge stdout lines, floods | body / argument limits, 16 MiB line cap, rate limits, quotas | ✅ |
| Denial of service: dependencies | stalled Redis / locked SQLite freezing every request; hung upstream never recycled | store breaker, `state.sqlite.busyTimeoutMs`, `health.restartAfter` (13.3.0) | ✅ |
| Duplicate side effects | upstream error taken for "not connected" and re-run on a replica | transport-failure classification (13.3.0) | ✅ |
| Fail-open of a security module | DLP fails to load, calls go through unfiltered | failure policy `closed`, failure scope (13.1.0, 13.1.1) | ✅ |
| Elevation via config | admin API writes a server with an arbitrary `command` | operator-only; treat operators as root on the host (B11) | by design |

## Failure modes of the store (B7) and what they mean for security

| Store state | Rate limit / lockout | Agent revocation list | `failureMode: closed` |
|---|---|---|---|
| healthy | counted | checked | — |
| one command times out | that command fails (open / closed per module); the connection is discarded | that check fails (agent-identity refuses: revocation is fail-closed) | refused |
| stalled (breaker open) | fails fast, no per-request wait | refused fast | refused fast |
| recovered (probe succeeded) | counted again | checked again | served |
| reply stream out of step (≤ 13.2.0 / 12.0.5 / 10.9.6) | a counter could read another key's value | a revocation check could read another key's value (MGW-2026-012) | — |

## Advisories since 13.0 and the boundary they crossed

| ID | Boundary | Invariant |
|---|---|---|
| MGW-2026-001 | B5 (hooks reroute after authz) | 2 |
| MGW-2026-002 / 003 | B5 (failed module) | 4 |
| MGW-2026-004 / 006 | B6 (reload) | 5 |
| MGW-2026-005 | B3 (caches × splits) | 6 |
| MGW-2026-007 | B4 (delegated identity) | 1 |
| MGW-2026-008 | B3 (issuer namespaces) | 1 |
| MGW-2026-009 | B9 (credentials × splits) | 3 |
| MGW-2026-010 | B5 (argument rewrites) | 2, 3 |
| MGW-2026-011 | B6 (calls across reloads) | 5 |
| MGW-2026-012 | B7 (Redis reply desync) | 7 |

Details, affected ranges and fixed versions: [SECURITY.md](../../SECURITY.md#advisories).

## Known limitations / accepted risks

- **Operators are root-equivalent.** Any unrestricted client (an API key without `servers` / `tools` scope, a JWT or
  OAuth token without `mcp_servers` / `mcp_tools` claims, and that is in no tenant) is an operator and can change config,
  including stdio commands. With `auth.strategy: oauth2` every token of the authorization server without scope claims is
  an operator — issue scope claims or tenant memberships for end users.
- **Host-derived audience.** Without `auth.oauth.resource` the expected audience follows the request `Host`.
- **Fail-open modules stay fail-open.** Rate limits, quotas and budgets with `failureMode: open` (the default for the
  store) let calls through while the store is unreachable — now without waiting, but still unlimited. Use
  `failureMode: closed` where a limit is a security control.
- **Redis is trusted.** The gateway does not authenticate replies beyond RESP framing; run Redis on a private network
  with `requirepass` / ACLs and TLS (`rediss://`).
- **Plugins run in-process** (except WASM plugins). A trusted plugin can do anything the gateway can; plugin signatures
  (`plugins.trust`) decide which code is trusted.
- **Experimental features** (TEE attestation, post-quantum TLS) are interface-level; see their guides.
- **Upstream processes run with the gateway's OS user.** Use containers / separate users for isolation; the gateway
  does not sandbox child processes ([stdio isolation](stdio-isolation.md)).

## Appendix: earlier audits (10.x baseline)

### Audit log (10.1 baseline)

| Area | Finding | Fix |
|---|---|---|
| `src/transport/stdio.ts` (only `child_process` call site in `src/`; `worker_threads` in `plugins/wasm.ts` and `process.execPath` in `bench/` take no external input) | children inherited the whole gateway env incl. `MCP_GATEWAY_API_KEYS` / `MCP_GATEWAY_ADMIN_KEY` | `childEnv()` drops `MCP_GATEWAY_*`; explicit server `env` still wins |
| `src/transport/stdio.ts` | args concatenation / shell | none found (argument array, no shell); pinned with `shell: false` + test |
| `src/gateway/api.ts` tenant members | non-operator owner could add globs (`*`) or operator ids → confine operators / enrol other tenants' clients | exact non-operator ids only for owners |
| `src/security/mtls.ts` | naive SAN split accepted a forged entry inside a quoted value; multiple SPIFFE IDs accepted | quote-aware `splitSan()`, exactly one SPIFFE ID |
| `src/security/mtls.ts` | identity load failure fell back to system CAs without a client cert | fail closed |
| `src/auth/oauth.ts` | audience derived from `Host` when `resource` unset | startup warning + docs |
| `src/auth/tenants.ts` | glob matching is anchored and escaped; no issue | — |

### Audit log (10.2 test depth)

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
