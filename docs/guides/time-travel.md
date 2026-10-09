# Full-chain replay and time-travel debugging (10.6)

`features.timeTravel` keeps an append-only **journal** of every configuration the gateway applied and every tool call
it handled — including calls it refused (policy, quota, budget, hook refusals) — and lets you look at the gateway as
it was at any instant, follow an agent's call chain, and replay history against today's configuration and upstreams.

```yaml
features:
  timeTravel:
    dir: .mcp-gateway/journal   # optional: persist as daily JSONL files (relative to the config file)
    retentionDays: 7            # persisted files older than this are deleted at load
    maxEntries: 20000           # entries kept in memory (oldest dropped)
    results: true               # keep redacted results (needed for result diffs on replay)
    maxBytes: 16384             # per argument / result payload; larger payloads are dropped and marked truncated
```

What is recorded per call: time, journal id, client, tenant, server, tool, redacted arguments, outcome (success /
error code and message, `refused: true` when the gateway refused it), duration, the redacted result (with
`results: true`) and the hash of the configuration it ran under. Configurations are recorded (redacted, with a
SHA-256 content hash) whenever they change — at the first call after start and after every hot reload.

## Admin API (operators)

| Method | Path | |
|---|---|---|
| `GET` | `/api/v1/admin/time-travel` | Journal status: entries, calls, configs, time range |
| `GET` | `/api/v1/admin/time-travel/state?at=<ISO or epoch ms>` | Configuration in effect at that instant, call statistics up to it, the 20 most recent calls before it |
| `GET` | `/api/v1/admin/time-travel/calls?from&to&client&server&tool&limit` | Journaled calls in a range (newest first, max 1000) |
| `GET` | `/api/v1/admin/time-travel/chain/:id?windowMs=60000` | One call, the config it ran under, and the same client's calls around it |
| `GET` | `/api/v1/admin/time-travel/config-diff?from&to` | JSON diff of the configuration between two instants |
| `POST` | `/api/v1/admin/time-travel/replay` | `{ from?, to?, ids?, client?, server?, tool?, limit?, execute? }` — see below |
| `POST` | `/api/v1/admin/time-travel/reset` | Clear the in-memory journal (persisted files are kept) |

### Replay

For each selected call (max 100) the replay reports the `policy.rules` decision under the configuration the call ran
with **and** under the running configuration (`policy: { then, now, changed }`) — "would this call still be
allowed?". With `execute: true` the call is executed again through the full pipeline (auth scopes aside, as the
replaying operator; policy, hooks and limits apply) against **today's** upstreams, and the new result is diffed against
the recorded one (`replay: { success, outcomeChanged, diff }`).

Replay with `execute: true` really calls the tools again. Only use it for read-only / idempotent tools.

## Limits

- The journal is per process. With several replicas each journals its own calls; with `dir` on shared storage use a
  directory per replica.
- "State at an instant" is the journaled configuration and call statistics, not a snapshot of upstream servers or of
  in-memory caches; replay runs against upstreams as they are now.
- Only the `policy.rules` decision is re-evaluated without executing; Cedar / OPA (`policyEngine`), quotas and
  budgets are evaluated only by `execute: true`.
- Arguments, results and configuration go through the gateway's secret redaction before they are stored. Values that
  redaction does not recognise as secrets are stored as-is — set `results: false` (or do not enable the feature) for
  tools that return sensitive data.
