# Workflow engine (6.2)

> **Deprecated in 10.9, removed in 11.0.** Use [task graphs](task-graphs.md) (`features.taskGraphs`, 10.7):
> `mcp-gateway migrate --to 11` converts each workflow into a task graph with the same nodes. See
> [Migrating to 11.0](migrating-to-v11.md).

A workflow is a DAG of tool calls that runs inside the gateway. Each node lists the nodes it `needs`; every node whose
dependencies have settled starts immediately, up to `concurrency` at a time.

```yaml
features:
  workflows:
    - id: enrich-lead
      concurrency: 4
      nodes:
        - {id: company, tool: crm/lookup, args: {domain: "{{input.domain}}"}}
        - {id: news, tool: search/web, args: {q: "{{input.domain}} funding"}, retry: {attempts: 3, backoffMs: 200}}
        - id: score
          tool: llm/score
          needs: [company, news]
          args: {company: "{{nodes.company.text}}", news: "{{nodes.news.text}}"}
        - {id: notify, tool: slack/post, needs: [score], if: "nodes.score.structuredContent.hot", onError: continue}
      output: "{{nodes.score.structuredContent}}"
```

| Node field | Meaning |
|------------|---------|
| `tool` | `server/tool` to call (through policy, quotas, audit; client id `workflow:<id>`) |
| `args` | Template object: `{{input.*}}`, `{{nodes.<id>.text}}`, `{{nodes.<id>.structuredContent.*}}` |
| `needs` | Node ids that must settle first |
| `if` | Path that must be truthy, otherwise the node is `skipped` |
| `retry` | `{ attempts, backoffMs }` — exponential backoff (`backoffMs · 2^(n-1)`) |
| `onError` | `fail` (default: the run fails, remaining nodes are skipped) or `continue` |

A node whose dependency failed or was skipped is skipped. Config validation rejects unknown `needs`, duplicate ids and
cycles.

## Runs

`POST /api/v1/admin/workflows/run` with `{ workflow, input, wait }` returns `202 { runId }`; poll
`GET /api/v1/admin/workflows/runs/:id`, or pass `wait: true` to get the finished run. The last 200 runs are kept in
memory. `GET /api/v1/admin/workflows` shows each workflow's execution layers.

Workflows vs chains: chains (4.2) are ordered pipelines exposed as MCP tools; workflows are graphs with retries and
async runs for operators and back-office automation.
