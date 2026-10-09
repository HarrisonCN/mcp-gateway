# Multi-agent orchestration 2.0: durable task graphs (10.7)

`features.taskGraphs` runs graphs of tool calls and agent tasks that can span gateways and survive restarts.
Task graphs replaced the 6.2 workflow engine in 11.0 (`mcp-gateway migrate --to 11` converts workflows — see
[Migrating to 11.0](migrating-to-v11.md)). Compared with those in-memory DAGs of local tools, task graphs add cross-gateway nodes,
checkpoints, resume, retry with capped exponential backoff and saga-style compensation.

```yaml
features:
  a2aFederation:                         # needed only for remote nodes
    remotes: [{ id: eu-gateway, url: https://eu.example.com, token: ${EU_KEY} }]
  taskGraphs:
    dir: .mcp-gateway/task-graphs        # checkpoints (relative to the config file); omit = memory only
    maxRuns: 500                         # finished runs kept (oldest dropped)
    graphs:
      - id: onboard-customer
        concurrency: 4
        nodes:
          - id: account
            tool: crm/create_account
            args: { name: "{{input.name}}", idempotencyKey: "{{run.id}}-account" }
            compensate: { tool: crm/delete_account, args: { id: "{{self.structuredContent.id}}" } }
          - id: kyc
            remote: { gateway: eu-gateway, skill: kyc_check }   # agent task on another gateway (A2A message/send)
            args: { name: "{{input.name}}" }
            retry: { attempts: 4, backoffMs: 500, factor: 2, maxBackoffMs: 5000, jitter: true }
            timeoutMs: 30000
          - id: welcome
            needs: [account, kyc]
            tool: mail/send
            args: { to: "{{input.email}}", text: "Account {{nodes.account.structuredContent.id}} is ready" }
            onError: continue                # a failed welcome mail does not fail (or compensate) the run
        output: "{{nodes.account.structuredContent}}"
```

## Nodes

| Field | |
|---|---|
| `tool: server/tool` | Call a tool on this gateway through the full pipeline (policy, quotas, budgets, audit) as the client that started the run. |
| `remote: { gateway, skill }` | Send an A2A task to a remote of `features.a2aFederation`; the remote's allow-lists (`clients`, `skills`) apply. A remote task that ends `failed` / `rejected` / `canceled` fails the node. |
| `needs` | Node ids that must be settled first. Independent nodes run in parallel up to `concurrency`. |
| `if` | Path into the scope (`nodes.x.structuredContent.flag`); falsy skips the node. |
| `args` | Templates: `{{input.*}}`, `{{nodes.<id>.text | structuredContent | content}}`, `{{run.id}}`, `{{run.graph}}`. |
| `retry` | `attempts` (1–20), `backoffMs × factor^(n-1)` capped by `maxBackoffMs`; `jitter: true` = full jitter. |
| `timeoutMs` | Per attempt. |
| `onError` | `fail` (default: stop scheduling, compensate) or `continue`. |
| `compensate` | `{ tool, args }` run if the run later fails or is cancelled; `{{self.*}}` is this node's output. |

## Checkpoints, resume, compensation

- With `dir`, the run is written (write + rename) after every state change. On start, runs that were `running` or
  `compensating` are loaded as `interrupted`.
- `POST …/runs/:id/resume` continues a `failed`, `interrupted`, `cancelled`, `compensated` or `compensation_failed`
  run: succeeded nodes keep their checkpointed output and are **not** executed again; failed, pending, interrupted
  and compensated nodes run again. The definition the run started with is used, even if the config changed since.
- When a run fails (a node with `onError: fail` exhausts its retries) or is cancelled, the compensations of the nodes
  that succeeded run in **reverse completion order**. The run ends `compensated` (or `cancelled`), or
  `compensation_failed` with each failing compensation in `error` — those need a human.

**Delivery is at-least-once.** A node interrupted mid-call runs again on resume, and a retry after a timeout may
repeat a call the upstream did complete. Make node tools idempotent (pass `{{run.id}}` as an idempotency key).

## Admin API (operators)

| Method | Path | |
|---|---|---|
| `GET` | `/api/v1/admin/task-graphs` | Graphs (layers, remote and compensable nodes), runs in flight |
| `POST` | `/api/v1/admin/task-graphs/run` | `{ graph, input?, wait? }` → `202 { runId }`, or the finished run with `wait: true` |
| `GET` | `/api/v1/admin/task-graphs/runs?status=` | Run summaries, newest first |
| `GET` | `/api/v1/admin/task-graphs/runs/:id` | One run: per-node status, attempts, outputs, errors |
| `POST` | `/api/v1/admin/task-graphs/runs/:id/resume` | `{ wait? }`; `409` for a run in flight or already succeeded |
| `POST` | `/api/v1/admin/task-graphs/runs/:id/cancel` | Stop scheduling, compensate, answer with the final status |

## Limits

- One gateway process owns a run; there is no distributed lock. Do not point two replicas at the same `dir`.
- Remote nodes use A2A `message/send` and treat a `completed` / `working` / `submitted` task as success; long-running
  remote tasks are not polled to completion.
