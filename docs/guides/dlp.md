# Data loss prevention (5.6)

DLP classifies sensitive data in tool traffic by **level** and masks what a caller's tenant is not cleared for.
It builds on the 3.7 PII detectors (e-mail, phone, payment card, SSN, IBAN, IPv4, PRC ID — checksums included) and
adds custom detectors, levels, per-tenant clearance and masking strategies.

```yaml
dlp:
  scope: results                     # arguments | results | both (default results)
  servers: ["crm-*"]                 # optional server globs
  default: { clearance: internal, strategy: mask }
  tenants:
    finance: { clearance: restricted }                # sees card numbers
    trial:   { clearance: public, strategy: block }   # any sensitive data fails the call
    analytics: { strategy: hash, salt: ${DLP_SALT} }  # stable pseudonyms for joins
  detectors:
    - { name: employee-id, pattern: "EMP-\\d{6}", level: confidential }
  levels: { ipv4: public }           # override a built-in level
```

Levels: `public` < `internal` < `confidential` < `restricted`. Built-in defaults: e-mail / phone / IPv4 →
internal, IBAN → confidential, card / SSN / PRC ID → restricted. Data **above** the tenant's clearance is handled
with its strategy:

| strategy | result |
|----------|--------|
| `mask` (default) | `•••••••••••••••1111` (last 4 kept for values longer than 8) |
| `redact` | `[REDACTED:credit-card]` |
| `hash` | `tok_3f9a1c2b` — HMAC-SHA256 with the tenant's salt, stable across calls |
| `block` | the call fails with `-32013` |

Callers without a tenant use `default`. DLP runs after the output filter and 3.7 PII handling; the section hot
reloads.

## Inspect

- `GET /api/v1/admin/dlp` — effective levels and policies, plus counters by category, level and action.
- `POST /api/v1/admin/dlp/classify` `{ "value": …, "tenant": "trial" }` — what a tenant would see.

Embedders can add their own pipeline stages with `registerCallHook({ id, before, after })` (the mechanism DLP uses).
