# Durable task execution (14.4)

Since 14.4 a [task graph](task-graphs.md) run can be **durable**: its state is persisted after
every step, it continues from its last committed step after a gateway restart (or on another gateway when its
executor dies), duplicate submissions and repeated calls are answered from the stored result instead of being
executed again, failed runs wait in a **failure queue (DLQ)** with a retry policy, runs can **pause for human
approval** across restarts, and saga **compensations** run exactly once.

Durable execution is additive on the 10.7 engine and opt-in: without `durable`, task graphs behave exactly as in
14.3 (file checkpoints, runs left in flight are listed `interrupted`, manual resume).

```yaml
store:
  backend: redis                 # shared by every gateway — or sqlite for one host
  redis: { url: redis://redis:6379 }
features:
  taskGraphs:
    durable:
      backend: auto              # auto (default): the gateway store, else `dir`, else memory | store | dir | memory
      resumeOnStart: true        # continue runs left in flight (default true)
      leaseMs: 15000             # heartbeat lease of the executing gateway (default 15000)
      sweepIntervalMs: 2000      # takeover / approval-timeout / DLQ-retry scan (default 2000)
      idempotencyTtlSeconds: 86400   # how long a submission key is remembered (default 1 day)
      dlq:
        enabled: true            # park failed runs (default true); false = compensate at once (10.7)
        retry: { attempts: 3, backoffMs: 30000, factor: 2, maxBackoffMs: 3600000, jitter: false }
    graphs:
      - id: wire-transfer
        clients: true            # any authenticated client may start it (client routes below)
        nodes:
          - id: reserve
            tool: ledger/reserve
            args: { account: "{{input.account}}", amount: "{{input.amount}}" }
            idempotencyArg: requestId        # the upstream receives requestId = "<runId>:reserve"
            compensate: { tool: ledger/release, args: { id: "{{self.structuredContent.id}}" }, idempotencyArg: requestId }
          - id: approve-large
            tool: ledger/noop
            needs: [reserve]
            approval: { approvers: ["key:treasury-*"], required: 2, timeoutSeconds: 86400 }
          - id: send
            tool: bank/transfer            # not repeat-safe: never executed twice automatically
            needs: [approve-large]
            args: { to: "{{input.iban}}", amount: "{{input.amount}}" }
```

## Where state lives

| `backend` | Persistence | Several gateways |
|---|---|---|
| `store` (the gateway's `store.backend`) | redis / sqlite / eventlog | redis: yes (cluster-wide leases, keys, DLQ); sqlite: processes on one host |
| `dir` (`taskGraphs.dir`) | files: runs stay `<dir>/<runId>.json`, the rest under `<dir>/.durable/` (files 0600, directories 0700) | processes on one host (claims are O_EXCL files) |
| `memory` | this process only | no — nothing survives a restart |

`auto` picks the gateway store when it is not `memory`, else `dir` when set, else memory. Keys are prefixed
`task-graphs:` (after `store.redis.keyPrefix`).

## Resume after a restart

Every change of a run (node started, output, failure, approval, compensation) is written before the engine moves on.
An executing gateway holds a **heartbeat lease** (`leaseMs`, renewed every `leaseMs / 3`) and a **fencing epoch** — an
atomic per-run counter incremented by every claim. When a gateway stops gracefully it releases its leases, so the
next start (or a peer) resumes at once; after a crash or `kill -9` the lease lapses after `leaseMs`.

On start (`resumeOnStart`) and on every sweep, a run left `running` / `compensating` without a live lease is taken
over by exactly one gateway (the one whose epoch increment is current; a stale executor notices at its next write
and stops). The run continues from its **last committed step**: nodes that succeeded keep their outputs and are not
executed again; a run that was compensating continues compensating. A resume waits (up to 60 s after start) until
the upstream servers its remaining nodes need are connected. The run's audit trail records `resume` (and
`takeover` when another gateway's lease lapsed).

With `resumeOnStart: false` such runs become `interrupted` (14.3 behaviour) and continue on
`POST /api/v1/admin/task-graphs/runs/:id/resume`.

## Idempotency keys

**Per task.** Send `Idempotency-Key: <key>` (or `"idempotencyKey"` in the body) with `POST …/run`. Keys are scoped to
the submitting client and remembered for `idempotencyTtlSeconds`:

- the same key with the same graph and input returns the **same run** (`200 {"runId", "duplicate": true}`;
  with `"wait": true` the run's result and `Idempotent-Replayed: true`) — also concurrently, also on another gateway
  sharing the store, also after a restart;
- the same key with a different graph or input is `409 Conflict`;
- another client using the same key gets its own run.

Idempotency keys need `durable` (without it they are refused with 400 rather than ignored).

**Per tool call.** Every node call has a stable key `<runId>:<nodeId>` (compensations `<runId>:<nodeId>:compensate`).
Around each call the executor writes an **intent** (the call is about to run), then the **result** (commit):

| Crash point | On resume |
|---|---|
| before the call | the call runs |
| after the commit | the committed result is reused — no call |
| **between the call and its commit** (or the call timed out) | the outcome is unknown: a node marked `idempotent: true` or with `idempotencyArg` runs again **with the same key**; any other node is **never executed again automatically** — it becomes `outcome_unknown` and the run goes to the DLQ |

`idempotencyArg: <name>` sets that argument to the call's key, so an upstream that deduplicates (payment APIs,
`Idempotency-Key`-style request ids) turns a repeated call into a no-op. `idempotent: true` declares a call safe to
repeat as it is (reads, upserts).

## Failure queue (DLQ)

With `dlq.enabled` (default), a run whose node fails (after the node's own `retry` attempts) is **parked** as
`dead_letter` instead of compensating at once:

- **retryable failures** are re-run automatically with `dlq.retry` — `attempts` re-runs, exponential backoff
  `backoffMs × factor^(n-1)` capped by `maxBackoffMs`, optional full jitter. A re-run continues from the last committed
  step. When it succeeds the entry is `replayed`; when the retries are exhausted it is `exhausted` and waits for an
  operator;
- **unknown outcomes** (see above) are never retried automatically (`retryable: false`).

Compensations run only when the run is given up (discard) — retrying first and undoing last is the saga order.
Approval denials and timeouts are final: they compensate at once and never enter the DLQ.

| | |
|---|---|
| `GET /api/v1/admin/task-graphs/dlq?status=&runId=` | entries: `status` (`pending` · `replaying` · `exhausted` · `replayed` · `discarded`), `reason`, `error`, `retries` / `maxRetries`, `nextRetryAt`, `history` |
| `GET …/dlq/:id` | one entry with its run |
| `POST …/dlq/:id/replay` `{ force?, wait? }` | re-run now; nodes with an unknown outcome need `"force": true` (they may have run upstream — you decide they did not) |
| `POST …/dlq/:id/discard` `{ compensate?: true, wait? }` | give up: the compensations run (`compensate: false` leaves the run `failed`) |

The same from the command line:

```bash
mcp-gateway tasks dlq list --status exhausted --url http://gw:4000 --key "$MCP_GATEWAY_ADMIN_KEY"
mcp-gateway tasks dlq show dlq-3f2a…
mcp-gateway tasks dlq replay dlq-3f2a… --force
mcp-gateway tasks dlq discard dlq-3f2a…
mcp-gateway tasks runs --status awaiting_approval
mcp-gateway tasks approve 9c1e… --node approve-large --reason "checked with treasury"
```

## Approval resume

A node with `approval` pauses the run before it executes: the node is `awaiting_approval`, the run
`awaiting_approval`, and no lease is held — the paused run survives restarts and takes no resources. Approvers are
client-id globs; `required` approvals resume the run, one denial (or `timeoutSeconds` without enough approvals) fails
the node, and the run compensates. The requester can never decide on its own run, and every decision is audited
(the run's `audit` list and the audit log: `approve` / `deny` with the approver, `timeout` by
`system:approval-timeout`).

- Approvers: `GET /api/v1/features/task-graphs/approvals` (their inbox), `POST /api/v1/features/task-graphs/runs/:id/approve|deny` `{ node?, reason? }`.
- Operators: `POST /api/v1/admin/task-graphs/runs/:id/approve|deny` (override; audited with the operator's id).

When the run resumes, every node call is authorized as the submitting client **as it is now**: a key removed or
re-scoped while the run waited cannot act through it (the stored delegation chain, if any, still narrows).

## Compensation

Compensations (`compensate`) run in reverse completion order, once: a compensation that finished is not repeated
after a crash, and one in flight at a crash is treated like a node call — re-run with its key when it has
`idempotencyArg`, otherwise marked `compensation_failed` (outcome unknown) for an operator. Make compensations
idempotent; give them an `idempotencyArg` where the upstream supports one.

## Tenant isolation

- Client routes (`/api/v1/features/task-graphs`, graphs with `clients: true`): a client sees, cancels and waits on
  **its own runs only**; another client's run is `404`. `GET /` lists the graphs it may start.
- Each run records its owner: the client id and **every** tenant membership at submission (never only the first —
  see MGW-2026-015); operators filter with `GET /admin/task-graphs/runs?tenant=<id>` / `?client=<id>`.
- Node calls go through the full invoker pipeline as the submitting client, so per-call tenant decisions (acting
  tenant, credentials, budgets, quotas) are the same as for a direct call.
- Idempotency keys are namespaced per client; the DLQ and resume are operator-only.

## Run and node states

Run: `running` · `awaiting_approval` · `dead_letter` · `compensating` · `succeeded` · `failed` · `cancelled` ·
`compensated` · `compensation_failed` · `interrupted`. Node: `pending` · `running` · `awaiting_approval` ·
`succeeded` · `failed` · `outcome_unknown` · `skipped` · `compensated` · `compensation_failed`.

`GET /api/v1/admin/task-graphs` reports the durable backend, this gateway's instance id, and the runs it executes.
Each run carries `epoch` (fencing epoch), `executor` (instance holding the lease), `owner`, `idempotencyKey`,
`audit` and `dlq`.

## Metrics

| Metric | |
|---|---|
| `mcp_gateway_task_runs_total{status}` | runs that reached an outcome (incl. `dead_letter`) |
| `mcp_gateway_task_idempotent_hits_total{kind="run"\|"call"}` | duplicate submissions / calls answered from the stored result |
| `mcp_gateway_task_resumes_total{reason}` | `restart` · `takeover` · `approval` · `dlq` · `operator` |
| `mcp_gateway_task_takeovers_total`, `mcp_gateway_task_lease_lost_total` | lease takeovers; executors fenced out |
| `mcp_gateway_task_outcome_unknown_total` | calls left in doubt by a crash or timeout (not repeated) |
| `mcp_gateway_task_dlq_entries{status}`, `mcp_gateway_task_dlq_retries_total` | DLQ by status (as last seen by this gateway); automatic re-runs |
| `mcp_gateway_task_compensations_total{result}` | compensations by result |
| `mcp_gateway_task_awaiting_approval` | runs paused for approval |

## Limits

- Exactly-once holds for calls the gateway can see: an upstream that receives a call and loses it is not detectable.
  Unknown outcomes are surfaced, never guessed.
- `sqlite` and `dir` coordinate processes on one host only; use Redis for several hosts.
- The run index is not trimmed by `maxRuns` in durable mode; prune old runs with your store's tooling.
- Timeouts (`timeoutMs`) are treated as unknown outcomes for nodes that are not repeat-safe.
