# Live collaborative debugging (8.3)

When an agent misbehaves in production, several people usually need to look at the same tool calls at once.
A **debug session** streams the matching calls live to every participant, can **pause** calls at breakpoints so
someone can inspect and **edit** the arguments before resuming (or **abort** them), keeps shared **notes**, and can
**replay** any captured call.

```yaml
debugSessions:
  maxSessions: 10
  holdTimeoutSeconds: 60   # paused calls are aborted (-32020) when nobody resumes them in time
  maxEvents: 500
```

Sessions are created at runtime by operators:

```bash
curl -X POST $GW/api/v1/admin/debug-sessions -H "authorization: Bearer $OP" -H 'content-type: application/json' \
  -d '{"name":"checkout bug","user":"alice","match":{"tools":["payments/*"],"clients":["key:checkout"]},
       "breakpoints":[{"tool":"payments/charge","when":{"path":"currency","equals":"JPY"}}]}'
```

| | |
|---|---|
| `POST …/:id/join` `{ user }` | add a collaborator (also `x-debug-user` header on any call) |
| `GET …/:id/events` | Server-Sent Events: `call`, `paused`, `resumed`, `aborted`, `result`, `note`, `join`, `breakpoint`, `replay` (resume with `Last-Event-ID`) |
| `GET …/:id?after=<seq>` | session state, paused calls, events after `seq` (polling) |
| `POST …/:id/calls/:callId/resume` `{ arguments? }` | resume, optionally with edited arguments |
| `POST …/:id/calls/:callId/abort` `{ reason? }` | fail the call with JSON-RPC **-32020** |
| `POST` / `DELETE …/:id/breakpoints[/:n]` | change breakpoints live |
| `POST …/:id/notes` `{ text, callId? }` | shared annotations |
| `POST …/:id/replay/:callId` | re-run a captured call (client `debug:<session>`) |
| `DELETE …/:id` | close; paused calls resume unchanged |

Arguments and results are redacted (keys, tokens, secrets) in every event. Debug sessions live in memory on the
gateway that serves the call; with a control plane, open the session on the data plane you are debugging.
