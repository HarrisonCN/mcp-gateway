# Edge runtimes: Cloudflare Workers, Deno, Bun

`@winstonsayno/mcp-gateway/edge` is a Fetch-API build of the gateway's HTTP surface with no Node dependencies. It
fronts **remote** MCP servers (Streamable HTTP) — stdio servers, the dashboard, audit log, plugins and the other
stateful features stay in the Node gateway.

| Feature | Node gateway | Edge |
|---|:-:|:-:|
| `/mcp` (initialize, ping, tools/list, tools/call, batches) | ✓ | ✓ (stateless JSON replies) |
| `GET /api/v1/health`, `GET /api/v1/tools`, `POST /api/v1/tools/call` | ✓ | ✓ |
| API keys (plain / `sha256:`), per-server `tools` allow / deny, CORS | ✓ | ✓ |
| stdio / WebSocket upstreams, resources, prompts, SSE streams, dashboard, policy, cache, quotas, tenants | ✓ | — |

```ts
import { createEdgeGateway } from '@winstonsayno/mcp-gateway/edge';

const gw = createEdgeGateway({
  servers: [{ id: 'github', url: 'https://api.githubcopilot.com/mcp/', headers: { Authorization: `Bearer ${token}` } }],
  apiKeys: ['sha256:…'],
  toolNaming: 'auto',             // or 'prefix' → <server>__<tool>
});
// any runtime: (request: Request) => Promise<Response>
export default { fetch: (req: Request) => gw.fetch(req) };
```

## Adapters

| Runtime | |
|---|---|
| Cloudflare Workers | `export default workersHandler()` — config from bindings (`configFromEnv`); see [`examples/edge`](../../examples/edge) |
| Deno | `serveDeno(config, { port: 8000 })` |
| Bun | `serveBun(config, { port: 3000 })` |
| Node | `await serveNode(config, { port })` — run an edge config locally |

`configFromEnv(env)` reads `MCP_GATEWAY_SERVERS` (JSON array of `{ id, url, headers?, tools?, timeoutMs? }`),
`MCP_GATEWAY_API_KEYS` (comma separated), `MCP_GATEWAY_TOOL_NAMING` and `MCP_GATEWAY_CORS_ORIGINS`.

Upstream sessions (`Mcp-Session-Id`) are kept per isolate and re-initialized once when the upstream answers `404`;
tool lists are cached for 30 s.

## Offline / edge sync (4.8)

An edge deployment can take its configuration from a Node gateway (the **control plane**) and keep working when
either the control plane or an upstream is unreachable.

```ts
import { createEdgeGateway } from '@winstonsayno/mcp-gateway/edge';

const gw = createEdgeGateway({
  servers: [],                                   // local servers / headers still win over the snapshot
  sync: { controlPlane: 'https://gw.example.com', apiKey: env.CONTROL_KEY, edgeId: 'cf-hkg', store: env.MCP_GATEWAY_KV },
  offline: { queueTools: ['notify_*', 'github__create_issue'] },
  syncIntervalMs: 60_000,                        // background sync on requests (0 = only explicit sync())
});
export default {
  fetch: (req: Request, _env: unknown, ctx: ExecutionContext) => gw.fetch(req, (p) => ctx.waitUntil(p)),
  scheduled: () => gw.sync(),                    // Cron Trigger: pull config, replay queue, push usage
};
```

| Piece | Behaviour |
|---|---|
| **Config snapshot** | `GET /api/v1/admin/edge/snapshot` on the control plane: enabled `streamable-http` servers (url, tool filters, timeout, known tools), unscoped API keys as `sha256:` digests, tool naming, CORS. `ETag` / `If-None-Match`. The last good snapshot is kept in the store, so a cold isolate boots without the control plane. |
| **Secrets** | Upstream `headers` are only in the snapshot with `sync.includeSecrets: true` (`?secrets=true`), which the control plane allows only with `admin.configApi: true`. Otherwise set them on the edge (`servers[].headers` merge over the snapshot). |
| **Offline tool lists** | When `tools/list` to an upstream fails, the edge serves its last list, or the snapshot's catalog. |
| **Offline queue** | Calls to tools matching `offline.queueTools` (exposed name or `<server>__<tool>`) are queued when the upstream is unreachable or answers 5xx: REST answers `202` with `queued`, MCP returns a result with `structuredContent: { queued: true, id }`. `sync()` replays them oldest-first; calls the upstream rejects are dropped (and reported). Only queue idempotent / fire-and-forget tools. |
| **Usage outbox** | Every call (live, queued, replayed) is recorded and pushed to `POST /api/v1/admin/edge/sync`; it appears in the control plane's metrics as client `edge:<edgeId>`. Events stay in the outbox until accepted. |
| **Status** | Edge: `GET /api/v1/edge/status` (snapshot ETag, last sync report, outbox / queue sizes, offline servers), `POST /api/v1/edge/sync`. Control plane: `GET /api/v1/admin/edge/nodes`. |

The store is any `{ get, put, delete }` string KV — a Cloudflare KV namespace works as-is; `memoryStore()` is the
default (per isolate). With `configFromEnv`, set `MCP_GATEWAY_CONTROL_PLANE`, `MCP_GATEWAY_CONTROL_KEY`,
`MCP_GATEWAY_EDGE_ID`, `MCP_GATEWAY_QUEUE_TOOLS`, `MCP_GATEWAY_SYNC_INTERVAL_MS` and bind KV as `MCP_GATEWAY_KV`;
`workersHandler()` then also exports `scheduled`.

## Managed edge fleet (5.3)

List your edges in the Node gateway's config to manage them from the control plane:

```yaml
edgeFleet:
  pushTimeoutMs: 10000        # per-edge push timeout
  offlineAfterMs: 900000      # not seen for 15 min → offline
  nodes:
    - { id: cf-hkg, url: https://edge-hkg.example.workers.dev, apiKey: ${EDGE_KEY}, labels: { ring: canary } }
    - { id: deno-fra, url: https://fra.example.deno.dev, apiKey: ${EDGE_KEY}, labels: { ring: stable } }
```

`id` must match the edge's `sync.edgeId`. `GET /api/v1/admin/edge-fleet` merges configured and seen edges and
classifies each one: `in-sync` (applied the current snapshot), `stale`, `never-synced`, `offline`, or `unmanaged`
(syncs but is not listed). `POST /api/v1/admin/edge-fleet/push` calls each selected edge's
`POST /api/v1/edge/sync` so it pulls the new snapshot immediately instead of on its next interval:

```bash
# canary ring first, then everything still drifted
curl -X POST -H "Authorization: Bearer $OP" -H 'content-type: application/json' $GW/api/v1/admin/edge-fleet/push -d '{"labels":{"ring":"canary"}}'
curl -X POST -H "Authorization: Bearer $OP" -H 'content-type: application/json' $GW/api/v1/admin/edge-fleet/push -d '{"onlyDrifted":true}'
```

The dashboard's Operations view shows an **Edge nodes** card with each edge's drift and a *Push config* button
(pushes to drifted edges).
