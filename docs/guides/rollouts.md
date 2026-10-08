# Tool versioning and gradual rollout (7.5)

Ship a new version of an upstream MCP server without a big-bang switch: register it as its own server and put a
**rollout** in front of the one clients already call.

```yaml
servers:
  - { id: search,    name: Search,    transport: streamable-http, url: https://search-v1.internal/mcp }
  - { id: search-v2, name: Search v2, transport: streamable-http, url: https://search-v2.internal/mcp }
rollouts:
  - id: search-v2
    stable: search            # what clients call
    canary: search-v2         # the new version (same tool names)
    tools: ["*"]              # which tools of the stable server roll out (globs)
    percent: 10               # share of clients sent to the canary
    clients: ["key:beta-*"]   # always on the canary
    exclude: ["key:billing"]  # never on the canary
    autoRollback: { maxErrorRate: 0.2, minCalls: 20, window: 200 }
```

- **Sticky:** a client's bucket is a hash of its id and the rollout id, so each client consistently sees one version
  while `percent` is unchanged, and raising `percent` only adds clients.
- **Visible:** canary results carry `_meta["mcp-gateway/rollout"]` (`id`, `version: "canary"`, `server`); metrics and the
  audit log record the canary server.
- **Safe:** errors (failed calls and `isError` results) are tracked per version over the last `window` calls; when
  the canary's error rate exceeds `maxErrorRate` after `minCalls`, the rollout rolls back to 0 % on its own.
- Clients keep calling the stable server id — no client change is needed. Policies and scopes are checked against
  the server the client named.

## Admin API

| | |
|-|-|
| `GET /api/v1/admin/rollouts[/:id]` | effective and configured percent, state (`active` / `promoted` / `rolled-back`, with reason), calls / error rates per version |
| `POST /api/v1/admin/rollouts/:id/percent` | `{ percent }` |
| `POST /api/v1/admin/rollouts/:id/promote` | 100 % |
| `POST /api/v1/admin/rollouts/:id/rollback` | 0 % for everyone, `clients` included, until `reset` |
| `POST /api/v1/admin/rollouts/:id/reset` | back to the configured percent |

These are runtime overrides; add `?persist=true` to write `percent` into the running config
(`controlPlane.configApi: true`). Once promoted, swap the servers in the config and remove the rollout.

Feature modules can reroute calls: a call hook's `before` may return `{ serverId }` (7.5).
