# Policy simulation and dry-run (6.5)

Change `policy` with evidence instead of hope.

## Simulate a candidate policy

```bash
curl -X POST $GW/api/v1/admin/policy-sim/simulate -H "authorization: Bearer $OP" -H 'content-type: application/json' \
  -d '{"policy":{"default":"deny","rules":[{"name":"reads","effect":"allow","tools":["*read*","*list*","*search*"]}]}}'
```

The candidate is evaluated against past calls and every decision is compared with the running policy. Calls come from:

1. `calls` in the request (`[{ clientId?, serverId, tool, args? }]`), or
2. the replay recorder (`replay.enabled: true`) — includes the (redacted) arguments, so argument matchers work, or
3. recent request metrics (`source: "metrics"`, or when nothing is captured) — no arguments.

The report has `changed` / `unchanged`, `transitions` (`allow→deny`, `allow→approve`, …), hits `byRule`, the
impact `byClient` and `byTool`, and up to 50 example calls with both decisions.

## Dry-run one call

`POST /api/v1/admin/policy-sim/dry-run` `{ server, tool, arguments, clientId }` → the enforced decision (and the
shadow decision) without calling the upstream.

## Shadow mode

```yaml
features:
  policyShadow:
    default: deny
    rules:
      - {name: read-only, effect: allow, tools: ["*read*", "*list*", "*search*"]}
```

The shadow policy is evaluated on every call that the enforced policy lets through and never blocks anything.
`GET /api/v1/admin/policy-sim/shadow` shows how often the two agree, the transitions, and the latest divergences;
`POST …/shadow/reset` clears the counters. When the divergences are the ones you expect, move the rules into
`policy`. Set `enabled: false` to pause shadow evaluation without removing it.
