# Zero-downtime blue/green upgrades (8.5)

`rollouts` (7.5) move traffic to a new upstream version gradually. **Blue/green** is the all-at-once alternative:
run the old (blue) and new (green) version side by side, check that green is healthy, then switch every call in one
step — and switch back just as fast.

```yaml
servers:
  - {id: search-v1, transport: streamable-http, url: https://search-v1.internal/mcp}
  - {id: search-v2, transport: streamable-http, url: https://search-v2.internal/mcp}
features:
  blueGreen:
    - id: search
      blue: search-v1 # the server id clients call
      green: search-v2
      active: blue
      tools: ["*"] # tools affected (globs)
      probe: {tool: health, arguments: {}}
      verify: {seconds: 120, maxErrorRate: 0.1, minCalls: 10}
```

1. Deploy green next to blue and add it to `servers` (hot reload).
2. `POST /api/v1/admin/blue-green/search/switch` — the gateway calls the `probe` tool on green; only when it
   succeeds is traffic switched (409 otherwise; `{ "force": true }` overrides). Clients keep calling `search-v1`.
3. Calls already running on blue finish there (**drain**); `GET /api/v1/admin/blue-green` shows `inFlight` per colour —
   retire blue when it reaches 0.
4. For `verify.seconds` after the switch the new colour's error rate is watched; above `maxErrorRate` (after
   `minCalls` calls) the gateway **rolls back automatically**. `POST …/rollback` does it by hand.

The switch is a runtime state (not written to the config): set `active` in the config once you are happy, so a
restart keeps the new colour.

**Upgrading the gateway itself:** with the 7.0 control plane, start new data planes on the new version, wait for
`GET /api/v1/admin/data-planes` to show them in sync, move the load balancer, and stop the old ones; their in-flight
calls complete on shutdown.
