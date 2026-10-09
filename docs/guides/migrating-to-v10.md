# Migrating to 10.0

10.0 is the next breaking release — and the first **long-term support (LTS)** line. It ships the **unified gateway
kernel** and **config schema v10**. A config that **9.9** loads without deprecation warnings runs on 10.0 unchanged.

## Checklist

1. Upgrade to 9.9 and run `mcp-gateway validate` — it lists the config deprecations (also at startup and at
   `GET /api/v1/admin/deprecations`).
2. `npx @winstonsayno/mcp-gateway@9.9 migrate --write` — rewrites the config to **schema v10** (`--to 10` is the
   default; comments travel with the moved sections, `.bak` written).
3. Embedders: nothing changes in code — `GatewayConfig` keeps the feature sections at the top level internally; only
   the file schema changes.

## What changes

| 9.x | 10.0 | `migrate --to 10` |
|-----|------|-------------------|
| `version: 9` (or none) | `version: 10` — 10.0 refuses `version: 9` | ✓ |
| feature sections at the top level (`chaos:`, `sla:`, `dlp:`, `sessions:`, …) | nested under `features:` | ✓ (moved, comments kept) |

```yaml
# 9.x                              # 10.0
version: 9                         version: 10
sla:                               features:
  targets: [...]                     sla:
chaos:                                 targets: [...]
  experiments: [...]                 chaos:
                                       experiments: [...]
```

Every section owned by a feature module moves: `regions`, `edgeFleet`, `pluginTrust`, `marketplace`, `sessions`,
`dlp`, `adaptive`, `apiUpstreams`, `workflows`, `genaiTelemetry`, `identity`, `policyShadow`, `anomaly`, `billing`,
`console`, `sanitize`, `semanticCache`, `rollouts`, `offline`, `approvalFlows`, `complianceReports`, `agentIdentity`,
`a2aFederation`, `debugSessions`, `costAdvisor`, `blueGreen`, `dataLineage`, `configAssistant`, `chaos`,
`multimodal`, `edgeRuntime`, `confidential`, `toolRegistry`, `sla`, `selfHealing`, `postQuantumTls`, `ecosystem`.
Core sections (`servers`, `auth`, `policy`, `store`, `controlPlane`, `mtls`, …) stay where they are.

9.9 reads both schema versions: `version: 9` with top-level sections, or `version: 10` with `features`. **10.0 reads
only schema v10**: `version: 9` and top-level feature sections are validation errors naming
`mcp-gateway migrate --to 10`.

## Deprecations in 9.9 (removed in 10.0)

| id | Removed in | Replacement |
|----|-----------|-------------|
| `schema-v9` | 10.0.0 | `version: 10` |
| `top-level-features` | 10.0.0 | `features: { … }` |

## Other changes

- Data planes receive the schema version of the control plane's file (9 or 10 in 9.9; always 10 in 10.0).
- `GET /api/v1/admin/config` returns `features` for v10 configs.
