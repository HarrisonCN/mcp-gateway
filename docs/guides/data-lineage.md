# Data lineage (8.6)

Agents chain tools: a CRM lookup returns a customer id, the next call fetches that customer's invoices, the next
emails one of them. `dataLineage` reconstructs these chains without any change to clients or servers, so you can
answer *"where did this value come from?"* and *"where did this tool's output go?"*.

```yaml
features:
  dataLineage:
    scope: client # link calls of the same client (default), tenant, or globally
    windowMinutes: 60
    minValueLength: 8 # ignore short values ("1", "true", "EUR")
    maxNodes: 5000
```

**How it works.** Every tool call is a node. The string (and long numeric) values of each successful result —
including JSON embedded in text content — are fingerprinted (truncated SHA-256; values are never stored). When a
later call's arguments contain a fingerprinted value, an edge *producer → consumer* is recorded with the argument path
that carried it.

| | |
|---|---|
| `GET /api/v1/admin/data-lineage` | recent calls with input / output edge counts |
| `GET /api/v1/admin/data-lineage/nodes/:id?depth=3` | upstream and downstream graph of one call |
| `POST /api/v1/admin/data-lineage/trace` `{ "value": "cus_8f3k2la9" }` | every call that produced or consumed that value |
| `GET /api/v1/admin/data-lineage/export` | OpenLineage-style run events (job = tool, inputs = upstream calls) |

Lineage is inferred, so it can miss transformed values (a value that was reformatted) and, for very common values,
link calls that only share data by coincidence — raise `minValueLength` if that happens. Pair it with
[DLP](dlp.md) to see where classified data travelled.
