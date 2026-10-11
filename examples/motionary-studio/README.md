# Example: Motionary Studio — per-tenant scoped AI tool access (14.2.0)

Joint example for **MCP Gateway 14.2 "租户隔离强化"** and **Motionary 14.4 "Motion Studio"**: each Studio workspace
(tenant) gets its own Motionary MCP upstream behind the gateway. A workspace's AI client can only see and call its own
Motionary tools, and every call is audited with the caller and the acting tenant.

```
Studio A AI client ──key:studio-a──┐                      ┌──stdio──▶ motionary-mcp (motionary-a)
                                   ├──▶ mcp-gateway /mcp ─┤
Studio B AI client ──key:studio-b──┘   tenancy.isolation   └──stdio──▶ motionary-mcp (motionary-b)
                                       + audit log
```

The projects stay separate: Motionary is **not** a dependency of `@winstonsayno/mcp-gateway`.

```bash
cd examples/motionary-studio
npm i --no-save motionary@13.0.2
# put the digests of your three keys (npx mcp-gateway hash-key "<key>") into auth.apiKeys first
npx mcp-gateway tenancy report -c mcp-gateway.yml     # exits 1 if any tenant boundary is violated
npx mcp-gateway start -c mcp-gateway.yml
```

What you get:

| | Studio A key | Studio B key | Operator key |
|---|---|---|---|
| `tools/list` | Motionary tools of `motionary-a` only | `motionary-b` only | both |
| call `motionary-a` | ✓ | 403 `cross-tenant`/scope (recorded) | ✓ |
| call `motionary-b` | 403 (recorded) | ✓ | ✓ |
| `GET /api/v1/requests` | own calls only | own calls only | all; `?tenant=studio-a` filters |

Audit records carry `clientId`, `tenant` (the acting tenant), `decision` for refusals and `tenantGrant` when a call
used a sharing grant. To share one workspace's Motionary with another (for example read-only for a design review),
add a grant under `tenancy.isolation.grants` — see [the tenant isolation guide](../../docs/guides/tenant-isolation.md).

## End-to-end test

`test/motionary-e2e.test.ts` ("per-tenant scoped access + audit (14.2.0)") runs this setup against the real
`motionary-mcp` when `MGW_MOTIONARY_BIN` is set (CI job **"MCP compat matrix"** installs `motionary@13.0.2` into a
scratch directory): tenant A cannot see or call tenant B's Motionary tools, and every call is in the audit log.
