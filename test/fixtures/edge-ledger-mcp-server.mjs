#!/usr/bin/env node
// 14.6.0: line-delimited JSON-RPC MCP server for the edge-autonomy tests. Every tools/call that reaches it appends one
// JSON line to $LEDGER before it answers, so a test can count real upstream executions across reconnects and crashes.
// Tools carry MCP annotations so the offline risk classifier can be exercised:
//   lookup  readOnlyHint                  answers {found}
//   note    (no annotations, neutral name) answers {noted}
//   rename  write (by name)               answers {renamed}
//   wipe    destructiveHint               answers {wiped}
//   charge  payment (by name)             answers {charged}
//   tag     readOnlyHint:false, idempotentHint:true
//   hang    records, never answers (crash between call and commit)
//   slow    records, answers after args.ms
//   reject  records, JSON-RPC error "version conflict" (a stale write)
import { createInterface } from 'readline';
import { appendFileSync } from 'fs';

const LEDGER = process.env.LEDGER;
const send = (m) => process.stdout.write(JSON.stringify(m) + '\n');
const record = (e) => LEDGER && appendFileSync(LEDGER, JSON.stringify({ ...e, pid: process.pid, at: Date.now() }) + '\n');
const ok = (id, v) => send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(v) }], structuredContent: v } });
const TOOLS = [
  { name: 'lookup', annotations: { readOnlyHint: true } },
  { name: 'note' },
  { name: 'rename' },
  { name: 'wipe', annotations: { destructiveHint: true } },
  { name: 'charge' },
  { name: 'tag', annotations: { readOnlyHint: false, idempotentHint: true } },
  { name: 'hang' },
  { name: 'slow' },
  { name: 'reject' },
];

createInterface({ input: process.stdin }).on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.id === undefined) return;
  switch (msg.method) {
    case 'initialize':
      return send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'edge-ledger', version: '1' } } });
    case 'tools/list':
      return send({ jsonrpc: '2.0', id: msg.id, result: { tools: TOOLS.map((t) => ({ ...t, description: t.name, inputSchema: { type: 'object' } })) } });
    case 'ping':
      return send({ jsonrpc: '2.0', id: msg.id, result: {} });
    case 'tools/call': {
      const name = msg.params?.name;
      const args = msg.params?.arguments ?? {};
      record({ tool: name, args });
      if (name === 'hang') return;
      if (name === 'slow') return void setTimeout(() => ok(msg.id, { slow: true }), Number(args.ms ?? 100));
      if (name === 'reject') return send({ jsonrpc: '2.0', id: msg.id, error: { code: -32050, message: 'version conflict: record changed upstream' } });
      return ok(msg.id, { [name]: true, ...args });
    }
    default:
      if (msg.result !== undefined || msg.error !== undefined) return;
      return send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'unknown' } });
  }
});
