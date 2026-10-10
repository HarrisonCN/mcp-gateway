# Agent identity & delegated auth (8.1)

AI agents calling tools usually borrow a user's API key — the audit log then cannot tell the user from the agent,
and the agent can do everything the user can. `agentIdentity` gives every agent its **own identity** and lets a user
**delegate** a narrow, short-lived slice of their access to it (OAuth 2.0 token exchange, RFC 8693 `act` semantics).

```yaml
features:
  agentIdentity:
    signingKey: ${AGENT_TOKEN_KEY} # HMAC-SHA256 key, ≥ 32 characters
    issuer: mcp-gateway
    tokenTtlSeconds: 900 # default and maximum token lifetime
    maxDelegationDepth: 2 # agent → sub-agent chains
    requireAgentFor: ["payments/*"] # these tools only accept agent tokens (-32019 otherwise)
    agents:
      - {id: travel-bot, name: Travel bot, tools: ["flights/*", "hotels/search"], delegators: ["jwt:*"]}
      - {id: booker, tools: ["flights/book", "payments/*"]}
```

## Flow

1. The user (an authenticated client matching the agent's `delegators`) asks for a token:
   `POST /api/v1/features/agent-identity/token` `{ "agent": "travel-bot", "tools": ["flights/*"], "ttlSeconds": 600 }`
   → `{ access_token, token_type: "agent+jwt", expires_in, scope, sub, act, jti }`.
   The scope is the intersection of the agent's `tools` and the requested `tools`.
2. The agent calls tools with it: `POST /api/v1/features/agent-identity/call`
   `{ "token": "…", "server": "flights", "tool": "search", "arguments": {…} }`. The call runs through the whole
   pipeline (policy, DLP, approvals, quotas, budgets, residency, caches, audit) **for the user** — see *Identity
   context* below; the response carries `onBehalfOf` and `chain`. Refusals answer with the same HTTP status as the
   REST tool call (403 policy, 429 quota / budget, …).
3. **Sub-agents**: an agent exchanges its token (`subjectToken`) for one for another agent. `sub` stays the user,
   `act` nests (`agent:booker` acting for `agent:travel-bot`), the scope narrows at every hop and the chain is capped
   by `maxDelegationDepth`.

Tokens are compact HS256 JWS (`typ: agent+jwt`) with `iss`, `sub`, `act`, `agent`, `scope`, `iat`, `exp`, `jti`.

## Authorization model (11.1)

A delegation token never grants more than the client that requested it may call. The effective permission of every
agent call is the intersection of

1. the **original caller's current scope** — its API key `servers` / `tools` (re-resolved on every call; a removed key
   may call nothing) or, for JWT / OAuth clients, the scope snapshot taken at issuance (`dsc` claim);
2. its **tenant** confinement and write role (viewers cannot call tools);
3. the **token grant** (agent `tools` ∩ requested `tools` ∩ parent token for sub-agents);
4. the server's tool filter and the configured tool **policy**.

The check runs in the gateway's single authorization point (`authorize()` in the invoker), the same one REST, `/mcp`,
chains, task graphs and plugins use.

**Strict narrowing.** A requested entry is granted only when it is (a) identical to an allowed pattern, (b) a literal
`server/tool` an allowed pattern matches, or (c) any other glob, resolved to the concrete tools currently known that
both match. `vault/read*` is therefore never granted from `vault/read?` — only the existing `vault/readX`-style tools.
A restricted delegator's grant is always a list of concrete tool names.

## Identity context (13.1.2)

Every call has one identity context (`auth/identity`):

| Fact | Delegated call | Used by |
|---|---|---|
| **subject** | the token's `sub` — the user who delegated | client policy rules, tenant membership, quotas, budgets, data residency, per-tenant credentials (`inject` `{tenant}` / `{client}`), tool cache `scope: client`, semantic cache `scope: tenant` / `client`, metering, costs, the audit record's `clientId` |
| **actors** | `agent:<id>` per hop, outermost first | audit `actor` / `chain`, span `mcp.actor`, policy rules that name the agent |
| **effective scope** | user scope ∩ every hop's grant | the central authorizer |

Two users of different tenants who share one agent therefore never share cache entries, quotas or budgets, and an
agent never escapes its user's client-specific deny rules or data residency. Policy rules whose `clients` name an
agent explicitly (`agent:travel-bot`, `agent:*`; a bare `*` does not count) still apply to that agent's calls but can
only restrict: `deny` refuses, `approve` holds, `allow` changes nothing. The same rule applies to calls feature modules
make for a request (replays, debug sessions, adaptive retries, task graphs, plugin routes): the requesting client is
the subject, the component label (`replay:…`) is recorded as the actor.

Request records of delegated calls (`GET /api/v1/requests`, the SQLite audit log, SIEM export) carry
`clientId: "key:alice"`, `actor: "agent:booker"` and `chain: ["key:alice", "agent:travel-bot", "agent:booker"]`.

## Revocation (11.2)

Revocations (`POST /api/v1/admin/agent-identity/revoke`) and issued-token records are stored in the gateway's shared
state store with a TTL equal to the token's expiry, so a revoked token stays revoked across restarts and on every
instance:

| `store.backend` | Use |
|---|---|
| `redis` | several instances / Kubernetes |
| `sqlite`, `eventlog` | one node, durable across restarts |
| `memory` | development only (the gateway logs a posture notice) |

```yaml
features:
  agentIdentity:
    revocation:
      failureMode: closed   # default: store unreachable → agent calls (and sub-token exchange, introspection) answer 503
```

`failureMode: open` accepts tokens while the store is down (answering from the local cache). Both cases are counted
and logged at error level; alert on `mcp_gateway_agent_revocation_store_errors_total` and
`mcp_gateway_agent_store_unavailable_total{decision}` (Prometheus, `monitor.prometheus: true`).
`GET /api/v1/admin/agent-identity` reports `revocation: { store, failureMode, shared, … }`.

## Operators

| | |
|---|---|
| `GET /api/v1/admin/agent-identity` | agents (active tokens each), issued / active / revoked counts, recent delegations |
| `POST /api/v1/admin/agent-identity/introspect` `{ token }` | RFC 7662-style `{ active, sub, act, scope, exp, chain }` |
| `POST /api/v1/admin/agent-identity/revoke` `{ jti }` | revoke a token (and every sub-agent token exchanged from it) |

Tools matched by `requireAgentFor` refuse direct calls with JSON-RPC **-32019** — useful for actions that must
always be attributable to an agent acting for a named user.
