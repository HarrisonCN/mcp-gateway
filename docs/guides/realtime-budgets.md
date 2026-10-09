# Real-time cost and carbon budgets (10.6)

`costs.budgets` (4.3) count **calendar** periods (UTC day / month). `features.realtimeBudgets` adds **sliding-window**
budgets (for example "at most $2 in any hour") per client, per tenant or for the whole gateway, on two metrics:

- `cost` — priced with the existing `costs` table (`costs.tools[].perCall`, and `costs.models` per 1K tokens from the
  `_meta.usage` an upstream reports);
- `carbon` — an **estimate** in grams of CO2e: energy per call (plus per input / output token when usage is
  reported) × grid carbon intensity. The defaults are placeholders, not measurements; the gateway cannot measure the
  energy an upstream or model provider actually uses. Set factors from your providers' published data.

```yaml
costs:
  tools: [{ match: "llm/*", perCall: 0.01 }]
features:
  realtimeBudgets:
    carbon:
      gridIntensity: 400            # gCO2e per kWh (default)
      servers: { "eu-*": 250 }      # per-server intensity (globs)
      perCallWh: 0.02               # default energy per call
      perInputTokenWh: 0.0003
      perOutputTokenWh: 0.0012
      tools: [{ match: "llm/*", perCallWh: 0.5 }]
    budgets:
      - name: agent-hourly-spend
        metric: cost
        per: client                 # client | tenant | global
        clients: ["key:agent-*"]    # optional filters: clients, tenants, tools (globs)
        windowSeconds: 3600
        limit: 2
        warnAt: [0.8]               # alert fractions (default [0.8]); 1.0 always alerts
        onExceed: downgrade         # reject (default) | downgrade | warn
        downgrade: { server: llm-small, args: { model: gpt-4o-mini } }
      - name: tenant-carbon-daily
        metric: carbon
        per: tenant
        windowSeconds: 86400
        limit: 500                  # grams CO2e
        onExceed: reject
        webhook: https://hooks.example.com/budgets
```

## What happens at the limit

Usage is checked **before** a call and recorded **after** a successful call, so the call that crosses the limit
completes and the next one is affected.

- `reject` — the call is refused without contacting the upstream:
  - REST (`POST /api/v1/tools/call`): **`429 Too Many Requests`** with `Retry-After` (seconds until enough usage
    leaves the window) and `{ error, message, code: -32013, budget: { decision: "budget", budget, metric, used,
    limit, windowSeconds, retryAfterSeconds } }`.
  - MCP (`/mcp` `tools/call`): JSON-RPC error `{ code: -32013, message, data: { decision: "budget", … } }`.
- `downgrade` — the call proceeds with `downgrade.args` merged over its arguments and / or routed to
  `downgrade.server`.
- `warn` — the call proceeds; only alerts fire.

Alerts (warnings at each `warnAt` fraction and "exceeded" at 100 %) fire once per window per subject: they are
logged, listed by `GET /api/v1/admin/realtime-budgets/alerts` and POSTed to `webhook` as
`{ "type": "realtime-budget.alert", … }`.

> Since 10.6 the **calendar** budgets (`costs.budgets` with `action: block`) also answer REST `429` with
> `Retry-After` (time until the period resets); before 10.6 they surfaced as `502`. The JSON-RPC code (`-32013`) is
> unchanged. DLP blocks share code `-32013` but carry `data.decision: "dlp"`.

## Admin API (operators)

| Method | Path | |
|---|---|---|
| `GET` | `/api/v1/admin/realtime-budgets` | Budgets with rejected / downgraded counters, current usage per subject, carbon factors |
| `GET` | `/api/v1/admin/realtime-budgets/alerts` | Recent alerts (newest first, max 500) |
| `POST` | `/api/v1/admin/realtime-budgets/estimate` | `{ server, tool, usage? }` → priced cost and carbon estimate |
| `POST` | `/api/v1/admin/realtime-budgets/reset` | Clear windows, alerts and counters |

## Limits

- State is in memory, per process: with N replicas each enforces the full limit on its own traffic (up to N × limit
  in total), and a restart clears the windows.
- Windows are 60 buckets wide (`windowSeconds / 60` resolution).
- Failed calls are not counted.
