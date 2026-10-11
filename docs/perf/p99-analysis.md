# End-to-end p99 analysis (13.8)

Where the time of a tool call goes, per pipeline stage, measured with the stage timer added in 13.8
(`GET /api/v1/perf/stages`, `mcp_gateway_stage_duration_ms`) under `bench/load.mjs` (seed 42, 16 workers, 4000
requests, the 13.3.0 operation mix, API-key auth, rate limit, cache, quotas, budgets and policy rules in the hot path).

## Reference: 13.3.0 baseline on x64 CI

`bench/baseline.json` → `load.platforms.linux-x64.ci` (GitHub-hosted `ubuntu-latest`, Node 22): **774 req/s,
p95 37.5 ms, p99 47.2 ms**. The CI job `Load + faults (Node 22)` compares every PR with it (gross regressions only)
and, since 13.8, publishes the stage breakdown as a check-run annotation (`load <version>`), so the numbers for a
release can be read from the PR's checks.

## Stages

| Stage | What it covers |
|---|---|
| `queue` | waiting for admission (`overload:` only) |
| `auth` | HTTP authentication: API key / JWT / OAuth, lockout, tenant scope (plus the rate limit on REST) |
| `authz` | the central authorizer (scope, delegation, tool exposure) |
| `policy` | plugin `onToolCall`, policy rules / approvals, residency, quotas, budgets |
| `hooks` | feature-module call hooks (before + after) and the output filter |
| `routing` | final authorization, routing split, security snapshot |
| `cache` | cache lookup / store and in-flight de-duplication (excluding the upstream call it wraps) |
| `upstream` | the upstream call: secrets, balancing, failover, resend, the round trip itself |
| `finish` | `onResponse` plugins, metrics, request log |
| `total` | the whole call inside the invoker |

## Results: x64 CI (13.8.0, authoritative)

`Load + faults (Node 22)` on PR #178 (GitHub-hosted linux-x64, 4 CPU, Node v22.23.3), same seed / mix as the baseline:
**743.6 req/s, p50 19.8 ms, p95 39.1 ms, p99 47.8 ms**, max 68.3 ms, 0 % errors — against the 13.3.0 baseline
(774 req/s, p95 37.5 ms, p99 47.2 ms): −3.9 % throughput, +1.6 ms p95, +0.6 ms p99, within run-to-run noise of a
shared runner (no regression; the always-on stage timer included).

| Stage | p50 ms | p95 ms | p99 ms | mean ms | calls |
|---|---:|---:|---:|---:|---:|
| auth | 0.019 | 0.030 | 0.050 | 0.021 | 4000 |
| authz | 0.001 | 0.003 | 0.004 | 0.002 | 4000 |
| policy | 0.045 | 0.072 | 0.095 | 0.049 | 4000 |
| hooks | 0.010 | 0.016 | 0.031 | 0.011 | 4000 |
| routing | 0.024 | 0.040 | 0.064 | 0.026 | 4000 |
| cache | 0.007 | 0.046 | 0.072 | 0.013 | 4000 |
| upstream | 8.148 | 27.271 | 34.928 | 9.185 | 3434 |
| finish | 0.023 | 0.055 | 0.082 | 0.027 | 4000 |
| total | 7.406 | 25.986 | 34.523 | 8.048 | 4000 |

The gateway's own stages add up to ≈0.4 ms at p99 (≈0.15 ms mean); the remaining ≈13 ms between the in-invoker p99
(34.5 ms) and the client p99 (47.8 ms) is HTTP / socket time and event-loop queueing.

## Results: 2-CPU arm64 sandbox (13.8.0 release branch, noisy)

Shared, noisy machine (other builds running): read the proportions, not the absolute values.
Client view: 349.6 req/s, p50 38.8 ms, p95 96.2 ms, p99 132.9 ms; event-loop delay p99 55.6 ms.

| Stage | p50 ms | p95 ms | p99 ms | mean ms | calls |
|---|---:|---:|---:|---:|---:|
| auth | 0.021 | 0.053 | 0.361 | 0.044 | 4000 |
| authz | 0.001 | 0.003 | 0.008 | 0.005 | 4000 |
| policy | 0.054 | 0.231 | 1.170 | 0.108 | 4000 |
| hooks | 0.012 | 0.024 | 0.104 | 0.023 | 4000 |
| routing | 0.026 | 0.086 | 0.524 | 0.050 | 4000 |
| cache | 0.008 | 0.063 | 0.160 | 0.028 | 4000 |
| upstream | 14.543 | 51.388 | 77.230 | 18.816 | 3434 |
| finish | 0.028 | 0.103 | 0.534 | 0.058 | 4000 |
| total | 12.490 | 49.251 | 75.504 | 16.511 | 4000 |

(566 calls were cache hits and never reached the upstream.)

## Findings

1. **The gateway's own stages are not the p99.** auth + authz + policy + hooks + routing + cache + finish add up to
   under 3 ms at p99 (≈0.3 ms mean) out of a 75 ms in-invoker p99. Nothing in the security / policy pipeline needs
   optimising for tail latency at this load.
2. **The tail is queueing, not work.** The upstream stage carries the in-invoker p99, and the client-side p99
   (132.9 ms) exceeds the in-invoker p99 by ≈57 ms — about the event-loop delay p99 (55.6 ms). With 16 concurrent
   workers on 2 CPUs (the benchmark's upstreams share the process), requests wait for the event loop and the
   upstream connection pool rather than for computation. This is what load protection addresses: an adaptive
   concurrency limit keeps the number of calls in flight near what the machine sustains, so the excess waits in a
   bounded, fair queue (or is shed with 503 + Retry-After) instead of inflating everyone's latency.
3. **Feature modules** ([module-costs.md](module-costs.md)): on x64 CI (`Module cost report`, 300 sequential calls
   × 3 rounds; baseline p50 1.41 ms / p99 2.34 ms / 127 KiB allocated per call) none of the 20 call-hook modules
   measured adds more than 0.13 ms at p50 or 0.45 ms at p99 (multimodal). The largest allocators are DLP (+39 KiB / call),
   anomaly (+33) and sanitize (+30) — the first candidates if allocation pressure matters. (The committed reference run
   from the noisy sandbox shows larger p99 swings, e.g. time-travel +16.5 ms, that CI does not reproduce: −0.02 ms.)
   18 modules have no call hook (no per-call cost); 8 need real settings to activate and are not measured with defaults.

## Reproduce

```sh
npm run build
node bench/load.mjs --profile ci --json     # prints the stage table after the comparison
node scripts/module-costs.mjs --json docs/perf/module-costs.json --md docs/perf/module-costs.md
```
