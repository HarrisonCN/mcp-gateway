# Cluster config rollout (14.1)

A control plane (`controlPlane.role: control`, see the [control plane guide](control-plane.md)) distributes its
running config to every data plane. From 14.1 each distributed config is a numbered **generation**, and the control
plane decides which generation each data plane runs: all at once, or canary first and then everyone. A generation that
data planes fail to apply, or that breaks them, is rolled back automatically, and a data plane that stays on the wrong
generation is reported as **diverged** — the cluster does not quietly run two configs for long.

Nothing changes for existing clusters: without a `rollout` block the strategy is `all-at-once`, the 7.0 behaviour,
with generations, local rollback on data planes and divergence reporting added.

## Configuration

```yaml
version: 12
controlPlane:
  role: control
  configApi: true
  rollout:
    strategy: canary # all-at-once (default) | canary
    canary: {nodes: 1} # or {percent: 10} (rounded up, at least one data plane)
    bakeMs: 60000 # canary nodes must run the new generation this long, without failures, before everyone gets it
    failureThreshold: 1 # data planes that must fail a generation before it is rolled back
    autoRollback: true # false: mark the rollout failed and leave the decision to an operator
    maxDivergenceMs: 60000 # a data plane off its target generation longer than this is reported as diverged
    history: 10 # generations kept for rollback
auth:
  strategy: api-key
  apiKeys:
    - ${OPERATOR_KEY}
```

`rollout` is a control-plane setting: a data plane (`role: data`) refuses it. Every key is optional — see
[configuration](../configuration.md#cluster-rollout-141) for the table.

## Generations

- The first config a control plane distributes is generation 1. Every change to its running config (file reload,
  `PUT /api/v1/admin/config`, `mcp-gateway apply`, the dashboard) that changes the distributed content publishes the
  next generation; a change that leaves the distributed content identical keeps the current one.
- Numbers only go up. A rollback is published as a **new** generation carrying the content of an older one, so
  "generation 3 restores generation 1" — data planes never move backwards in the numbering.
- The config pull (`GET /api/v1/admin/data-planes/config`) answers with the generation the asking data plane should
  run (`X-Config-Generation` header and `generation` in the body; the data plane sends its `X-Node-Id`). Data planes
  report the generation they run in their heartbeat.

## Strategies

**`all-at-once`** (default): every data plane targets the newest generation and picks it up within its
`pullIntervalMs`.

**`canary`**: when a new generation is published, the first `canary.nodes` data planes (sorted by node id; or
`canary.percent` of the known ones) target it; everyone else stays on the previous (*stable*) generation. Once every
canary node has run the new generation for `bakeMs` with no failure reported, the rollout is promoted and every data
plane targets it. The very first generation goes to everyone — there is nothing to canary against. A data plane that
joins during a canary gets the stable generation.

## Health check and local rollback on data planes

After applying a pulled config, a data plane runs a post-apply health check: if the new config has upstream servers,
some were online before the apply, and none of them comes online within a grace period (half of `pullIntervalMs`, at
most 5 s), the generation is unhealthy. The data plane then

1. re-applies the config it ran before (local rollback — it keeps serving traffic),
2. reports the generation as failed in its heartbeat (`failedGeneration`, `lastError`), and
3. does not apply that same config again until the control plane serves a different one (no apply loop).

A generation the data plane refuses outright (invalid config) is reported the same way. An upstream outage that
started before the change does not make a new generation fail its check.

`GET /api/v1/data-plane` (on the data plane, operators) shows `generation`, `failedGeneration` and `rollbacks`.

## Automatic rollback

When `failureThreshold` data planes report the current generation as failed, the control plane (with
`autoRollback: true`)

- marks that generation **bad**,
- publishes a new generation restoring the last good one, and every data plane targets it,
- records `lastRollback` (`from`, `to`, `restored`, `reason` naming the failing nodes) in the rollout status.

With `autoRollback: false` the rollout state becomes `failed` and nothing is rolled back.

A rollback changes what the control plane **distributes**, not its own running config: the control plane keeps
running the config you gave it, and `GET /api/v1/admin/config` still shows it. Fix the config (any change publishes a
new generation) or force it.

### Bad generations need force

Re-submitting content that already failed (for example, re-applying the same file) is **refused**: no new generation
is published, data planes keep their current one, and the rollout status shows `refused: { badGeneration, etag, at }`.
To retry it on purpose:

```bash
curl -X POST https://cp.internal:4000/api/v1/admin/cluster/rollout \
  -H "Authorization: Bearer $OPERATOR_KEY" -H 'Content-Type: application/json' \
  -d '{"force": true}'
```

This publishes the control plane's running config as a new generation even when its content was rolled back before.

## Manual rollback

```bash
# back to the last good generation before the current one
curl -X POST https://cp.internal:4000/api/v1/admin/cluster/rollback \
  -H "Authorization: Bearer $OPERATOR_KEY" -H 'Content-Type: application/json' \
  -d '{"reason": "canary error rate"}'
# or to a specific kept generation
curl -X POST https://cp.internal:4000/api/v1/admin/cluster/rollback \
  -H "Authorization: Bearer $OPERATOR_KEY" -H 'Content-Type: application/json' \
  -d '{"to": 4}'
```

An unknown or no-longer-kept generation answers `409`. A manual rollback during a canary ends the canary.

## Divergence

A data plane whose running generation differs from its target for longer than `maxDivergenceMs` is **diverged**: it
is listed in `diverged`, its node entry carries `diverged: true` and `divergedForMs`, and `converged` is `false`. A
non-canary data plane on the stable generation during a canary is *not* diverged — that is its target. A data plane
that stopped pulling stays diverged until it catches up or is removed with `DELETE /api/v1/admin/data-planes/:nodeId`.
`GET /api/v1/admin/data-planes` shows `inSync` per data plane against its own target.

## Rollout status

`GET /api/v1/admin/cluster/rollout` (operators, `role: control` only):

```json
{
  "state": "canary",
  "strategy": "canary",
  "generation": 5,
  "etag": "\"3f9c…\"",
  "stableGeneration": 4,
  "canaryNodes": ["dp-a"],
  "nodes": [
    {"nodeId": "dp-a", "generation": 5, "target": 5, "inSync": true, "diverged": false, "lastSeen": "2026-10-11T05:00:00.000Z"},
    {"nodeId": "dp-b", "generation": 4, "target": 4, "inSync": true, "diverged": false, "lastSeen": "2026-10-11T05:00:01.000Z"}
  ],
  "converged": true,
  "diverged": [],
  "failures": [],
  "history": [
    {"generation": 4, "etag": "\"aa01…\"", "publishedAt": "2026-10-11T04:58:00.000Z", "source": "publish", "bad": false},
    {"generation": 5, "etag": "\"3f9c…\"", "publishedAt": "2026-10-11T04:59:30.000Z", "source": "publish", "bad": false}
  ]
}
```

`state` is `idle` (nothing published yet), `canary`, `complete`, `failed` (threshold reached with
`autoRollback: false`) or `rolled-back`.

## Metrics

| Metric | Where | |
|---|---|---|
| `mcp_gateway_cluster_config_generation{role}` | control plane (`role="control"`: newest generation), data plane (`role="data"`: the generation it runs) | gauge |
| `mcp_gateway_cluster_rollout_state{state}` | control plane | gauge, 1 for the current state |
| `mcp_gateway_cluster_diverged_nodes` | control plane | gauge |
| `mcp_gateway_cluster_rollbacks_total{role,trigger}` | control plane (`trigger="automatic"` / `"manual"`), data plane (`trigger="health_check"`) | counter |

`mcp_gateway_config_generation` (13.3) is unchanged: it counts the gateway's own committed config generations
(hot reloads), not cluster generations.

Alert on `mcp_gateway_cluster_diverged_nodes > 0` and on increases of `mcp_gateway_cluster_rollbacks_total`.
