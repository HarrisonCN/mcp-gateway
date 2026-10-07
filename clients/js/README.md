# @winstonsayno/mcp-gateway-client

Typed, dependency-free TypeScript client for [mcp-gateway](https://github.com/HarrisonCN/mcp-gateway).
Uses only `fetch`, so it runs in browsers, Node 18+, Deno, Bun, Cloudflare Workers and React Native.

> Not published to npm yet — install from the repo (`npm install ./clients/js`) or copy `src/`.

```ts
import { GatewayClient } from '@winstonsayno/mcp-gateway-client';

const gw = new GatewayClient({ baseUrl: 'http://localhost:4000', apiKey: process.env.GATEWAY_KEY });

await gw.health();                       // { status: 'ok', servers: {...} }
const tools = await gw.listTools();      // every tool this key may use
const r = await gw.callTool('read_file', { path: '/tmp/a.txt' });   // auto-routed
await gw.callTool('echo', { msg: 'hi' }, { server: 'local' });      // explicit server
```

## Use with an LLM

`toolSchemas()` returns tools in the provider's format plus a `mapping` from LLM tool name to
gateway server/tool; `callLlmTool()` executes what the model asked for.

```ts
// OpenAI Chat Completions
const schemas = await gw.toolSchemas('openai');            // or 'openai-responses' | 'anthropic'
const completion = await openai.chat.completions.create({ model, messages, tools: schemas.tools });
for (const call of completion.choices[0].message.tool_calls ?? []) {
  const out = await gw.callLlmTool(schemas, call.function.name, call.function.arguments);
  messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(out.result) });
}

// Anthropic Messages
const schemas = await gw.toolSchemas('anthropic');
const msg = await anthropic.messages.create({ model, max_tokens: 1024, messages, tools: schemas.tools });
for (const block of msg.content) {
  if (block.type === 'tool_use') await gw.callLlmTool(schemas, block.name, block.input);
}
```

## MCP over `/mcp`

The gateway is also a standard MCP server. For a full client use `@modelcontextprotocol/sdk`;
for simple request/response use the built-in helper:

```ts
import { GatewayClient, connectMcp } from '@winstonsayno/mcp-gateway-client';

const mcp = await connectMcp(new GatewayClient({ baseUrl, apiKey }));
const tools = await mcp.listTools();     // follows pagination
const result = await mcp.callTool('github__create_issue', { title: 'Hi' }, { signal });  // abort → notifications/cancelled
await mcp.close();
```

## API

| Method | Endpoint |
|---|---|
| `health()` | `GET /api/v1/health` (207 "degraded" resolves) |
| `ready(min?)` | `GET /api/v1/health/ready` (resolves for 200 and 503 with `ready: boolean`) |
| `metrics(windowMs?)` | `GET /api/v1/metrics` (JSON) |
| `servers()` / `server(id)` | `GET /api/v1/servers[/:id]` |
| `reconnect(id)` | `POST /api/v1/servers/:id/reconnect` |
| `listTools({ server?, tag? })` | `GET /api/v1/tools` |
| `toolSchemas(format, filter?)` | `GET /api/v1/tools?format=openai\|openai-responses\|anthropic` |
| `callTool(tool, args?, { server?, signal?, timeoutMs? })` | `POST /api/v1/tools/call` |
| `callLlmTool(schemas, name, args)` | resolves `schemas.mapping[name]`, then `callTool` (args may be a JSON string) |
| `requests(limit?)` | `GET /api/v1/requests` (records only) |
| `history({ server?, tool?, client?, success?, via?, kind?, since?, until?, cursor?, limit? })` | `GET /api/v1/requests` with filters; returns `{ requests, nextCursor, source }` |
| `listResources()` / `listResourceTemplates()` / `readResource(uri, { server? })` | `/api/v1/resources…` (gateway ≥ 0.8) |
| `listPrompts()` / `getPrompt(name, args, { server? })` | `/api/v1/prompts…` (gateway ≥ 0.8) |
| `approvals()` / `approve(id, reason?)` / `deny(id, reason?)` | `/api/v1/approvals…` (gateway ≥ 1.6, operator keys) |

Options: `baseUrl`, `apiKey` or `token` (string or async function, sent as `Authorization: Bearer`),
`headers`, `fetch` (custom implementation), `timeoutMs` (default 60 000; 0 = none).

Errors: non-2xx responses throw `GatewayError` with `status`, the parsed `body` and `retryAfter`
(seconds, for 429 / 503), plus `code` (gateway error code) and `isPolicyError` (`-32003` denied by policy,
`-32004` approval rejected, `-32005` output blocked). Network errors and timeouts have `status: 0`. MCP JSON-RPC errors throw `McpError` with `code`.

## Development

```bash
cd clients/js
npm ci
npm test        # unit tests against a fake gateway
npm run build   # → dist/
```

The root test suite also runs this client against a real gateway (`test/client-js.test.ts`).
