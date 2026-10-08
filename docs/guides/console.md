# SaaS console (7.2)

Run one gateway for many customer organisations. An **organisation** is a [tenant](../configuration.md#tenants-and-roles-rbac)
plus a **plan**: the plan decides which upstream servers the organisation's tenant gets and how many tool calls its
members may make per UTC day.

```yaml
version: 7
controlPlane: { configApi: true }      # needed for onboarding / plan changes over the API
console:
  defaultPlan: free
  plans:
    free: { name: Free, servers: ["search"], callsPerDay: 1000 }
    pro:  { name: Pro,  servers: ["*"] }                # no daily limit
  orgs:
    acme: { plan: pro }
tenants:
  - { id: acme, name: ACME, servers: ["*"], members: [{ client: "key:acme-*", role: owner }] }
```

- Calls by members of a **suspended** organisation, or over the plan's `callsPerDay`, are refused with JSON-RPC
  error **-32016** (`data.reason`: `suspended` | `limit`, plus `plan`, `limit`, `used`).
- Counters are per gateway process and reset at 00:00 UTC (use [billing](billing.md) for durable metering).

## Operator API

| | |
|-|-|
| `GET /api/v1/admin/console` | plans (with org counts), organisations (plan, members, servers, usage today / remaining), totals |
| `POST /api/v1/admin/console/orgs` | onboard `{ id, name?, plan?, owner? }` — creates the tenant with the plan's servers and `owner` as owner member |
| `GET /api/v1/admin/console/orgs/:id` | one organisation |
| `PATCH /api/v1/admin/console/orgs/:id` | `{ plan?, name?, suspended? }` — a plan change re-scopes the tenant's servers |
| `DELETE /api/v1/admin/console/orgs/:id` | offboard (organisation and tenant) |
| `POST /api/v1/admin/console/orgs/:id/reset-usage` | clear today's counter |

Writes validate and hot-apply the whole config (like `PUT /api/v1/admin/config`). Organisation members manage their own
membership with the tenant API (`PUT /api/v1/tenants/:id/members`).
