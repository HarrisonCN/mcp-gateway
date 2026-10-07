#!/usr/bin/env node
// Minimal line-delimited JSON-RPC MCP server used by the tests.
// Behaviour knobs via env: FAIL_INIT=1, TOOL_PAGES=n, SLOW_MS=n
import { createInterface } from 'readline';

const pages = Number(process.env.TOOL_PAGES ?? 1);
const slowMs = Number(process.env.SLOW_MS ?? 0);
const send = (m) => process.stdout.write(JSON.stringify(m) + '\n');

createInterface({ input: process.stdin }).on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.id === undefined) return; // notification
  switch (msg.method) {
    case 'initialize':
      if (process.env.FAIL_INIT) return send({ jsonrpc: '2.0', id: msg.id, error: { code: -1, message: 'nope' } });
      return send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'fake', version: '1' } } });
    case 'tools/list': {
      const page = Number(msg.params?.cursor ?? 0);
      const next = page + 1 < pages ? String(page + 1) : undefined;
      return send({ jsonrpc: '2.0', id: msg.id, result: { tools: [{ name: `echo${page || ''}`, description: 'echo' }], ...(next ? { nextCursor: next } : {}) } });
    }
    case 'tools/call': {
      const { name, arguments: args } = msg.params;
      if (name === 'crash') process.exit(3);
      if (name === 'unicode') {
        // write a multi-byte payload in two chunks split inside a character
        const buf = Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { text: '你好世界' } }) + '\n');
        process.stdout.write(buf.subarray(0, buf.indexOf(0xe4) + 1));
        setTimeout(() => process.stdout.write(buf.subarray(buf.indexOf(0xe4) + 1)), 20);
        return;
      }
      const delay = name === 'slow' ? slowMs : 0;
      // also send a server->client ping that reuses the same id
      if (name === 'ping-collide') send({ jsonrpc: '2.0', id: msg.id, method: 'ping' });
      setTimeout(() => send({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: JSON.stringify(args) }] } }), delay);
      return;
    }
    default:
      if (msg.result !== undefined || msg.error !== undefined) return; // reply to our ping
      return send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'unknown' } });
  }
});
