#!/usr/bin/env node
// Line-delimited JSON-RPC MCP server for the reliability harness (13.3.0).
// Tools: echo, slow ({ms}), fail, priced, cached. SIGUSR1 toggles "stall" (requests are read and never answered),
// SIGUSR2 toggles "slow" (every call waits SLOW_MS, default 200). Kill it with SIGKILL to simulate a crash.
import { createInterface } from 'node:readline';

let stall = false;
let slow = false;
const slowMs = Number(process.env.SLOW_MS ?? 200);
const tag = process.env.UPSTREAM_TAG ?? 'stdio';
process.on('SIGUSR1', () => (stall = !stall));
process.on('SIGUSR2', () => (slow = !slow));
process.on('SIGTERM', () => process.exit(0));

const send = (m) => process.stdout.write(JSON.stringify(m) + '\n');
const TOOLS = ['echo', 'slow', 'fail', 'priced', 'cached'].map((name) => ({ name, description: name, inputSchema: { type: 'object' } }));
const result = (name, args) => {
  const text = JSON.stringify({ tool: name, args: args ?? {}, upstream: tag, pid: process.pid });
  return name === 'priced' ? { content: [{ type: 'text', text }], usage: { input_tokens: 10, output_tokens: 10 } } : { content: [{ type: 'text', text }] };
};

createInterface({ input: process.stdin }).on('line', (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  if (msg.id === undefined || msg.id === null) return;
  switch (msg.method) {
    case 'initialize':
      return send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: `up-${tag}`, version: '1' } } });
    case 'tools/list':
      return send({ jsonrpc: '2.0', id: msg.id, result: { tools: TOOLS } });
    case 'ping':
      if (stall) return;
      return send({ jsonrpc: '2.0', id: msg.id, result: {} });
    case 'tools/call': {
      if (stall) return;
      const { name, arguments: args } = msg.params ?? {};
      if (name === 'fail') return send({ jsonrpc: '2.0', id: msg.id, error: { code: -32000, message: 'tool failed' } });
      const delay = slow ? slowMs : name === 'slow' ? Number(args?.ms ?? 50) : 0;
      const reply = () => send({ jsonrpc: '2.0', id: msg.id, result: result(name, args) });
      return delay > 0 ? void setTimeout(reply, delay) : reply();
    }
    default:
      return send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'unknown method' } });
  }
});
