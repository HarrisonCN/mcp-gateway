// Tool-calling loop: any OpenAI-compatible Chat Completions API + the tools behind mcp-gateway.
//
//   npm install openai
//   GATEWAY_KEY=<gateway key> LLM_API_KEY=<provider key> LLM_BASE_URL=<see below> LLM_MODEL=<model> \
//     node agent.mjs "List the files in /tmp"
//
// LLM_BASE_URL / LLM_MODEL (check the provider's docs for current model names):
//   OpenAI    https://api.openai.com/v1   (default)
//   DeepSeek  https://api.deepseek.com    e.g. deepseek-flash
//   xAI Grok  https://api.x.ai/v1         e.g. grok-4.7   (xAI documents Chat Completions as legacy; the gateway
//                                                          also serves ?format=openai-responses for the Responses API)
// Anthropic Claude uses ?format=anthropic with the Anthropic SDK — see README.md.
import OpenAI from 'openai';

const GATEWAY = process.env.GATEWAY_URL ?? 'http://127.0.0.1:4000';
const gwHeaders = { 'content-type': 'application/json', authorization: `Bearer ${process.env.GATEWAY_KEY ?? ''}` };
const llm = new OpenAI({ apiKey: process.env.LLM_API_KEY, baseURL: process.env.LLM_BASE_URL ?? 'https://api.openai.com/v1' });
const model = process.env.LLM_MODEL;
if (!model) throw new Error('Set LLM_MODEL');

// 1. The tools this gateway key may use, as OpenAI function tools, plus LLM name → { server, tool }.
const res = await fetch(`${GATEWAY}/api/v1/tools?format=openai`, { headers: gwHeaders });
if (!res.ok) throw new Error(`gateway: ${res.status} ${await res.text()}`);
const { tools, mapping } = await res.json();

// 2. Execute one tool call through the gateway (scopes, policy, rate limits and audit apply).
async function callTool(name, argsJson) {
  const target = mapping[name];
  if (!target) return JSON.stringify({ error: `unknown tool ${name}` });
  const r = await fetch(`${GATEWAY}/api/v1/tools/call`, {
    method: 'POST',
    headers: gwHeaders,
    body: JSON.stringify({ server: target.server, tool: target.tool, arguments: JSON.parse(argsJson || '{}') }),
  });
  const body = await r.json();
  if (!r.ok) return JSON.stringify({ error: body.message ?? body.error ?? r.status });
  const text = (body.result?.content ?? []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');
  return text || JSON.stringify(body.result);
}

// 3. Loop until the model answers without asking for tools.
const messages = [{ role: 'user', content: process.argv[2] ?? 'Which tools can you use? Try one.' }];
for (let round = 0; round < 8; round++) {
  const completion = await llm.chat.completions.create({ model, messages, tools: tools.length ? tools : undefined });
  const msg = completion.choices[0].message;
  messages.push(msg);
  if (!msg.tool_calls?.length) {
    console.log(msg.content);
    break;
  }
  for (const call of msg.tool_calls) {
    console.error(`→ ${call.function.name}(${call.function.arguments})`);
    messages.push({ role: 'tool', tool_call_id: call.id, content: await callTool(call.function.name, call.function.arguments) });
  }
}
