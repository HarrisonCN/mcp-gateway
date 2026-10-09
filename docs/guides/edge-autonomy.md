# Edge autonomy (10.7, EXPERIMENTAL)

`features.edgeAutonomy` lets an edge gateway keep answering when an upstream — or the whole network — is gone, and
reconcile when it comes back. It is **experimental**: `validate`, startup and `GET /api/v1/security` say so, and the
limits below are real.

```yaml
features:
  edgeRuntime:                        # local WASM tools (9.2), used by `action: wasm`
    tools: [{ name: distance, wasm: tools/distance.wasm, export: run }]
  edgeAutonomy:
    dir: .mcp-gateway/edge            # persist the outbox and last-good cache (relative to the config file)
    rules:                            # first match on "server/tool" wins; unmatched calls fail as usual
      - { match: "crm/get_*",    action: cache, maxAgeSeconds: 86400 }
      - { match: "geo/distance", action: wasm,  wasmTool: distance }
      - { match: "crm/update_*", action: queue }
      - { match: "payments/*",   action: deny, message: "Payments need a connection" }
    cacheEntries: 1000
    outboxLimit: 10000
    reconcile: { intervalMs: 5000, maxAttempts: 5, idempotencyArg: idempotencyKey }
```

## When is a server "disconnected"?

Any of: the upstream is not `online` in the gateway's health registry; `features.offline` reports the network gone
(remote transports, except `allowRemote`); an operator forced it (`POST /admin/edge-autonomy/connectivity
{ servers?: [...], disconnected: true }` — useful for drills); or a call just failed with not-connected / timeout.

## Local decisions

Local policy always runs first — `policy.rules`, Cedar / OPA, quotas and budgets decide before any rule here.

| Action | While disconnected |
|---|---|
| `cache` | Answer with the last good result for the same tool **and the same arguments**, if younger than `maxAgeSeconds`. The result carries `_meta["mcp-gateway/edge"] = { decision: "cache", cachedAt, reason }`. A miss fails with `-32018`. |
| `wasm` | Run the named `features.edgeRuntime` tool with the call's arguments. |
| `queue` | Store the call in the outbox and answer at once with a receipt (`structuredContent: { queued: true, outboxId }`). The caller gets **a receipt, not the result**. |
| `deny` | Refuse with `-32018` and `message`. |

## Reconcile

Every `reconcile.intervalMs` (and on `POST /admin/edge-autonomy/reconcile`) queued calls whose server is connected
again are replayed oldest first, through the full pipeline, as the client that made them. With
`reconcile.idempotencyArg` the outbox id is added to the arguments under that name so the upstream can de-duplicate.
A replay that fails is retried on later passes; after `maxAttempts` it becomes a `conflict` that an operator
resolves: `POST /admin/edge-autonomy/outbox/:id/retry` or `DELETE /admin/edge-autonomy/outbox/:id`.

## Admin API (operators)

| Method | Path | |
|---|---|---|
| `GET` | `/api/v1/admin/edge-autonomy` | Per-server connectivity, rules, cache size, outbox counts |
| `GET` | `/api/v1/admin/edge-autonomy/decisions` | Recent local decisions (cache / miss / wasm / queue / deny) with reasons |
| `POST` | `/api/v1/admin/edge-autonomy/connectivity` | Force servers (default all) disconnected / connected |
| `GET` | `/api/v1/admin/edge-autonomy/outbox?status=` | Outbox entries (`queued`, `applied`, `conflict`) |
| `POST` | `/api/v1/admin/edge-autonomy/reconcile` | Replay now → `{ applied, failed, conflicts, pending }` |
| `POST` | `/api/v1/admin/edge-autonomy/outbox/:id/retry` | Requeue a conflict |
| `DELETE` | `/api/v1/admin/edge-autonomy/outbox/:id` | Drop an entry |

## Limits (why it is experimental)

- No conflict *resolution*: the outbox replays calls; it does not merge state. A replay the upstream rejects is parked.
- At-least-once: a crash between a replay and the outbox write can replay a call twice — use `idempotencyArg`.
- Cached answers can be stale by up to `maxAgeSeconds`, and only identical arguments hit.
- Queued callers never see the real result; an agent that needs it must check later.
- State is per process.
