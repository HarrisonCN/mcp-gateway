# Automated compliance reports (7.8)

`GET /api/v1/compliance/report` (3.7) produces a SOC 2 or GDPR report on demand. `complianceReports` produces
**evidence bundles** on a schedule — SOC 2, **ISO/IEC 27001:2022** and GDPR — ready to hand to an auditor.

```yaml
complianceReports:
  outputDir: ./compliance        # relative to the config file
  keep: 12                       # newest bundles kept
  schedules:
    - { id: monthly, frameworks: [soc2, iso27001, gdpr], every: monthly, periodDays: 30 }
    - { id: weekly-iso, frameworks: [iso27001], every: weekly, periodDays: 7 }
```

Each run writes `<outputDir>/<schedule>-<timestamp>/`:

| File | |
|------|---|
| `<framework>.md` / `<framework>.json` | controls (pass / warn / fail with evidence), activity in the period, security warnings |
| `config.redacted.json` | the running config, secrets `<redacted>` |
| `manifest.json` | every file with its SHA-256 and size, plus a digest of the manifest — edits are detected |

`every` is `daily`, `weekly` or `monthly` (30 days), counted from gateway start or the last run.

## ISO/IEC 27001 controls

| Control | Evidence from |
|---|---|
| A.5.15 Access control · A.5.17 Authentication information · A.5.18 Access rights | `auth`, lockout, tenants, policy rules |
| A.5.34 Privacy and PII · A.8.12 Data leakage prevention | DLP, output filter |
| A.8.2 Privileged access rights | approvals, approval flows (7.7) |
| A.8.7 Protection against malicious input | output sanitisation (7.3), anomaly detection (6.6) |
| A.8.15 Logging · A.8.16 Monitoring | audit log and retention, Prometheus, activity |
| A.8.20 Network security · A.8.24 Cryptography | IP allowlist, upstream mTLS, TLS upstreams |
| A.8.32 Change management | gradual rollouts (7.5), control-plane split (7.0) |

## Admin API

| | |
|-|-|
| `GET /api/v1/admin/compliance-reports` | schedules (last / next run) and bundles (with manifest verification) |
| `POST /api/v1/admin/compliance-reports/run` | `{ schedule?, frameworks?, periodDays? }` — write a bundle now |
| `GET /api/v1/admin/compliance-reports/bundles/:bundle/:file` | download a file |
| `GET /api/v1/admin/compliance-reports/preview?framework=&format=md` | evaluate without writing |

Library: `writeBundle()`, `verifyBundle(dir)` (checks every SHA-256 and the manifest digest).
