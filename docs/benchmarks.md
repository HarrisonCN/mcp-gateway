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
- Scale out with several instances behind a load balancer and `state: { backend: redis }` so rate limits, quotas and
  lockouts are shared.

## Load testing a deployed gateway

`bench` measures an in-process gateway. To load-test a running deployment use any HTTP load tool against
`/api/v1/tools/call` with a dedicated API key whose `rateLimit` is high enough, e.g.

```bash
npx autocannon -c 64 -d 30 -m POST -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -b '{"server":"echo","tool":"echo","arguments":{}}' https://gateway.example.com/api/v1/tools/call
```
