# Agent identity & delegated auth (8.1)

AI agents calling tools usually borrow a user's API key — the audit log then cannot tell the user from the agent,
and the agent can do everything the user can. `agentIdentity` gives every agent its **own identity** and lets a user
**delegate** a narrow, short-lived slice of their access to it (OAuth 2.0 token exchange, RFC 8693 `act` semantics).

```yaml
agentIdentity:
  signingKey: ${AGENT_TOKEN_KEY}     # HMAC-SHA256 key, ≥ 32 characters
  issuer: mcp-gateway
  tokenTtlSeconds: 900               # default and maximum token lifetime
  maxDelegationDepth: 2              # agent → sub-agent chains
  requireAgentFor: ["payments/*"]    # these tools only accept agent tokens (-32019 otherwise)
  agents:
    - { id: travel-bot, name: Travel bot, tools: ["flights/*", "hotels/search"], delegators: ["jwt:*"] }
    - { id: booker, tools: ["flights/book", "payments/*"] }
```

## Flow

1. The user (an authenticated client matching the agent's `delegators`) asks for a token:
   `POST /api/v1/features/agent-identity/token` `{ "agent": "travel-bot", "tools": ["flights/*"], "ttlSeconds": 600 }`
   → `{ access_token, token_type: "agent+jwt", expires_in, scope, sub, act, jti }`.
   The scope is the intersection of the agent's `tools` and the requested `tools`.
2. The agent calls tools with it: `POST /api/v1/features/agent-identity/call`
   `{ "token": "…", "server": "flights", "tool": "search", "arguments": {…} }`. The call runs through the whole
   pipeline (policy, DLP, approvals, audit) as client `agent:<id>`; the response carries `onBehalfOf` and `chain`.
3. **Sub-agents**: an agent exchanges its token (`subjectToken`) for one for another agent. `sub` stays the user,
   `act` nests (`agent:booker` acting for `agent:travel-bot`), the scope narrows at every hop and the chain is capped
   by `maxDelegationDepth`.

Tokens are compact HS256 JWS (`typ: agent+jwt`) with `iss`, `sub`, `act`, `agent`, `scope`, `iat`, `exp`, `jti`.

## Operators

| | |
|---|---|
| `GET /api/v1/admin/agent-identity` | agents (active tokens each), issued / active / revoked counts, recent delegations |
| `POST /api/v1/admin/agent-identity/introspect` `{ token }` | RFC 7662-style `{ active, sub, act, scope, exp, chain }` |
| `POST /api/v1/admin/agent-identity/revoke` `{ jti }` | revoke a token (and every sub-agent token exchanged from it) |

Tools matched by `requireAgentFor` refuse direct calls with JSON-RPC **-32019** — useful for actions that must
always be attributable to an agent acting for a named user.
