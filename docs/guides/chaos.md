# Chaos testing (8.8)

Resilience features only help when they actually work. `chaos` injects faults into selected tool calls so you can
watch retries, failover (federation, blue/green, rollouts), approvals and your agents deal with them — on demand or on
a schedule, always time-boxed.

```yaml
features:
  chaos:
    experiments:
      - id: slow-search
        servers: [search]
        tools: ["*"]
        clients: ["key:staging-*"] # start with test clients — the default is everyone
        percent: 25 # share of matching calls affected
        fault: {latencyMs: 1500}
        durationSeconds: 300
        abortIfErrorRateAbove: 0.5 # steady-state guard
        every: daily # optional: hourly | daily | weekly
      - id: github-flaky
        servers: [github]
        percent: 10
        fault: {errorRate: 0.5, timeoutRate: 0.1, timeoutMs: 20000, corruptRate: 0.05}
```

| Fault | Effect on an affected call |
|-------|---------------------------|
| `latencyMs` | delayed before it is sent upstream |
| `errorRate` | refused with JSON-RPC **-32021** (or `errorCode`) |
| `timeoutRate` | held for `timeoutMs`, then failed like an upstream timeout |
| `corruptRate` | a successful result is replaced with an error |

Experiments are idle until started: `POST /api/v1/admin/chaos/:id/start` (`{ durationSeconds }` overrides the
default), `POST …/:id/stop`, `POST /api/v1/admin/chaos/stop-all`. Scheduled experiments (`every`) start by
themselves. Each one stops after its duration, or is **aborted** when the error rate of the calls it matched exceeds
`abortIfErrorRateAbove` (after `minCallsForAbort` calls). `GET /api/v1/admin/chaos` shows state, injected faults and
the calls / errors observed.
