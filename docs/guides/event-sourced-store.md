# Event-sourced state store (9.0)

`store.backend: eventlog` makes a **single-instance** gateway keep its shared state across restarts without Redis.

```yaml
version: 9
store:
  backend: eventlog
  eventlog:
    dir: .mcp-gateway/store    # relative to the config file (default)
    snapshotEvery: 10000       # events between snapshots (default 10 000)
    fsync: false               # fsync every append (default false)
  failureMode: open
```

## How it works

- **Append:** every `set`, `incr` and `del` is appended to `<dir>/events.log` as one JSON line. Expiry is stored as an
  absolute time, so a replay never extends a window.
- **Replay:** on start the store loads `<dir>/snapshot.json` (expired keys dropped) and applies the log on top.
  A torn last line (crash mid-write) is skipped.
- **Compaction:** every `snapshotEvery` events, on `POST /api/v1/admin/store/compact` and on shutdown, the live state is
  written atomically (temp file + rename) and the log is truncated.

What survives a restart: global and per-key rate-limit windows, brute-force lockouts, and MCP session metadata (so
clients keep their `Mcp-Session-Id`).

## Operations

```bash
curl -H "Authorization: Bearer $KEY" localhost:4000/api/v1/admin/store
# {"backend":"eventlog","failureMode":"open","eventlog":{"kind":"eventlog","dir":"…","keys":12,"eventsSinceSnapshot":40,
#  "totalEvents":40,"snapshots":1,"lastSnapshotAt":"…","replayed":0}}
curl -X POST -H "Authorization: Bearer $KEY" localhost:4000/api/v1/admin/store/compact
```

Use `backend: redis` for several replicas; the event log is per process. Embedders can use the store directly:
`new EventLogStateStore({ dir })`.
