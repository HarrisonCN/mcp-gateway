# Multi-region active-active (5.2)

Run a full gateway in every region and let them peer. Each region serves traffic on its own; regions replicate a
small shared key-value state and gossip which upstream servers they have online, so a call whose upstream is down
locally can be failed over to a region that still has it.

```yaml
# eu-west
regions:
  self: eu-west
  syncIntervalMs: 5000   # default 5000, min 250
  downAfter: 3           # failed syncs before a peer is "down"
  peers:
    - { id: us-east, url: https://us.gw.example.com, apiKey: ${US_ADMIN_KEY}, priority: 1 }
```

Configure the mirror image on `us-east`. `apiKey` must be an operator (unscoped) key on the peer. A peer only
accepts syncs from regions listed in its own `peers`.

## Replicated state

`PUT /api/v1/admin/regions/kv/<key>` with `{ "value": … }` writes a key; it reaches every peer on the next sync
round. Conflicts resolve **last-writer-wins** by a per-region monotonic timestamp, ties by region id. `DELETE`
writes a tombstone so the deletion replicates too. Entries relay through intermediate regions.

## Failover routing

`GET /api/v1/admin/regions/route/<serverId>` answers `local` when the server is online here, otherwise the
highest-priority healthy peer that reports it online (`{ target: "peer", peer, url }`), or `none`. Global load
balancers and clients use it to send a call to the right region.

## Status

`GET /api/v1/admin/regions` — this region, each peer's status (`unknown` / `up` / `down`), consecutive failures,
last sync and error, and the servers it has online. The section hot reloads.
