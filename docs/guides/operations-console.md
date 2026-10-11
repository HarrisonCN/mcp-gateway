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
