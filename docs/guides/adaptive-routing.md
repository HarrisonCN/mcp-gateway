# Adaptive routing 2.0 (5.8)

Smart routing (3.4) and load balancing pick between replicas of *one* server by latency and errors. Adaptive
routing 2.0 picks between **interchangeable candidates** — the same tool on different servers, or one LLM tool with
different models — by **quality, cost and latency**, and keeps learning.

```yaml
adaptive:
  pools:
    - id: summarize
      objective: { quality: 0.6, cost: 0.3, latency: 0.1 }   # weights
      maxCostPerCall: 0.02
      candidates:
        - { id: small, server: llm, tool: complete, args: { model: gpt-mini },  costPerCall: 0.001 }
        - { id: large, server: llm, tool: complete, args: { model: gpt-large }, costPerCall: 0.015 }
```

## How it learns

- **Latency and errors** come from real traffic: every call to a candidate's `server` + `tool` (through any
  interface) updates its error rate and latency EWMA.
- **Quality** comes from feedback: `POST /api/v1/admin/adaptive/feedback { pool, candidate, quality }` with a value
  in `0..1` — from an eval (see [session evals](session-evals.md)), a user rating, or a grader model.

Each pick scores candidates as `quality·w.quality − normCost·w.cost − normLatency·w.latency`, where quality is a
Thompson sample from the candidate's Beta posterior times its success rate. New candidates are explored; proven
ones take most of the traffic. `explore: false` uses the posterior mean (deterministic).

## Use it

- `POST /api/v1/admin/adaptive/pick { pool }` → `{ candidate, server, tool, args, scores }` — call it yourself.
- `POST /api/v1/admin/adaptive/call { pool, arguments }` → picks and calls through the full pipeline; the
  candidate's `args` (e.g. `model`) are merged under yours.
- `GET /api/v1/admin/adaptive` — per-candidate calls, error rate, latency, quality and picks.

Stats are in memory per gateway process.
