# Cost optimization advisor (8.4)

`costs` (4.3) tells you what tool calls cost. `costAdvisor` tells you **how to pay less**: it watches live calls and
turns them into quantified recommendations with the config to apply.

```yaml
costs:
  currency: USD
  tools:
    - { match: "search/*", perCall: 0.01 }
    - { match: "search-lite/*", perCall: 0.007 }
costAdvisor:
  windowMinutes: 1440     # rolling window analysed
  minCalls: 20            # ignore tools with fewer calls
  repeatThreshold: 0.3    # identical-call share that suggests caching
  errorThreshold: 0.2     # failure rate that flags wasted spend
```

`GET /api/v1/admin/cost-advisor` (optionally `?windowMinutes=60`):

| Kind | When | Savings estimate | Suggestion |
|------|------|------------------|------------|
| `cache` | ≥ `repeatThreshold` of a tool's calls repeat identical arguments and no cache rule covers it | repeats × average price | a `cache.rules` entry |
| `failures` | failure rate ≥ `errorThreshold` | price of the failed calls | fix or fail over |
| `cheaper-upstream` | another server exposes the same tool at a lower `perCall` price | calls × price difference | a `rollouts` entry to shift traffic gradually |
| `budget` | money was spent and `costs.budgets` is empty | — | a monthly budget at 120 % of the projected spend |

Recommendations are sorted by estimated savings over the window. Only the tool, a hash of the arguments, the price
and the outcome of each call are kept, in a bounded in-memory window (`maxObservations`, default 50 000).
