# 15.0 API and config freeze (14.9.0)

14.9.0 is the v15 release candidate line. From 14.9.0 until 15.0.0 ships, the surfaces below are **frozen**: no
renames, no removals and no changed meaning, except the 15.0 changes listed at the end (announced in 14.9.0 and
reported at run time). Additions that cannot break a client (a new optional key, endpoint, response field or enum
value) need a note in the CHANGELOG under "Additions after the freeze" and a reason.

The stability rules themselves are unchanged ([API reference → Stability and versioning](../api-reference.md#stability-and-versioning)).

## Frozen

| Surface | Frozen form | Source of truth |
|---|---|---|
| Config file | schema v12 (`version: 12`), the top-level keys `version modules features a2a audit auth cache catalog chains compliance controlPlane cors costs federation health host logLevel mcp monitor mtls observability openai overload plugins policy port portal quotas rateLimit reconnect replay routing secrets security servers store streaming tenancy tenants` and everything below them | [schema/v12/config.schema.json](../../schema/v12/config.schema.json) (generated from the code; CI fails on drift) |
| Module declaration | `modules.activation`, `modules.failurePolicy`, `modules.lifecycle`, `modules.capabilities`, the module manifest | [schema/v12/module.schema.json](../../schema/v12/module.schema.json), [design](../design/schema-v12.md) |
| Environment | `MCP_GATEWAY_*` variables, `${VAR}` / `secret://` references (unset references are errors, MGW-2026-019) | [configuration](../configuration.md) |
| REST API | every path, method, query parameter, status code and documented field under `/api/v1` and `/api/v1/admin` | [API reference](../api-reference.md) |
| Client routes of feature modules | `/api/v1/features/*` (task graphs, edge autonomy, …) as documented in their guides | [docs/guides](../guides) |
| MCP endpoint | `/mcp` session handling, tool naming (`auto` / `prefix`, `server__tool`), error codes (-320xx), protocol revisions `2025-11-25`, `2025-06-18`, `2025-03-26`, `2024-11-05` | [API reference → MCP endpoint](../api-reference.md#mcp-endpoint-mcp) |
| CLI | top-level commands `start init validate diff migrate config bench gen-key hash-key plugin pq conformance tasks regions edge gitops tenancy operator desktop` and their documented flags; exit codes of `validate`, `config migrate` (1 on errors), `config diff` (3 when it would change) | `mcp-gateway --help` |
| Plugin API | plugin API v5 (module plugins and WASM components), `runtime` / `isolation`, `permissions`, `limits`, `failure`, signatures (`pluginTrust`) | [plugin SDK](../guides/plugin-sdk.md), [plugin security](../guides/plugin-security.md) |
| State formats | durable task records, idempotency claims, intent log, DLQ entries, edge outbox (sealed), region revocation lists, gitops release record (`recordFile`), rate-limit / lockout / session keys in Redis / SQLite | readable by 15.0 without migration — verified by `test/upgrade-14-9-0.test.ts` (13.9 / 14.8 → current and back) |
| Release artefacts | gitops bundle `mcp-gateway/gitops-bundle@1`, release manifest `mcp-gateway/release-manifest@1` | [GitOps](../guides/gitops.md) |
| Observability | Prometheus metric names and labels (`mcp_gateway_*`), audit record fields, OTLP GenAI attributes | [API reference](../api-reference.md), [genai-otel](../guides/genai-otel.md) |
| Library | exports of the package root (`@winstonsayno/mcp-gateway`) and their documented signatures | `dist/index.d.ts` |

Not frozen (as before): deep imports, log line format, dashboard HTML/JS, exact error message texts, the audit
log's on-disk SQLite schema, `clients/` packages (versioned separately).

## What 15.0.0 changes (announced in 14.9.0)

Each change is reported by 14.9.0 — as a log warning once per id, by `mcp-gateway validate` and by
`GET /api/v1/admin/deprecations` — so a deployment that runs 14.9.0 without deprecation reports is ready for 15.0.0.
Details and migration steps: [deprecations](../deprecations.md#removed-in-1500-announced-1490), [migrating to v15](../migrating-to-v15.md).

| Id | 14.x | 15.0.0 |
|---|---|---|
| `schema.v11` | `version: 11` files are migrated in memory (v11 field ids `v12.*`) | refused — run `mcp-gateway config migrate --to v12` first |
| `v15.plugins.<i>.runtime` | module plugins without `runtime` run inline | module plugins run in a `worker` unless they say `runtime: inline` |
| `v15.config.unknown-key.<key>` | unknown top-level keys of a v12 file are ignored | refused (typos and GitOps `include:` fragments loaded directly fail fast) |
| `schema/v12-draft` | identical alias copy of `schema/v12` (13.9 path) | removed — point editors at `schema/v12/config.schema.json` |

## Release gates for 15.0.0

From the roadmap; tracked in [release gates](../release-gates.md#v15-gates):

1. 72 hours of load with fault injection on at least two instances, with no cross-tenant access and no repeated
   non-idempotent execution (`scripts/soak.mjs`, workflow `soak.yml`).
2. p95, p99, throughput, memory growth and recovery time compared with the v13.3 baseline on fixed hardware and an
   equivalent workload (same harness, `--impl` pointing at 13.3.0).
3. An independent security audit, or at least one external expert review, with every high-severity finding in scope closed.
4. Migration and rollback verified from 13.x and 14.x to 15 (`test/rc-migration-14-9-0.test.ts`, `test/upgrade-14-9-0.test.ts`).
