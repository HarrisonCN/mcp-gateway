# Tenant isolation (14.2)

14.2.0 makes tenant boundaries explicit and verifiable for every resource a call touches: **credentials, policies,
budgets, caches and tool catalogs**. Two parts:

1. **The acting tenant** (always on). Every per-call tenant decision uses the caller's tenant that is entitled to the
   called server — not simply the caller's first membership.
2. **`tenancy.isolation`** (optional, schema v12, additive). Centralized isolation rules: each server belongs to one
   tenant, cross-tenant access is denied by default and only possible through explicit, audited sharing grants.

## The acting tenant

A client can belong to several tenants. For a call to server `S`, the acting tenant is the caller's membership whose
tenant owns `S` (with isolation on: the owner, else the grantee of a grant; a membership with call rights first). It is
used for:

| Resource | Effect |
|---|---|
| Credentials | `servers[].inject` references with `{tenant}` resolve the acting tenant's secret — never another tenant's |
| Budgets / quotas | `costs` spend, `costs.budgets` blocks and `quotas` count against the acting tenant only |
| Caches | the tool cache (`scope: shared` / `client`) and the semantic cache (`scope: tenant`) partition by acting tenant |
| Policy / hooks | `tenant` in policy-engine (Cedar `Tenant::"…"`), call hooks, plugin contexts, data residency |
| Audit | every request record carries `tenant` (and `tenantGrant` for shared access); `GET /api/v1/requests?tenant=` |

Before 14.2 all of these used the caller's *first* membership, so a member of tenants `acme` and `labs` calling a labs
server had acme's `{tenant}` credential injected into the labs upstream and the call charged to acme's budget
(security advisory MGW-2026-015, fixed in 14.2.0).

## `tenancy.isolation`

```yaml
tenants:
  - id: acme
    servers: ['acme-*', 'shared-*']
    members: [{ client: 'key:alice', role: admin }]
  - id: labs
    servers: ['labs-*', 'shared-*']
    members: [{ client: 'key:lab2', role: admin }]

tenancy:
  isolation:
    crossTenant: deny            # deny (default) | audit
    grants:
      - owner: acme              # tenant that owns the servers
        tenants: [labs]          # tenants whose members may use them (their own role applies)
        servers: ['shared-kb']   # server id globs owned by `owner`
        access: call             # call (default) | read (catalog, resources, prompts only)
        reason: shared knowledge base pilot
```

- **Ownership:** a server belongs to the first tenant (config order) whose `servers` globs match it. In the example
  `shared-kb` belongs to `acme`, although `labs`' globs match it too.
- **Default deny:** members of other tenants no longer see the server in `tools/list` (REST and `/mcp`; per-session
  `list_changed` follows) and their calls are refused with decision `cross-tenant` — recorded in the request history /
  audit log like any refusal.
- **Grants** are the only way across a boundary. A grant may share a server outside the grantee's own globs. Calls
  through a grant are recorded with `tenant` (the grantee) and `tenantGrant: "acme->labs"`; they use the grantee's
  credentials and budget.
- **`crossTenant: audit`** keeps the pre-14.2 behaviour (overlapping globs share) but reports every crossing — a
  migration step before `deny`.
- Clients in no tenant (operators) are not affected. Without a `tenancy` block nothing changes except the acting-tenant
  fixes above. Hot reloadable.

## `mcp-gateway tenancy report`

```bash
npx mcp-gateway tenancy report -c mcp-gateway.yml          # human-readable
npx mcp-gateway tenancy report -c mcp-gateway.yml --json   # machine-readable
```

Lists each server's owner, the tenants that also match it, grants, and how its credentials are scoped, plus findings:

| Code | Severity | Meaning |
|---|---|---|
| `overlap-ungranted` | violation | a tenant reaches another tenant's server through overlapping globs without a grant (isolation off / audit) |
| `isolation-off` | warning | tenants are configured but `tenancy.isolation` is not |
| `shared-credential` | warning | a server used by several tenants has one credential (use an `inject` reference with `{tenant}`) |
| `global-cache` | warning | `features.semanticCache.scope: global` shares entries across tenants |
| `grant-unowned-server` | warning | a grant matches no server its owner owns |
| `member-glob` | warning | a tenant enrols every client (`*`) |
| `overlap-granted`, `unowned-server`, `pooled-budget` | info | |

The command exits 1 when there is at least one violation, so it can gate CI.

## Verification

`test/tenancy-14-2-0.test.ts` holds a property-based isolation matrix (fast-check): random tenants, memberships, roles
and grants × servers × operations (catalog, call) × principals, checked against an independent oracle, including that
the acting tenant is always one the caller belongs to and is entitled to the server. The Motionary joint example
([examples/motionary-studio](../../examples/motionary-studio/README.md)) is verified end-to-end in CI.
