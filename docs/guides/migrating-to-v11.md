# Migrating to 11.0

11.0 is the next breaking release after the 10.x LTS line. It ships **config schema v11** and a **lazy modular
kernel**: feature modules are mounted only when their `features.*` section is configured. A config that **10.9**
loads without deprecation warnings runs on 11.0 unchanged.

10.x stays supported as LTS (active support until 2027-10-31, security fixes until 2028-10-31 — see
[SECURITY.md](../../SECURITY.md)); there is no deadline to move.

## Checklist

1. Upgrade to 10.9 and run `mcp-gateway validate` — it lists the config deprecations (also at startup and at
   `GET /api/v1/admin/deprecations`).
2. `npx @winstonsayno/mcp-gateway@10.9 migrate --write` — rewrites the config to **schema v11** (`--to 11` is the
   default since 10.9; comments are kept, a `.bak` copy is written; `--check` exits 3 in CI when a file still needs
   migrating).
3. If you call feature admin APIs of modules you have **not** configured (for example to read an empty status), add
   `kernel: { modules: eager }` — or configure the section.
4. If you used workflows: switch API calls from `/api/v1/admin/workflows/*` to `/api/v1/admin/task-graphs/*` and
   adjust policy rules that matched the `workflow:*` client (see below).
5. Run the new version against the migrated file in staging, then upgrade.

## What changes

| 10.x | 11.0 | `migrate --to 11` |
|------|------|-------------------|
| `version: 10` (or no `version`) | `version: 11` — 11.0 refuses `version: 10` with a message naming `migrate --to 11`; a file without `version` is read as v11 | ✓ |
| every feature module mounted (eager) | only configured modules mounted (lazy); `kernel: { modules: eager }` restores eager | note printed |
| `features.workflows` (6.2) | removed — use `features.taskGraphs` (10.7) | ✓ (each workflow becomes a task graph) |
| `/api/v1/admin/workflows`, `/list`, `/run` | removed — `/api/v1/admin/task-graphs`, `/task-graphs/run` | — |

```yaml
# 10.x                                  # 11.0
version: 10                             version: 11
features:                               features:
  workflows:                              taskGraphs:
    - id: enrich                            graphs:
      nodes:                                  - id: enrich
        - { id: a, tool: crm/lookup }           nodes:
                                                  - { id: a, tool: crm/lookup }
```

### Lazy modules (`kernel.modules`)

| Mode | Default on | Behaviour |
|------|-----------|-----------|
| `lazy` | schema v11 | A feature module (routes under `/api/v1/admin/<id>` and `/api/v1/features/<id>`, timers, call hooks) is mounted only while one of its `features.*` sections is configured. Unconfigured modules answer `404` with a message naming the section. Adding a section with a hot reload mounts the module; removing it turns the routes off again. |
| `eager` | schema v10 (10.9) | Every module is mounted at start, as in 10.x (unconfigured modules answer `400 not configured`). |

Modules that have no config section (`kernel`, `conformance`, `k8s`, `terraform`, `policy-sim`) and call hooks
registered by plugins are always active. `GET /api/v1/admin/features` shows the mode (`modules`) and each module's
`active` flag.

### Workflows → task graphs

`migrate --to 11` converts each workflow into a task graph with the same `id`, `concurrency`, `nodes` (`needs`,
`args`, `if`, `onError`) and `output`. Node `retry: { attempts, backoffMs }` becomes
`retry: { attempts, backoffMs, factor: 2, maxBackoffMs: 3600000 }` (the same doubling backoff). A task graph that
already has the workflow's id is left alone and a note asks you to merge by hand. Comments inside the `workflows`
section are not carried over.

Behavioural differences:

- Run: `POST /api/v1/admin/task-graphs/run` with `{ "graph": "<id>", "input": {…}, "wait": true }` (was
  `/admin/workflows/run` with `{ "workflow": "<id>", … }`). Runs are durable when `taskGraphs.dir` is set and can be
  resumed and compensated.
- Identity: task-graph calls run as the client that started the run; workflows called tools as `workflow:<id>`.
  Policy rules, quotas or budgets that matched `workflow:*` must be rewritten.

## Deprecations in 10.9 (removed in 11.0)

| id | Removed in | Replacement |
|----|-----------|-------------|
| `config-schema-v10` | 11.0.0 | `version: 11` (`migrate --to 11`) |
| `features-workflows` | 11.0.0 | `features.taskGraphs` (`migrate --to 11`) |

## Other changes

- `mcp-gateway init` and the desktop config write `version: 11` (since 10.9).
- Data planes receive the schema version of the control plane's file (10 or 11 in 10.9; always 11 in 11.0).
- Embedders: `GatewayConfig.version` is `10 | 11` in 10.9 and `11` in 11.0; the new `GatewayConfig.kernel` holds
  `modules`. The workflow exports (`runWorkflow`, `WorkflowConfig`, …) are removed in 11.0.
