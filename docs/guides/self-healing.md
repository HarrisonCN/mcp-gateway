# Self-healing (9.6)

The gateway already sees every call's outcome and latency. Self-healing rules turn that into action without a human
in the loop — and undo it again once the cool-down is over.

```yaml
version: 10
features:
  selfHealing:
    windowSeconds: 60
    minCalls: 20
    rules:
      - id: search-down
        servers: ["search"]
        when: {errorRateAbove: 0.5}
        action: eject
        fallback: search-backup # omit to refuse calls instead
        cooldownSeconds: 120
      - id: search-v2-bad
        servers: ["search-v2"]
        when: {errorRateAbove: 0.1, p95Above: 1500}
        action: rollback
        rollbackTo: search
        cooldownSeconds: 900
      - id: github-slow
        servers: ["github"]
        when: {p95Above: 3000}
        action: throttle
        maxPerSecond: 5
        cooldownSeconds: 60
```

## Actions

| Action | While active |
|--------|--------------|
| `eject` | calls to the server go to `fallback`, or are refused with JSON-RPC **-32025** (`ERR_SELF_HEALING`, `data.retryAfterSeconds`) |
| `rollback` | calls go to `rollbackTo` — pair it with [rollouts](rollouts.md) or [blue/green](blue-green.md) upstream ids |
| `throttle` | `maxPerSecond` calls pass, the rest are refused with -32025 |

A rule trips when any `when` condition holds over the last `windowSeconds` with at least `minCalls` calls. After
`cooldownSeconds` the action is lifted and the window starts fresh, so a server that is still unhealthy trips the rule
again (with a new history entry). Each trip, lift and clear is logged.

## Operators

- `GET /api/v1/admin/self-healing` — rules, active actions (refused / rerouted counts), per-server stats, history.
- `POST /api/v1/admin/self-healing/:id/trigger` `{ "server": "search" }` — act now (drills, maintenance).
- `POST /api/v1/admin/self-healing/:id/clear` `{ "server"?: … }` — lift early.
