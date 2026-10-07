# Bridges: OpenAI-compatible tools proxy and A2A

mcp-gateway can expose its aggregated MCP tools to clients that do not speak MCP.

Every tool call made through a bridge goes through the same checks as `POST /api/v1/tools/call`:
authentication, key scopes, tenants, policy (deny / approval), quotas, caching and the output filter.

## OpenAI-compatible tools proxy

```yaml
openai:
  path: /openai/v1          # default; restart required to change
  injectTools: true         # add gateway tools to chat/completions requests
  maxToolRounds: 5          # gateway tool-call rounds per request
  upstream:                 # optional: only needed for /chat/completions
    baseUrl: https://api.openai.com/v1
    apiKey: ${OPENAI_API_KEY}
    timeoutMs: 120000
```

| Endpoint | What it does |
|----------|--------------|
| `GET  /openai/v1/tools` | The caller's tools as OpenAI function tools, plus a `mapping` from function name to `{ server, tool }` |
| `POST /openai/v1/tool_calls` | Body `{ "tool_calls": [...] }` or `{ "message": <assistant message> }` → `{ "messages": [{ "role": "tool", "tool_call_id", "content" }] }` |
| `POST /openai/v1/chat/completions` | Forwards to `upstream`, injects the gateway tools, executes gateway tool calls and loops until the model answers |

Notes:

- Tools you send yourself in `tools` are kept; if the model calls one of them, the response is returned to you
  untouched so you can run it.
- The final response carries `x_mcp_gateway: { toolRounds, toolCallsExecuted }`.
- `stream: true` is forwarded as is (no gateway tool loop).
- Without `upstream`, `chat/completions` answers `501`.

```bash
curl -s localhost:3000/openai/v1/chat/completions -H 'authorization: Bearer $KEY' \
  -H 'content-type: application/json' \
  -d '{"model":"gpt-4o-mini","messages":[{"role":"user","content":"List my GitHub issues"}]}'
```

## A2A (Agent2Agent) bridge

```yaml
a2a:
  enabled: true
  path: /a2a                       # JSON-RPC endpoint
  url: https://gateway.example.com # advertised base URL (default: from the request)
  name: my-tools
  description: Internal tools as an A2A agent
  provider: { organization: Acme, url: https://acme.example }
  public: false                    # serve the card without auth
  taskRetentionSeconds: 600
```

- `GET /.well-known/agent-card.json`: the Agent Card (protocol `0.3.0`), one skill
  per tool the caller can see. When auth is on the card advertises a bearer security scheme.
- `POST /a2a` JSON-RPC 2.0: `message/send`, `tasks/get` (`tasks/cancel` returns an error: tasks complete
  synchronously).

Select a skill with a data part:

```json
{
  "jsonrpc": "2.0", "id": 1, "method": "message/send",
  "params": { "message": { "kind": "message", "role": "user", "messageId": "m1",
    "parts": [{ "kind": "data", "data": { "skill": "github__list_issues", "arguments": { "repo": "acme/api" } } }] } }
}
```

The result is a Task: `completed` with an artifact holding the tool result (text + data parts), `failed` on tool
errors, or `rejected` for unknown skills, policy denials (403) and quota limits (429).
