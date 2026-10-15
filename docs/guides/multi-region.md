# Multi-region active-active (5.2; consistency 14.5; control plane 2.0 16.2)

Run a full gateway in every region and let them peer. Each region serves traffic on its own; regions replicate a
small shared state — **revocations**, a key-value store and which upstream servers they have online — so a key revoked
in one region is refused in all of them, and a call whose upstream is down locally can be failed over to a region that
still has it.

```yaml
# eu-west
features:
  regions:
    self: eu-west
    syncIntervalMs: 5000   # default 5000, min 250
    downAfter: 3           # failed syncs before a peer is "down"
    consistency:           # 14.5.0 (these are the defaults)
      maxStalenessMs: 30000
      maxClockSkewMs: 30000
      onStale: deny
      # revocationSloMs: 30000   # 16.2.0: revocation propagation SLO (default: maxStalenessMs)
    peers:
      - { id: us-east, url: https://us.gw.example.com, apiKey: "${US_ADMIN_KEY}", priority: 1 }
```

Configure the mirror image on `us-east`. `apiKey` must be an operator (unscoped) key on the peer. A peer only
accepts syncs from regions listed in its own `peers`.

## Consistency boundaries (14.5)

Multi-region is **eventually consistent with bounded staleness**. What crosses regions and what does not is fixed and
reported by `GET /api/v1/admin/regions/report` (`boundaries`):

| State | Where it lives | How it converges |
| --- | --- | --- |
| Revocations | **replicated** | grow-only set: union on every sync; a revoked client id is never un-revoked by a merge |
| `kv` entries (replicated config) | **replicated** | version vectors; causally newer wins, concurrent writes resolve last-writer-wins and are counted as conflicts |
| Server availability | **replicated** (gossip) | last sync wins; drives failover routing |
| Sessions (MCP, `sessions`) | region-local | a client reconnecting to another region starts a new session |
| Rate limits, quotas, budgets | region-local | each region counts in its own store: a limit of N per minute is N **per region** |
| Policy, config, config generations | region-local | deploy them to every region (GitOps / control plane); the report flags a differing policy hash as `policyDrift` |
| API keys, portal keys | region-local | keys are configured per region; **revoking** one is replicated (see below) |
| Caches, task runs, audit | region-local | — |

Nothing region-local is ever sent in a sync exchange; the exchange carries `entries`, `revocations`, `servers`, the
sender's clock and a config fingerprint (policy hash + config generation — hashes only, never config values).

### Revocations fail closed

- `POST /api/v1/admin/regions/revocations` `{ "clientId": "key:ci-bot", "reason": "leaked" }` (or
  `mcp-gateway regions revoke key:ci-bot --reason leaked`) revokes a client id in every region. Revoking a developer
  portal key (`DELETE /api/v1/portal/me`, `POST /api/v1/portal/keys/<id>/revoke`) is recorded the same way as
  `key:portal-<id>`.
- A tool call by a revoked client id is refused with JSON-RPC **-32028** in every region that has learned the
  revocation — at most `maxStalenessMs` after it was issued, because:
- A region is **fresh** while every peer exchanged state with it within `maxStalenessMs`. While it is not — a
  partition, a peer down, a region that just started and has not synced yet — it **cannot confirm** that no other region
  revoked the caller, so with `onStale: deny` (default) it refuses **every** tool call with JSON-RPC **-32027**. The
  admin API keeps working so operators can inspect and repair.
- `onStale: allow` restores the 14.4 behaviour (keep serving while stale); revocations a region has learned are still
  enforced. Use it only where availability matters more than revocation latency.
- With a shared store (`store.backend: redis`, sqlite or eventlog), the instances of one region exchange their
  revocations through it on every sync round; an instance whose store cannot be read is not fresh either.

Revocations cannot be undone: issue a new key instead.

**Behaviour change in 14.5.0.** With peers configured, a region that cannot reach a peer for longer than
`maxStalenessMs` stops serving tool calls. When a region is gone for good, remove it from `peers` everywhere (the
section hot reloads); during a planned partition set `onStale: allow`.

### Replicated config: version vectors and generation fencing

`PUT /api/v1/admin/regions/kv/<key>` `{ "value": … }` writes a key; it reaches every peer on the next sync round.
Each entry carries a version vector (`vv`, per-region write counters) and a `gen` (generation, the sum of the vector):

- a causally newer write always wins, whatever the clocks say — a delayed or replayed older version is rejected
  (`rejected.stale`);
- writes made concurrently in two regions converge everywhere on the same value (last-writer-wins by timestamp, then
  region id), with the joined vector; they are counted in `conflicts` and listed in `conflictedKeys`;
- `PUT … { "value": …, "ifGeneration": 3 }` writes only while the key is still at generation 3 (0 = absent) and
  answers **409** with `currentGeneration` otherwise — a writer holding a stale view is fenced off.

`DELETE` writes a tombstone so the deletion replicates too. Entries relay through intermediate regions. Entries from
14.4 and older peers (no vector) are merged last-writer-wins as before.

### Clock skew

Timestamps are hybrid (wall clock, bumped to stay monotonic). A replicated write stamped more than `maxClockSkewMs`
ahead of the local clock is **rejected** (`rejected.clockSkew`) and never moves the local clock; 14.4 accepted any
timestamp, so one region with a runaway clock won every later conflict. Each peer's skew (its clock minus ours at the
last exchange, including one-way latency) is reported as `skewMs` / `clockSkew: ok | exceeded`. Revocations do not
depend on clocks and replicate regardless.

## Health, report and metrics

- `GET /api/v1/admin/regions/health` — 200 when fresh, 503 when not (`{ region, fresh, stale, maxLagMs }`). Point
  your global load balancer's health check at it to drain a partitioned region (it needs an operator key).
- `GET /api/v1/admin/regions/report` — `fresh`, settings, `boundaries`, per peer `status`, `fresh`, `lagMs`,
  `skewMs`, `clockSkew`, `policyDrift`, `lastError`; `conflicts`, `rejected`, `revocations`, `denied`.
- `mcp-gateway regions report [--json]` prints it; `mcp-gateway regions health` exits 0 when fresh, 2 when not
  (`--url`, `--key` or `MCP_GATEWAY_URL` / `MCP_GATEWAY_ADMIN_KEY`).
- Prometheus: `mcp_gateway_region_fresh`, `mcp_gateway_region_replication_lag_seconds{peer}`,
  `mcp_gateway_region_peer_up{peer}`, `mcp_gateway_region_clock_skew_seconds{peer}`,
  `mcp_gateway_region_denied_total{reason="stale|revoked"}`, `mcp_gateway_region_rejected_entries_total{reason}`,
  `mcp_gateway_region_conflicts_total`, `mcp_gateway_region_revocations`; 16.2.0:
  `mcp_gateway_region_revocation_slo_seconds`, `mcp_gateway_region_revocation_propagation_seconds{quantile="0.5|0.99"}`
  (+ `_count`), `mcp_gateway_region_revocation_slo_breaches_total`.

## Control plane 2.0 (16.2.0-canary.0, development prerelease)

**Revocation propagation SLO.** When a revocation issued in another region first reaches this one (directly or relayed
through a third region), the gateway times it: this region's clock now, minus the issuing region's revocation time
corrected by that peer's observed clock skew (never negative). A revocation slower than `consistency.revocationSloMs`
(default: `maxStalenessMs`) is a **breach**: counted, put on the operations console timeline as `revocation-slo`
(severity warning) and exported. `GET /api/v1/admin/regions/report` has `revocationPropagation`: `sloMs`, `samples`,
`breaches`, `p50Ms` / `p99Ms` / `maxMs` (nearest rank over the last 200) and the 20 most recent samples
(`clientId`, `from`, `latencyMs`, `breached`). Revocations this region issued itself, or learnt from the other
instances of this region through the shared store, are not sampled. The measurement includes clock-skew error (the
skew is estimated from the last exchange and includes one-way latency).

**Cross-region rollup.** Each region adds its own figures to the sync exchange — its cost ledger since the start of
the current UTC day (total and by tenant) and the call lineage it keeps (operations console traces) by outcome.
`GET /api/v1/admin/regions/rollup` answers one row per region (`self`, `fresh`, `stale` — the last figures it sent,
flagged — or `missing`) with `asOf` and `lagMs`, plus the sums in `total` (`costs`, `byTenant`, `lineage`) and
`complete: true` only while every peer is fresh with figures. The figures are as good as the sync interval and each
region's own retention: costs come from the in-memory ledger, lineage counts from the bounded trace buffer
(`controlPlane.console.traceBuffer`). The operations console cluster view (`GET /api/v1/admin/ops/cluster`) shows the
same rollup and the propagation summary under `regions`.

**Region-qualified lineage.** With `regions` configured, every lineage record (`GET /api/v1/admin/ops/lineage/…`)
carries `region` and `globalId` = `<region>:<requestId>`. A request id is only unique within the region that issued
it (a client's `X-Request-Id` is its correlation id, not the request id); the region-qualified id is unique across
regions. `GET /api/v1/admin/regions/lineage/<region>:<requestId>` resolves it from any region: its own record, or the
peer's, fetched with that peer's `apiKey` (`404` for an unknown region or request id, `400` without a region part,
`502` when the peer cannot be reached).

## Failover routing

`GET /api/v1/admin/regions/route/<serverId>` answers `local` when the server is online here, otherwise the
highest-priority healthy peer that reports it online (`{ target: "peer", peer, url }`), or `none`. Global load
balancers and clients use it to send a call to the right region.

## Status

`GET /api/v1/admin/regions` — this region, each peer's status (`unknown` / `up` / `down`), consecutive failures,
last sync and error, the servers it has online, `fresh` and the number of revocations. The section hot reloads.

## Testing partitions

The test suite runs two regions with their own Redis behind TCP fault proxies
(`test/regions-partition-redis-14-5-0.test.ts`) and in-process partitions / clock skew through `regionFaults`
(`test/regions-consistency-14-5-0.test.ts`).
