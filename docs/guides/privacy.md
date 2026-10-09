# Privacy computing: differential privacy and federated queries (10.8, EXPERIMENTAL)

`features.privacy` lets agents learn **aggregates** over sensitive tool results — counts, sums, means, histograms —
without the raw rows ever leaving the gateway (or the domain) that holds them. It is **experimental**: `validate`,
startup and `GET /api/v1/security` say so; read *What the guarantee rests on* before relying on it.

```yaml
features:
  privacy:
    protect: ["hr/*"]                  # raw results never leave: direct calls are refused (403 / -32003)
    maxEpsilonPerQuery: 1
    budget: { epsilon: 10, windowSeconds: 86400 }        # per client key, sequential composition
    peers:                             # other gateways with features.privacy, for federated queries
      - { id: eu, url: https://eu-gw.example.com, token: ${EU_GATEWAY_KEY} }
```

## Aggregate (any authenticated client allowed to call the tool)

`POST /api/v1/features/privacy/aggregate`

```json
{ "server": "hr", "tool": "list_employees", "arguments": { "country": "DE" },
  "rows": "structuredContent.rows", "field": "salary",
  "op": "mean", "bounds": [0, 300000], "epsilon": 0.5 }
```

1. ε is charged to the caller's budget (`429` when it would be exceeded) — before the tool runs, so failed queries
   cost ε too.
2. The tool runs through the full pipeline as the caller (scopes, policy, quotas, audit).
3. `rows` selects the row array in the result: `structuredContent.*`, or `json.*` when the text content is JSON.
4. Values of `field` are clamped to `bounds` (non-numeric values count as `bounds[0]`), then the aggregate gets
   Laplace noise with scale *sensitivity / ε* from a cryptographic RNG:

| `op` | Sensitivity | Notes |
|---|---|---|
| `count` | 1 | `field` not needed |
| `sum` | max(\|min\|, \|max\|) | `bounds` required |
| `mean` | ε split in half: noisy sum / noisy count | `bounds` required; result clamped to bounds; `parts` returned |
| `histogram` | 1 per bin | `bins`: strictly increasing edges; values clamped into the outer edges |

The answer contains only the noisy value(s), the ε spent, the noise scale and your remaining budget — never rows.
`GET /api/v1/features/privacy/budget` shows the budget.

## Federated query

`POST /api/v1/features/privacy/federated`

```json
{ "query": { "rows": "structuredContent.rows", "op": "sum", "field": "amount", "bounds": [0, 10000], "epsilon": 0.5 },
  "targets": [ { "server": "sales-us", "tool": "orders" },
               { "peer": "eu", "server": "sales", "tool": "orders" } ] }
```

Each target is aggregated **in its own domain** — locally, or by the peer gateway's `/aggregate` with the configured
token — and only noisy partial results travel. They are combined (counts / sums add, means from the noisy parts,
histograms per bin). Local targets are charged to the caller here; each peer charges its own budget (the peer sees
this gateway's key as the client). If some domains fail, the result is marked `partial` and lists them.

## What the guarantee rests on (why it is experimental)

- **One row per person.** ε-DP protects one *row*. If a person can appear in several rows (or several local targets),
  their privacy loss multiplies. The gateway cannot check this — choose tools / arguments that return one row per
  individual.
- **Data-independent bounds.** Choose `bounds` and `bins` from domain knowledge, never from the data.
- **Deterministic tools.** The tool must return the same rows for the same arguments; otherwise repeated queries can
  average out noise faster than the budget accounts for.
- **Floating-point Laplace.** Sampling uses doubles (inverse CDF). Mironov (2012) showed such samplers can leak; the
  outputs are rounded (`round`, default 2 decimals) but not "snapped". Use a vetted DP library for high-stakes data.
- **Budget scope.** Budgets are per client key and per process, in memory: a restart, another replica, or several keys
  for one person each get a fresh budget.
- `protect` relies on the gateway being the only path to the tool; anyone who can reach the upstream directly bypasses
  it.

## Admin API (operators)

| Method | Path | |
|---|---|---|
| `GET` | `/api/v1/admin/privacy` | Protected tools, limits, peers |
| `POST` | `/api/v1/admin/privacy/reset-budgets` | Clear all ε budgets |
