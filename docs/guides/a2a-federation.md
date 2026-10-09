# Cross-gateway A2A federation (8.2)

The A2A bridge (`a2a.enabled`) publishes a gateway's tools as an A2A agent. `a2aFederation` is the other side: a
gateway **discovers** remote A2A agents — other mcp-gateways in other regions or organisations, or any A2A 0.3 agent —
and lets its own clients and agents **forward tasks** to them, under one trust and audit model.

```yaml
features:
  a2aFederation:
    gatewayId: us-east # sent to remotes in message metadata (default mcp-gateway/<version>)
    refreshSeconds: 60 # agent cards are re-read on this interval
    timeoutMs: 15000
    remotes:
      - id: eu
        url: https://gw-eu.example.com # card at <url>/.well-known/agent-card.json
        token: ${EU_A2A_TOKEN} # bearer for the remote (its API key)
        skills: ["search*", "translate"] # skill-id globs exposed locally (default all)
        clients: ["key:ops-*", "agent:*"] # local clients allowed to use it (default all)
```

| | |
|---|---|
| `GET /api/v1/features/a2a-federation/skills` | remote skills the caller may use, as `<skill>@<remote>` |
| `POST /api/v1/features/a2a-federation/send` `{ remote, skill, arguments? }` | A2A `message/send` to the remote; returns its Task |
| `GET /api/v1/admin/a2a-federation` | remotes, card status, skills, the last forwarded tasks |
| `POST /api/v1/admin/a2a-federation/refresh` | re-read every agent card now |

**Trust.** The remote authenticates the gateway with its bearer `token` and applies its own policy, scopes and
audit to every task. Each task carries `metadata.federation = { gateway, client }`, so the remote can see which
gateway and which local client (for 8.1 delegated agents: `agent:<id>`) asked. Locally, `clients` limits who may use
a remote, `skills` what they may call, and every forwarded task is kept in the recent log.

Pairs with [agent identity](agent-identity.md): an agent acting for a user can reach tools on a remote gateway without
the user's credentials ever leaving the local one.
