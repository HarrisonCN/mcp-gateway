#!/usr/bin/env node
// Line-delimited JSON-RPC MCP server that asks its client for sampling / elicitation / roots (3.1 tests).
// Tools: ask_llm, ask_user, list_roots, client_caps, roots_changed.
import { createInterface } from 'readline';

const send = (m) => process.stdout.write(JSON.stringify(m) + '\n');
let clientCaps = {};
let rootsChanged = 0;
let seq = 0;
const waiting = new Map();

// NO_TOKEN=1: do not echo the progress token (forces caller routing by elimination); ASK_DELAY_MS delays the ask.
const noToken = !!process.env.NO_TOKEN;
const askDelay = Number(process.env.ASK_DELAY_MS ?? 0);
function ask(method, params, progressToken) {
  const id = `srv-${++seq}`;
  const p = progressToken !== undefined && !noToken ? { ...params, _meta: { progressToken } } : params;
  setTimeout(() => send({ jsonrpc: '2.0', id, method, params: p }), askDelay);
  return new Promise((resolve) => waiting.set(id, resolve));
}

const text = (id, t) => send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: typeof t === 'string' ? t : JSON.stringify(t) }] } });

createInterface({ input: process.stdin }).on('line', async (line) => {
  const msg = JSON.parse(line);
  if (msg.method === undefined) {
    // response to one of our requests
    const done = waiting.get(msg.id);
    waiting.delete(msg.id);
    done?.(msg);
    return;
  }
  if (msg.id === undefined) {
    if (msg.method === 'notifications/roots/list_changed') rootsChanged++;
    return;
  }
  switch (msg.method) {
    case 'initialize':
      clientCaps = msg.params?.capabilities ?? {};
      return send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'passthrough', version: '1' } } });
    case 'tools/list':
      return send({ jsonrpc: '2.0', id: msg.id, result: { tools: ['ask_llm', 'ask_user', 'list_roots', 'client_caps', 'roots_changed'].map((name) => ({ name, description: name, inputSchema: { type: 'object' } })) } });
    case 'ping':
      return send({ jsonrpc: '2.0', id: msg.id, result: {} });
    case 'tools/call': {
      const name = msg.params.name;
      const token = msg.params._meta?.progressToken;
      if (name === 'client_caps') return text(msg.id, clientCaps);
      if (name === 'roots_changed') return text(msg.id, String(rootsChanged));
      if (name === 'ask_llm') {
        const r = await ask('sampling/createMessage', { messages: [{ role: 'user', content: { type: 'text', text: msg.params.arguments?.prompt ?? 'hi' } }], maxTokens: 50 }, token);
        return r.error ? text(msg.id, { error: r.error }) : text(msg.id, r.result);
      }
      if (name === 'ask_user') {
        const r = await ask('elicitation/create', { message: 'Your name?', requestedSchema: { type: 'object', properties: { name: { type: 'string' } } } }, token);
        return r.error ? text(msg.id, { error: r.error }) : text(msg.id, r.result);
      }
      if (name === 'list_roots') {
        const r = await ask('roots/list', {}, token);
        return r.error ? text(msg.id, { error: r.error }) : text(msg.id, r.result);
      }
      return send({ jsonrpc: '2.0', id: msg.id, error: { code: -32602, message: 'unknown tool' } });
    }
    default:
      return send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'unknown' } });
  }
});
