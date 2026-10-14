# Operations console (14.8)

The operations console answers the questions an on-call operator asks first: *is the cluster healthy*, *what
happened to this call*, *why was it refused*, *what changed before it broke* and *what is wrong with this client's
setup*. It is a page of the existing [dashboard](../../dashboard/README.md) (**Operations**) and a set of admin
routes under `/api/v1/admin/ops/*` that you can script against.

Nothing new has to be deployed: the console reads the gateway's own state — config generations, data planes,
regions, edge gateways, plugin circuit breakers, the task-graph DLQ, the call pipeline's stage timings and the
audit records — and keeps a short in-memory history of call traces and incidents.

## Access (operators and viewers)

| Who | Gets |
|---|---|
| **Operators** — unscoped API keys, as for the rest of the admin API | every view, the denial explanation API and the troubleshooting wizard |
| **Console viewers** — clients listed in `controlPlane.console.viewers` | the read-only views: cluster, traces, explain, timeline, shared reports |
| everyone else | `403` |

Viewers get nothing else from the admin API (`/admin/config`, `/admin/gitops/*`, … stay operator-only). No console
response contains key material, secret values or call arguments; error texts pass through the gateway's secret
redaction.

```yaml
version: 12
auth:
  strategy: api-key
  apiKeys:
    - {name: ops, key: "${OPERATOR_KEY}"}
    - {name: oncall, key: "${ONCALL_KEY}", scope: {servers: [github]}}
servers:
  - id: github
    name: GitHub
    transport: streamable-http
    url: https://api.githubcopilot.com/mcp/
controlPlane:
  console:
    viewers: ["key:oncall"]   # read-only console access for the on-call key
    traceBuffer: 500          # call traces kept in memory
    timelineBuffer: 1000      # incidents kept in memory
    explainDenials: false     # see "Denial explanations in error data"
```

Name viewers precisely (`key:oncall`, not `key:*`): a viewer sees every client's traces and refusals.

## Cluster status

`GET /api/v1/admin/ops/cluster` (dashboard: **Operations → Cluster**) gathers in one response:

- **role** and **config generation** — the committed generation, when it was committed, generations still alive
  because in-flight calls pin them, rollbacks;
- **data planes** (control plane) — total, online, in sync, and the **diverged** nodes that do not run the generation
  targeted at them (with their config ETag and last error);
- **regions** (`features.regions`) — this region, fresh / stale (bounded staleness, fail closed), the stale peers and
  the replication lag per peer;
- **edge gateways** — known edges and the calls they have queued offline;
- **plugin circuits** — plugins whose breaker is open or half-open, failures, refusals, failure policy;
- **DLQ** (`features.taskGraphs.durable`) — dead-letter entries by status;
- **servers** — online / offline upstreams; **modules** — failed feature modules.

Sections whose feature is not configured are `null`.

## Call traces

Every top-level call (REST, `/mcp`, bridges) leaves a trace: `GET /api/v1/admin/ops/traces` lists recent ones
(`?client=key:ci&server=github&tool=create_issue&outcome=denied&limit=50`), `GET /api/v1/admin/ops/traces/<requestId>`
shows one call through the pipeline:

| Step | What it covers (pipeline stage) |
|---|---|
| `auth` | HTTP authentication — key / JWT / OAuth, lockout (`auth`) |
| `tenant` | the central authorizer: key scope, tenant role, tenant isolation, delegation (`authz`) |
| `policy` | plugin `onToolCall`, tool policy rules and approvals, residency, quotas, budgets (`policy`) |
| `plugins` | feature-module call hooks before / after and the output filter (`hooks`) |
| `route` | final authorization, routing split, the security snapshot; the final upstream (`routing`) |
| `upstream` | the upstream call: credentials, balancing, failover (`upstream`) |
| `cache` | result-cache lookup / store, with `hit` / `miss` / `shared` / `bypass` (`cache`) |
| `response` | `onResponse` plugins, metrics, request log (`finish`) |

Each step has its time in milliseconds and a status — `ok`, `denied`, `error` or `skipped` (steps after a refusal,
or a cache that was not used). The trace carries the W3C `traceId` / `traceparent` of the gateway span, so the same
call can be opened in your OpenTelemetry backend (`observability.tracing`). The `requestId` is the id of the
history / audit record (`GET /api/v1/requests/<id>` when the replay recorder is on).

Traces are kept in memory per gateway (`traceBuffer`, newest wins) and are not replicated.

## Call lineage (15.1)

`GET /api/v1/admin/ops/lineage/<requestId>` answers "who made this call, under which config, and what happened" in one
record, read from the call trace (so it is kept as long as the trace: `traceBuffer`):

| Field | Meaning |
|---|---|
| `requestId` | the gateway's id of the call (`requestId` in the REST response, the audit record id) — unique |
| `correlationId` | on `/mcp`, the request's `params._meta.correlationId` (15.2.0-canary.1; each message of a batch can carry its own), else the `X-Request-Id` (else `X-Correlation-Id`) the client sent, when it sent one (1–128 characters of `A–Z a–z 0–9 . _ : -`); `null` otherwise |
| `identity` | `subject` (the caller every module sees) and `chain` (the subject followed by the agents acting for it) |
| `tenant` | the acting tenant of the call, `null` without tenants |
| `generation` | the config generation the call was pinned to (compare with `GET /api/v1/admin/ops/cluster`) |
| `target` | `serverId`, `tool`, `kind`, `via` (`rest`, `mcp`, …) |
| `decision` | `outcome` (`ok` / `denied` / `error`); for a refusal also `decision`, `layer`, `rule` / `policy` and `configPath` |
| `upstream` | the upstream step's status (`skipped` when the call was refused before it) and time in ms |
| `cost` | the priced cost of the call when `costs` is configured, else `null` |
| `traceId` | the W3C trace id of the gateway span, when tracing is on |

`GET /api/v1/admin/ops/lineage?correlationId=<id>` lists every kept call that carried that correlation id, newest first
(a correlation id is the client's and may repeat; the request id does not). This is how another system joins its own
records — for example an editor that sends one `X-Request-Id` per AI edit can find the gateway calls behind that edit.

Same access as the traces (operators, console viewers and — with `tenantViewers` — tenant viewers). Nothing in a
lineage record contains call arguments, results or key material. The same lookups work for calls made over `/mcp`
(send `X-Request-Id` on the `tools/call` POST; the lineage says `via: mcp`).

## Tenant viewers (15.1)

```yaml
controlPlane:
  console:
    tenantViewers: true   # default false
```

With `tenantViewers: true`, every member of a tenant with role `owner`, `admin` or `viewer` (`tenants[].members`) can read,
for **their own tenants only**:

- `GET /api/v1/admin/ops/traces` and `/traces/<requestId>`,
- `GET /api/v1/admin/ops/lineage/<requestId>` and `/lineage?correlationId=`,
- `GET /api/v1/admin/ops/costs`.

A call is theirs when its acting tenant (the lineage `tenant`) is one of their tenants. Another tenant's call — and a call
without a tenant — answers `404` as if it did not exist, and a correlation id lookup lists only their own calls. Every
other console route (cluster, timeline, explain, troubleshooting, reports) stays `403` for them. Operators and
`viewers` keep the full view. Without the key nothing changes: tenant members get `403` on the console, as before.

## Cost rollup (15.1)

`GET /api/v1/admin/ops/costs?by=<tenant|client|tool|day>&since=<ISO 8601>` sums the cost ledger (`costs`):

```json
{ "currency": "EUR", "by": "tenant", "since": null,
  "totals": [{ "key": "labs", "cost": 2, "calls": 1, "inputTokens": 0, "outputTokens": 0 }, { "key": "acme", "cost": 1.5, "calls": 3, "inputTokens": 0, "outputTokens": 0 }],
  "total": { "cost": 3.5, "calls": 4, "inputTokens": 0, "outputTokens": 0 } }
```

`by` defaults to `tenant` (a call without a tenant is `(none)`); `tool` keys are `server/tool`; `day` keys are UTC days,
oldest first (other rollups are sorted by cost). `since` is a date (`2026-10-01`) or a date-time; without it every kept
ledger entry counts. `total` counts each call once. Tenant viewers see only calls charged to their tenants (and only their
tenants in a `tenant` rollup). The 4.3 `GET /api/v1/costs` (operators, with budgets and alerts) is unchanged.

The dashboard's **Operations → Lineage & costs** tab looks up a call by request id or correlation id and shows the
rollup.

## Policy denial explanations

A refused call's trace carries an `explain` object:

```json
{
  "decision": "deny",
  "layer": "policy",
  "rule": "ci-no-echo",
  "configPath": "policy.rules[0]",
  "client": "key:ci",
  "reason": "CI may not echo"
}
```

`layer` is where the decision was made — `exposure` (server tool filter), `scope` (API key scope), `tenant`
(tenant role or isolation; `tenant` names the owning tenant), `delegation`, `policy`, `approval`, `plugin`,
`residency`, `quota`, `budget`, `module`, `route` or `server` — and `configPath` points at the config that made it
(`auth.apiKeys[3].scope.tools`, `tenants[1].members`, `tenancy.isolation`, `plugins[0]`, …). `permission` names what
was missing where that applies.

To ask *would this call be allowed* without making it, use `POST /api/v1/admin/ops/explain`:

```bash
curl -s -X POST localhost:4000/api/v1/admin/ops/explain -H "Authorization: Bearer $OPERATOR_KEY" \
  -H 'Content-Type: application/json' -d '{"client":"key:ci","server":"github","tool":"create_issue"}'
```

It runs the authorizer (server, exposure, scope, tenant, delegation) and then the tool policy — the order the
gateway applies them — against the running config and the client's current key.

### Denial explanations in error data

Clients never see config paths. With `controlPlane.console.explainDenials: true`, refused REST tool calls made **by
an operator** also get the explanation in the error body (`policy.explain`), which helps when testing policies with
an operator key. Scoped keys, tenant members and console viewers get the same error body as before; the flag is off
by default.

## Incident timeline

`GET /api/v1/admin/ops/timeline` merges, newest first:

| Kind | Source |
|---|---|
| `restart` | the gateway started (version, role, generation) |
| `config-apply` | a config generation was committed (admin API, file watcher, control plane pull, GitOps) or failed to apply |
| `gitops-release` | GitOps apply / refusal / drift audit entries (14.7) |
| `revocation` | a credential was revoked (developer portal keys; replicated by `regions`) |
| `circuit-open` | a plugin circuit breaker opened |
| `region-stale` / `region-fresh` | the region crossed its bounded-staleness limit, and recovered |
| `audit` | refused calls (policy, scope, tenant, quota, …) from the request / audit records |

Filters: `kind` (comma-separated), `since` / `until` (ISO timestamps), `subject` (client id, plugin, region),
`limit`. Events are kept in memory (`timelineBuffer`); refusals and GitOps entries come from the request records, so
with the persistent [audit log](../configuration.md#audit-log) (`audit.enabled`) the full history stays queryable at `GET /api/v1/requests`.

## Troubleshooting wizard

`POST /api/v1/admin/ops/troubleshoot` (operators; dashboard: **Operations → Troubleshoot**) takes the call that is not
working — `{ "client": "key:ci", "server": "github", "tool": "create_issue", "arguments": {…} }` — and runs
(at most 30 runs per minute per client on each instance; more answer `429 Too Many Requests` with `RateLimit` headers):

1. **Upstream reachability** — the server is configured, connected and lists the tool;
2. **Authentication / key** — the client id resolves to a configured key (or carries its scope in a token);
3. **Tenancy / scope** — the central authorizer: key scope, tenant role, isolation, delegation;
4. **Policy simulation** — the [14.7 policy simulation](gitops.md) against the running config;
5. **Rate limits / quotas** — the limit that applies and recent quota / budget refusals of the client;
6. **Plugin health** — open circuit breakers (a `closed` failure policy fails the check, `open` warns).

Each check is `pass`, `warn` or `fail` with a detail and, where it helps, the `configPath` to look at. The report is
**redacted** — argument values are replaced by `<redacted>` (names are kept), no keys or secrets — and kept in memory
so it can be shared by id: `GET /api/v1/admin/ops/reports/<id>` (operators and viewers).

## Dashboard

**Operations** sits between History and Config. The four views are an ARIA tab list (arrow keys, Home / End), every
form field is labelled, results move focus to the result card and status changes are announced through a polite live
region. The page shows the `403` hint when the key is neither an operator nor a console viewer.

## Disabling

`controlPlane.console.enabled: false` removes the routes (`404`) and stops recording traces.
