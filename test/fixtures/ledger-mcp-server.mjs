#!/usr/bin/env node
// 14.4.0: line-delimited JSON-RPC MCP server with side effects, for the durable task tests.
// Every tools/call that reaches it appends one JSON line to $LEDGER (synchronously, before it answers), so a test can
// count real executions across gateway crashes.
//   charge  {id, amount}     non-idempotent effect; answers {charged:id}
//   refund  {id}             compensation; answers {refunded:id}
//   upsert  {key, ...}       idempotent by `key` (a repeated key is recorded as dup and answers the first result)
//   hang    {...}            records, then never answers (a crash between call and commit)
//   slow    {ms}             records, answers after ms
//   fail    {}               records, JSON-RPC error
//   flaky   {failures}       fails the first `failures` calls (counted in the ledger), then succeeds
import { createInterface } from 'readline';
import { appendFileSync, existsSync, readFileSync } from 'fs';

const LEDGER = process.env.LEDGER;
const send = (m) => process.stdout.write(JSON.stringify(m) + '\n');
const lines = () => (LEDGER && existsSync(LEDGER) ? readFileSync(LEDGER, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const record = (e) => LEDGER && appendFileSync(LEDGER, JSON.stringify({ ...e, pid: process.pid, at: Date.now() }) + '\n');
const ok = (id, v) => send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(v) }], structuredContent: v } });
const err = (id, m) => send({ jsonrpc: '2.0', id, error: { code: -32050, message: m } });
const TOOLS = ['charge', 'refund', 'upsert', 'hang', 'slow', 'fail', 'flaky'];

createInterface({ input: process.stdin }).on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.id === undefined) return;
  switch (msg.method) {
    case 'initialize':
      return send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'ledger', version: '1' } } });
    case 'tools/list':
      return send({ jsonrpc: '2.0', id: msg.id, result: { tools: TOOLS.map((name) => ({ name, description: name, inputSchema: { type: 'object' } })) } });
    case 'ping':
      return send({ jsonrpc: '2.0', id: msg.id, result: {} });
    case 'tools/call': {
      const name = msg.params?.name;
      const args = msg.params?.arguments ?? {};
      if (name === 'upsert') {
        const prev = lines().find((l) => l.tool === 'upsert' && !l.dup && l.args?.key === args.key);
        record({ tool: name, args, dup: !!prev });
        return ok(msg.id, { key: args.key, first: prev ? prev.at : true });
      }
      if (name === 'flaky') {
        const n = lines().filter((l) => l.tool === 'flaky').length;
        record({ tool: name, args });
        return n < Number(args.failures ?? 1) ? err(msg.id, `flaky failure ${n + 1}`) : ok(msg.id, { ok: true, attempt: n + 1 });
      }
      record({ tool: name, args });
      if (name === 'hang') return;
      if (name === 'fail') return err(msg.id, 'upstream refused');
      if (name === 'slow') return void setTimeout(() => ok(msg.id, { slow: true, ...args }), Number(args.ms ?? 100));
      if (name === 'charge') return ok(msg.id, { charged: args.id ?? null, amount: args.amount ?? null });
      if (name === 'refund') return ok(msg.id, { refunded: args.id ?? null });
      return err(msg.id, `unknown tool ${name}`);
    }
    default:
      if (msg.result !== undefined || msg.error !== undefined) return;
      return send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'unknown' } });
  }
});
