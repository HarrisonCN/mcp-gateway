# SLA monitoring & credit reports (9.5)

Define service-level objectives for the tools you offer — per upstream server and per tenant — and let the gateway
measure them on every call, track the error budget and compute service credits when an objective is missed.

```yaml
version: 11
features:
  sla:
    targets:
      - id: search-gold
        servers: ["search*"]
        tenants: ["*"]
        availability: 99.9 # % of successful calls in the window
        latencyP95Ms: 800
        windowDays: 30 # rolling
        monthlyFee: 2000
        currency: EUR
        credits:
          - {below: 99.0, percent: 25}
          - {below: 99.9, percent: 10}
        excludeErrorCodes: [-32003] # refusals that are not the provider's fault
```

## How it is measured

Every tool call that matches a target (server glob, tenant glob — calls without a tenant are `-`) is counted in an
hourly bucket: calls, failures and a log-scale latency histogram (p95 is reported as the histogram bound, e.g.
`500` means "≤ 500 ms"). Failures with a code in `excludeErrorCodes` are not counted at all. Memory is bounded by
`windowDays × 24` buckets per target. Counters are per gateway instance and reset on restart.

## API

- `GET /api/v1/admin/sla` — per target: `calls`, `failures`, `availability`, `latencyP95Ms`, `errorBudget`
  (`allowedFailures`, `remaining`, `remainingPercent`), `met`, `breaches`, `credit` and per-tenant availability.
- `GET /api/v1/admin/sla/report?target=search-gold&format=csv` — the credit report (one row per target and one per
  tenant); `format=json` adds `totalCredit`.
- `POST /api/v1/admin/sla/reset` — clear the counters (e.g. at the start of a billing period).

The lowest matching credit tier wins: with the tiers above, 98.7 % availability earns 25 %, 99.5 % earns 10 %.
