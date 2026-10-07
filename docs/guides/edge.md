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
