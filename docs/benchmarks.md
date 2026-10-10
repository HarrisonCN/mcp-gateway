# Benchmarks

`mcp-gateway bench` (3.9) starts an in-process gateway on 127.0.0.1 with a minimal stdio echo MCP server and drives
it with concurrent keep-alive clients:

| Scenario | What it measures |
|---|---|
| `rest` | `POST /api/v1/tools/call`, auth off — the full pipeline (scopes, policy, quotas, metrics) plus the stdio round trip |
| `rest-auth` | the same with an API key |
| `cache` | a cached tool (`cache.rules`, shared scope) — gateway overhead without the upstream |
| `mcp` | JSON-RPC `tools/call` on the streamable-HTTP `/mcp` endpoint, one session per client |

```bash
npx @winstonsayno/mcp-gateway bench                       # 10 s per scenario, 32 clients
npx @winstonsayno/mcp-gateway bench -d 30 --concurrency 64 -s rest,mcp --json
```

## Reference run (3.9.0)

Measured on the release build machine — a small 2-vCPU arm64 Linux sandbox, client and gateway on the same host,
so absolute numbers are modest; use them to compare versions, and run the benchmark on your own hardware for
capacity planning.

Node v22.23.3 · linux-arm64 · 2 CPU · concurrency 32 · 5 s per scenario

| Scenario | req/s | mean ms | p50 ms | p95 ms | p99 ms | errors |
|---|---:|---:|---:|---:|---:|---:|
| rest | 2168 | 14.75 | 13.42 | 25.37 | 30.97 | 0 |
| rest-auth | 2284 | 14.01 | 12.79 | 21.62 | 36.68 | 0 |
| cache | 3083 | 10.37 | 9.13 | 13.95 | 20.84 | 0 |
| mcp | 2609 | 12.26 | 11.38 | 18.33 | 29.55 | 0 |

Notes:

- With client and gateway sharing two cores, the load generator itself takes roughly half the CPU; on a dedicated
  host the gateway's throughput is higher.
- `rest` vs `rest-auth`: API-key checks are a constant-time digest comparison and do not show up at this scale (the
  difference is run-to-run noise).
- `cache` is the gateway's own ceiling for one process: every other scenario adds the upstream round trip.
- Scale out with several instances behind a load balancer and `store: { backend: redis }` so rate limits, quotas and
  lockouts are shared.

## Load testing a deployed gateway

`bench` measures an in-process gateway. To load-test a running deployment use any HTTP load tool against
`/api/v1/tools/call` with a dedicated API key whose `rateLimit` is high enough, e.g.

```bash
npx autocannon -c 64 -d 30 -m POST -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -b '{"server":"echo","tool":"echo","arguments":{}}' https://gateway.example.com/api/v1/tools/call
```

## Kernel benchmark (12.0)

`node bench/kernel.mjs` measures the **built** gateway (`npm run build` first) in fresh processes: import time,
start time, RSS / heap after GC and the number of `dist/features/*` modules evaluated (module-load tracing). Profiles:
`minimal` (no feature configured) and `all` (every feature section that validates empty). CI runs it on every push
and compares with the recorded `bench/baseline.json`, failing only on a gross regression (> 2× time, > 1.5× memory).

Baseline recorded for 12.0 (= the 11.x kernel; 2-vCPU arm64 sandbox, Node 22.23, median of 3):

| profile | import ms | start ms | RSS MiB | heap MiB | feature modules evaluated |
|---|---:|---:|---:|---:|---:|
| minimal | 1067 | 16 | 58.7 | 23.3 | 47 / 47 |
| all | 1080 | 46 | 63.4 | 24.0 | 47 / 47 |

Kernel cold start in 13.3 (on-demand `jose` / `ws` / `yaml` / plugin-signature backend; same sandbox, Node 22.23,
median of 5 runs × 3 samples, interleaved with 13.2.0 — timings on this shared machine are noisy, module counts and
bytes are exact):

| profile | version | modules | module KB | on-demand deps loaded | RSS MiB | heap MiB | total ms |
|---|---|---:|---:|---:|---:|---:|---:|
| minimal | 13.2.0 | 443 | 2497 | 4 | 57.1 | 19.8 | 1482 |
| minimal | **13.3.0** | **267** | **1774** | **0** | **38.2** | 17.5 | 890 |
| all | 13.2.0 | 475 | 2855 | 4 | 60.7 | 22.0 | 2611 |
| all | **13.3.0** | **393** | **2474** | 2 | **50.8** | 21.0 | 1588 |

Since 13.3 the kernel check also fails when `modules` / `moduleKb` grow more than 10 % or a profile loads an
on-demand dependency it does not use (`lazyDeps`; minimal must stay at 0).

## Load and fault benchmark (13.3)

`node bench/load.mjs` (built gateway, `npm run build` first) runs one in-process gateway in front of controllable
upstreams — `h` (Streamable HTTP with one replica, round-robin, failover on not-connected / timeout, ejection) and `s`
(a stdio child) — with API-key auth, rate limit, response cache, quotas, budgets and policy rules in the hot path.
N workers send a **fixed number** of requests; each worker draws its operations from its own seeded PRNG, so two runs
send exactly the same sequence (`echo@h` 40 %, `echo@s` 25 %, `cached@h` 15 %, `slow@h` 10 %, `fail@s` 5 % expected
errors, `priced@h` 5 %).

```bash
npm run build
node bench/load.mjs                          # ci profile: 4000 requests, concurrency 16, seed 42
node bench/load.mjs --faults                 # 8000 requests with three injected faults
node bench/load.mjs --profile long           # 60000 requests, concurrency 32 (memory / connection-pool drift)
node bench/load.mjs --store redis            # rate limits etc. through a RESP store
node bench/load.mjs --compare bench/baseline.json   # exit 1 on a gross regression (see below)
node bench/load.mjs --write bench/baseline.json     # record this platform's baseline
```

Reported: requests/s; latency mean / p50 / p95 / p99 / max, overall and per operation; unexpected-error rate; RSS /
heap at start, after GC at the end, peak, and heap growth per 10k requests (overall and second half); event-loop delay
p99; upstream TCP connections opened and MCP sessions; failovers, session-expiry resends and hung-session recycles.

`--faults` injects at fixed request counts, never two at once (the next waits until the previous cleared 1.5 s ago):
the HTTP replica is killed for 1 s, the stdio child is stalled for 1 s (SIGSTOP-like, it stops answering), and the HTTP
upstream forgets every session (as after a restart). Each window counts only calls to the server it faulted and
reports errors during the fault, the time from the fault clearing to the first successful call, and errors after
recovery (from 300 ms after clearing until the next fault), which must be **0**.

### Baseline (13.3.0, linux-arm64)

2-vCPU arm64 sandbox shared with other work, Node 22.23.3, seed 42; medians of 3 runs (faults: 2) interleaved with
13.2.0 on the same harness. Recorded in `bench/baseline.json` → `load.platforms["linux-arm64"]`.

| run | version | req/s | p50 ms | p95 ms | p99 ms | errors | heap growth / 10k | RSS peak MiB | upstream conns |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|
| ci (4000 @ 16) | 13.2.0 | 507 | 29.0 | 57.0 | 74.4 | 0 % | 12.8 MiB | 179 | 7 |
| ci (4000 @ 16) | **13.3.0** | 462 | 31.9 | 62.1 | 77.4 | 0 % | 14.3 MiB | **154** | 8 |
| ci + faults (8000 @ 16) | **13.3.0** | 486 | 27.6 | 58.6 | 78.8 | 0.11 % | 8.8 MiB | 193 | 28 |

The 13.2.0 / 13.3.0 latency difference is inside this machine's run-to-run spread (single runs of either version
ranged p50 22–36 ms); the heap growth is the bounded request history filling up (second-half growth ≈ 0).

| fault (13.3.0) | errors during fault | recovered after | errors after recovery |
|---|---:|---:|---:|
| HTTP replica killed 1 s | 0 (round-robin fails over) | < 1 ms | 0 |
| stdio child stalled 1 s | 9 × 504 (calls sent into the stall time out at `timeoutMs` 2 s) | ≈ 1.0 s ¹ | 0 |
| HTTP sessions forgotten | 0 (session-expiry resend) | 5 ms | 0 |

¹ every worker is blocked on a stalled call until its 2 s timeout, so the first new call is sent ~1 s after the stall
clears. 13.2.0 shows the same numbers for these three faults; the faults 13.3.0 fixes (stalled Redis, locked SQLite,
hung child, upstream `-32000`) are covered by `test/reliability-13-3-0.test.ts`, which fails 9 of 16 cases on 13.2.0.

### Regression rule

`.github/workflows/perf.yml` (separate from CI, so a noisy runner never blocks other work) runs the kernel benchmark,
the load run and the fault run with `--compare bench/baseline.json` on pull requests that touch `src/` or `bench/`, on
`main` and weekly. A run fails only on a **gross** regression against the baseline recorded for the runner's platform:
p50 / p95 / p99 above 3× the baseline + 15 ms, error rate above baseline + 0.5 pp, heap growth per 10k requests above
2× + 8 MiB, upstream connections above 2× + 8, throughput below ⅓ — or any fault that does not recover within 5 s or
has errors after recovery. Without a baseline for the platform the latency rows are report-only (the fault rules still
apply). A deliberate regression is accepted by updating the baseline in the same PR with a `justification` note.
