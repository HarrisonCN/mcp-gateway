# Agent session recording, replay and evals (5.5)

Record what an agent did through the gateway, then replay it later as a regression test — after upgrading an MCP
server, changing policy, or switching a model.

```yaml
replay:
  enabled: true          # capture arguments + results (redacted) — required for recording
sessions:
  dir: ./recordings      # optional: persist recordings as JSON next to the config
  maxRecordings: 100
```

## Record

```bash
# everything client "ci-bot" did in the last hour
curl -X POST $GW/api/v1/admin/sessions -H "Authorization: Bearer $OP" -H 'content-type: application/json' \
  -d '{"name":"triage-flow","clientId":"ci-bot","since":"2026-10-08T12:00:00Z"}'
```

Filters: `clientId`, `since` / `until` (ISO), `tools`. Truncated captures (over `replay.maxBytes`) and replays are
skipped. Recordings can also be imported (`PUT /admin/sessions/<name>` with `{ "steps": [...] }`) and exported
(`GET`), so they can live in git next to your agent.

## Replay and grade

`POST /api/v1/admin/sessions/<name>/replay` with `{ "mode": "structure", "stopOnFailure": false }`:

| mode | a step passes when |
|------|--------------------|
| `success` (default) | it succeeds again (a recorded failure must fail again) |
| `structure` | the result has the same JSON shape (keys and value types) |
| `exact` | the result is identical |

The report has `passRate`, `passed` / `failed` / `skipped`, recorded vs replay latency, and per-step outcomes with a
structural diff for failures. Replays run through the full pipeline (auth, policy, quotas, costs) as client
`replay:<name>`.
