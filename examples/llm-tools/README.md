# Tools behind mcp-gateway, called by any LLM

`agent.mjs` is a ~60-line tool-calling loop: it fetches the tools a gateway key may use as OpenAI function tools
(`GET /api/v1/tools?format=openai`), sends them to an OpenAI-compatible Chat Completions API, and executes each tool
call through the gateway (`POST /api/v1/tools/call`) until the model answers.

```bash
cd examples/llm-tools
npm install openai
export GATEWAY_KEY=$(npx @winstonsayno/mcp-gateway gen-key | awk '/^key:/{print $2}')
MCP_GATEWAY_API_KEYS=$GATEWAY_KEY npx @winstonsayno/mcp-gateway start -c mcp-gateway.yml &

# OpenAI
LLM_API_KEY=$OPENAI_API_KEY LLM_MODEL=<model> node agent.mjs "List the files in /tmp"
# DeepSeek (OpenAI-compatible)
LLM_API_KEY=$DEEPSEEK_API_KEY LLM_BASE_URL=https://api.deepseek.com LLM_MODEL=deepseek-flash node agent.mjs "List the files in /tmp"
# xAI Grok (OpenAI-compatible)
LLM_API_KEY=$XAI_API_KEY LLM_BASE_URL=https://api.x.ai/v1 LLM_MODEL=grok-4.7 node agent.mjs "List the files in /tmp"
```

Model names come from each provider's documentation at the time of writing (DeepSeek
[quick start](https://api-docs.deepseek.com/) / [tool calls](https://api-docs.deepseek.com/guides/tool_calls),
xAI [function calling](https://docs.x.ai/docs/guides/function-calling)) and change often — check them. xAI documents
Chat Completions as its legacy API; for its Responses API use `?format=openai-responses` (entries shaped
`{ type: "function", name, description, parameters }`).

**Anthropic Claude** — same idea with the Messages API:

```js
const { tools, mapping } = await (await gw('/tools?format=anthropic')).json();   // [{ name, description, input_schema }]
const msg = await anthropic.messages.create({ model, max_tokens: 1024, messages, tools });
for (const block of msg.content) {
  if (block.type !== 'tool_use') continue;
  const { server, tool } = mapping[block.name];
  const out = await (await gw('/tools/call', { method: 'POST', body: JSON.stringify({ server, tool, arguments: block.input }) })).json();
  // append { role: 'user', content: [{ type: 'tool_result', tool_use_id: block.id, content: JSON.stringify(out.result) }] }
}
```

What was tested: the gateway side (tool listing in all three formats, tool execution, auth) and this loop against a
local OpenAI-compatible mock with the official `openai` npm SDK. The provider endpoints themselves were checked
against their documentation only, not called. No model vendor endorses or partners with this project.
