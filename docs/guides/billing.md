# Usage billing and invoices (6.7)

Meter tool usage per tenant and produce monthly invoices.

```yaml
billing:
  currency: USD
  taxPct: 0                       # default tax, overridable per account
  priceBook:                      # first matching `server/tool` glob wins
    - { match: "llm/*", perInputToken: 0.000002, perOutputToken: 0.000008 }
    - { match: "search/*", perCall: 0.004 }
    - { match: "render/*", perSecond: 0.02 }
    - { match: "*", perCall: 0.001 }
  accounts:
    acme: { name: "ACME Corp", discountPct: 10, monthlyMinimum: 50, taxPct: 8.25 }
  storePath: ./data/usage.json    # optional: persist the meter (written every 5 s and on shutdown)
```

## Metering

Every successful call is metered for its **account**: the caller's first tenant, or its client id
(`key:<name>`, `oauth:<sub>` …) when it has none. Meters are kept per calendar month (UTC) and `server/tool`: calls,
input / output tokens (from the result's `usage` in OpenAI or Anthropic shape, as in 6.3) and duration.

## Invoices

`amount = calls × perCall + inputTokens × perInputToken + outputTokens × perOutputToken + seconds × perSecond` per
line; then `discountPct`, a top-up to `monthlyMinimum`, and tax. Totals are rounded to cents. Calls with no matching
price-book entry appear as `unpriced` lines at 0.

- `GET /api/v1/admin/billing/usage?account=acme&period=2026-10`
- `GET /api/v1/admin/billing/invoices?period=2026-10` — every account with usage or a minimum.
- `GET /api/v1/admin/billing/invoices/acme?period=2026-10&format=csv` — line items as CSV for your billing system.
