# Edge autonomy

`features.edgeAutonomy` lets an edge gateway keep answering when an upstream — or the whole network — is gone, and
reconcile when it comes back. It was introduced as experimental in 10.7 and is **generally available since 14.6.0**
("Edge Autonomy 正式化"): offline execution now has explicit permission boundaries, the queue expires, conflicts go to a
review queue, reconnect reconciliation is ordered, fenced and honours revocations learned on reconnect, and the queue
is sealed at rest.

```yaml
features:
  edgeRuntime:                        # local WASM tools (9.2), used by `action: wasm`
    tools: [{ name: distance, wasm: tools/distance.wasm, export: run }]
  edgeAutonomy:
    dir: .mcp-gateway/edge            # sealed queue, last-good cache, intent log (relative to the config file)
    rules:                            # first match on "server/tool" wins; unmatched calls fail as usual
      - { match: "crm/get_*",    action: cache, maxAgeSeconds: 86400 }
      - { match: "geo/distance", action: wasm,  wasmTool: distance }
      - { match: "crm/update_*", action: queue }
      - { match: "payments/*",   action: deny, message: "Payments need a connection" }
    policies:                         # 14.6: declared offline policy (first match on "server/tool")
      - { match: "crm/update_*", offline: allow, idempotent: true, conflictKey: [id], ttlSeconds: 3600 }
    highRisk: deny                    # 14.6 default: high / critical risk calls are not served offline
    queue: { ttlSeconds: 86400, maxItems: 10000, onExpiry: review }
    reconcile: { intervalMs: 5000, maxAttempts: 5, idempotencyArg: idempotencyKey, leaseMs: 30000 }
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
| `queue` | Store the call in the queue and answer at once with a receipt (`structuredContent: { queued: true, outboxId, expiresAt }`). The caller gets **a receipt, not the result**. |
| `deny` | Refuse with `-32018` and `message`. |

## Offline permission boundaries (14.6)

Before any local answer — a cached "success" is an answer too — the call's **offline risk** is classified:

1. a declared `policies[]` entry with `risk` (first match on `server/tool`);
2. else the tool's MCP annotations: `readOnlyHint: true` → low; `readOnlyHint: false` → high (write);
   `destructiveHint: true` → high; `idempotentHint: false` on a write → also non-idempotent;
3. else the tool name: payments (`pay`, `charge`, `refund`, `transfer`, `payout`, `purchase`, `checkout`, …) →
   **critical**; deletes (`delete`, `remove`, `drop`, `purge`, `wipe`, …) and writes (`create`, `update`, `set`,
   `send`, `rename`, `submit`, …) → **high**; reads (`get`, `list`, `search`, `lookup`, …) → low; anything else →
   medium.

| Risk | Offline by default |
|---|---|
| low, medium | allowed (the rule decides) |
| high, critical | **denied** with `-32018` (`highRisk: deny`) |

A policy overrides the default for the tools it matches: `offline: allow` permits the call offline whatever its
risk (you accept that it is cached / queued), `offline: deny` refuses even a read. `highRisk: allow` restores the 10.7
behaviour for every tool (not recommended). Denials appear in `GET /admin/edge-autonomy/decisions` with the risk, in
`mcp_gateway_edge_offline_denied_total{risk}` and in `mcp-gateway edge report`.

The annotations come from the upstream's tool list; the gateway remembers them while the upstream is reachable. For a
tool whose upstream was never seen, only the name heuristics apply — declare a policy for anything that matters.

> **Behaviour change in 14.6.0.** A `queue` / `cache` / `wasm` rule that matches writes, deletes or payments no longer
> answers them offline. Add a policy (`{ match: "crm/update_*", offline: allow }`) for each tool you want to keep
> queuing, or set `highRisk: allow`.

## Queue: expiry, size, idempotency

- Every queued call gets an expiry: `policies[].ttlSeconds`, else `queue.ttlSeconds` (default 24 h). An expired call
  is **never replayed**: with `queue.onExpiry: review` (default) it is parked in the review queue, with `drop` it is
  removed.
- `queue.maxItems` (default `outboxLimit`, 10 000) bounds the queue; a call beyond it is refused with `-32018`.
- **Idempotency keys** reuse the 14.4 durable intent log. With `reconcile.idempotencyArg`, a client may send its own
  key in that argument: the same key with the same payload returns the first receipt (`duplicate: true`); the same key
  with another payload is accepted into the **review queue** (`review: "idempotency-conflict"`), never replayed on its
  own. Without a client key the outbox id is the key. The key is passed to the upstream on replay.

## Reconcile (14.6)

Every `reconcile.intervalMs` (and on `POST /admin/edge-autonomy/reconcile` / `mcp-gateway edge reconcile`) queued
calls whose server is connected again are replayed through the full pipeline:

- **In order.** Oldest first; a client's later calls to a server wait (`held`) while an earlier one is pending or
  failed. Parked entries (review, conflict, rejected) do not hold the lane.
- **One reconciler, fenced.** A reconcile holds a lease (`reconcile.leaseMs`) and a fencing epoch. A reconciler that
  was superseded (its lease lapsed and another took over) stops before its next replay.
- **Intent log.** Before each replay an intent is written, after it a commit (the 14.4 `DurableKv`, under
  `<dir>/.reconcile`). After a crash (`kill -9`) a committed replay is **not sent again**; a replay that was in flight
  is resent with the same idempotency key only when the call is idempotent (`policies[].idempotent: true`, or the
  tool's `idempotentHint`), otherwise it goes to review as `outcome-unknown` — it may or may not have run upstream, an
  operator decides.
- **Revocations.** Each replay runs as the caller's **current** credential: a key removed or re-scoped while the edge
  was offline does not act through the queue (`rejected`, `credential-removed`), and a client id revoked locally
  (developer portal / operator) or by a revocation authority — the 14.5 replicated multi-region revocations — is
  `rejected` (`revoked`). Rejected calls are never executed and cannot be retried. Before replaying, the edge asks the
  authorities to confirm they are fresh **since reconnect** (with `regions`: one sync round with every peer); until
  they are, queued calls wait (`pending`, `waiting: "revocations not confirmed fresh …"`).
  `reconcile.requireFreshRevocations: false` skips the wait (the local checks still apply).
- **Conflicts go to review.** A replay the upstream rejects as a conflict / stale version (`conflict`, `precondition`,
  `stale`, `version mismatch`, 409 / 412 in the error) goes to review at once (`upstream-conflict`), without retries.
  With `policies[].conflictKey`, writes to the same record (`[id]` → the `id` argument) queued by **different
  clients** are concurrent offline writes: the later one goes to review (`conflict-key`, `conflictWith`). Other
  failures are retried on later passes; after `maxAttempts` the entry becomes a `conflict` (10.7).

`POST /admin/edge-autonomy/outbox/:id/retry` re-queues a review or conflict entry as an operator decision (conflict-key
checks are skipped, an in-doubt replay is resent); `DELETE /admin/edge-autonomy/outbox/:id` drops it.

## Sealed at rest (14.6)

With `dir`, `outbox.json` and `cache.json` are sealed with **AES-256-GCM** (the file kind is bound as associated
data), written `0600` in a `0700` directory. The key is read from the environment variable named by `seal.keyEnv`
(32 bytes, base64 or hex) or, without it, generated once as `<dir>/.seal.key` (`0600`). A file that fails
authentication (tampered, truncated, other key) is quarantined as `<file>.tampered-<ts>`, its entries are **not**
replayed, and the failure is reported (`GET /admin/edge-autonomy` → `seal`, `mcp_gateway_edge_seal_failures_total`).
A plaintext outbox written by 14.5 or earlier is migrated (sealed) on first load.

The generated key file sits next to the data it protects: it stops copies of the state files (backups, support
bundles) from being read or edited, not an attacker who can read the gateway's directory. Use `seal.keyEnv` with a
secret from your platform to separate the key from the data.

## Admin API (operators)

| Method | Path | |
|---|---|---|
| `GET` | `/api/v1/admin/edge-autonomy` | Per-server connectivity, rules, policies, seal state, cache size, queue counts |
| `GET` | `/api/v1/admin/edge-autonomy/report` | Offline boundaries, queue (expiry, review, oldest age), denials by risk, reconcile epoch / last result / totals |
| `GET` | `/api/v1/admin/edge-autonomy/decisions` | Recent local decisions (cache / miss / wasm / queue / deny) with reasons and risk |
| `POST` | `/api/v1/admin/edge-autonomy/connectivity` | Force servers (default all) disconnected / connected |
| `GET` | `/api/v1/admin/edge-autonomy/outbox?status=` | Queue entries (`queued`, `applied`, `review`, `conflict`, `rejected`) |
| `GET` | `/api/v1/admin/edge-autonomy/review` | The review queue (`review` + `conflict`) with `reviewReason` |
| `POST` | `/api/v1/admin/edge-autonomy/reconcile` | Replay now → `{ applied, pending, held, failed, conflicts, review, rejected, expired, deduplicated, fenced, waiting? }` |
| `POST` | `/api/v1/admin/edge-autonomy/outbox/:id/retry` | Re-queue a review / conflict entry (409 for rejected / applied) |
| `DELETE` | `/api/v1/admin/edge-autonomy/outbox/:id` | Drop an entry |

## CLI

```bash
mcp-gateway edge report --url http://edge-1:4000 --key "$MCP_GATEWAY_ADMIN_KEY"
mcp-gateway edge queue --status review
mcp-gateway edge reconcile
```

`--json` prints the raw API answer; `MCP_GATEWAY_URL` / `MCP_GATEWAY_ADMIN_KEY` work as for the other admin commands.

## Metrics

| Metric | |
|---|---|
| `mcp_gateway_edge_queue_items{status}` | Queue entries by status |
| `mcp_gateway_edge_queue_oldest_age_seconds` | Age of the oldest queued call |
| `mcp_gateway_edge_decisions_total{action}` | Local decisions while disconnected |
| `mcp_gateway_edge_offline_denied_total{risk}` | Calls refused by the offline permission boundary |
| `mcp_gateway_edge_reconcile_total{result}` | `applied`, `failed`, `conflict`, `rejected`, `review`, `expired`, `deduplicated`, `fenced` |
| `mcp_gateway_edge_outcome_unknown_total` | Replays in flight when the gateway stopped |
| `mcp_gateway_edge_seal_failures_total` | Sealed files that failed authentication (or could not be sealed) |

## Limits

- Delivery is at least once for idempotent calls and at most once for the rest: an in-doubt non-idempotent replay is
  parked, not guessed. Upstreams should de-duplicate on the idempotency key.
- Queued callers never see the real result; an agent that needs it must check later.
- Cached answers can be stale by up to `maxAgeSeconds`, and only identical arguments hit.
- The risk classifier is a safety net, not a guarantee: name heuristics can be wrong both ways — declare policies.
- The reconcile lease is not renewed during a very long replay; fencing (not the lease) is what keeps two reconcilers
  from both replaying. State is per gateway process; one edge directory must not be shared by two running gateways.
- Revocations are honoured as far as the gateway knows them: local key changes, portal / operator revocations and
  revocation authorities (`regions`). A credential revoked only at an external identity provider (a JWT that is still
  valid) is not known to the edge.
