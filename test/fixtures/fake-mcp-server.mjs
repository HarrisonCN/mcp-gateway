#!/usr/bin/env node
// Minimal line-delimited JSON-RPC MCP server used by the tests.
// Behaviour knobs via env: FAIL_INIT=1, FAIL_INIT_IF_EXISTS=<path>, TOOL_PAGES=n, SLOW_MS=n, INIT_DELAY_MS=n,
// FEATURES=1 (resources with subscribe, prompts, logging, completions, progress; see below)
import { createInterface } from 'readline';
import { existsSync } from 'fs';

const pages = Number(process.env.TOOL_PAGES ?? 1);
const slowMs = Number(process.env.SLOW_MS ?? 0);
const initDelayMs = Number(process.env.INIT_DELAY_MS ?? 0);
const send = (m) => process.stdout.write(JSON.stringify(m) + '\n');
const features = !!process.env.FEATURES;
let logLevel = 'none';
const LEVELS = ['debug', 'info', 'notice', 'warning', 'error', 'critical', 'alert', 'emergency'];
const subscribed = new Set();
const log = (level, data) => {
  if (LEVELS.indexOf(level) < LEVELS.indexOf(logLevel)) return;
  send({ jsonrpc: '2.0', method: 'notifications/message', params: { level, logger: 'fake', data } });
};

const FEATURE_METHODS = new Set([
  'resources/list', 'resources/templates/list', 'resources/read', 'resources/subscribe', 'resources/unsubscribe',
  'prompts/list', 'logging/setLevel', 'completion/complete',
]);

function handleFeature(msg) {
  switch (msg.method) {
    case 'resources/list':
      return send({ jsonrpc: '2.0', id: msg.id, result: { resources: [{ uri: 'live://counter', name: 'counter' }] } });
    case 'resources/templates/list':
      return send({ jsonrpc: '2.0', id: msg.id, result: { resourceTemplates: [{ uriTemplate: 'live://item/{id}', name: 'item' }] } });
    case 'resources/read':
      return send({ jsonrpc: '2.0', id: msg.id, result: { contents: [{ uri: msg.params.uri, text: 'v' }] } });
    case 'resources/subscribe':
      subscribed.add(msg.params.uri);
      send({ jsonrpc: '2.0', id: msg.id, result: {} });
      return;
    case 'resources/unsubscribe':
      subscribed.delete(msg.params.uri);
      return send({ jsonrpc: '2.0', id: msg.id, result: {} });
    case 'prompts/list':
      return send({ jsonrpc: '2.0', id: msg.id, result: { prompts: [{ name: 'greet', arguments: [{ name: 'lang' }] }] } });
    case 'logging/setLevel':
      logLevel = msg.params.level;
      return send({ jsonrpc: '2.0', id: msg.id, result: {} });
    case 'completion/complete': {
      const { ref, argument } = msg.params;
      const pool = ref.type === 'ref/prompt' ? ['en', 'es', 'de', 'eo'] : ['1', '2', '10'];
      const values = pool.filter((v) => v.startsWith(argument.value));
      return send({ jsonrpc: '2.0', id: msg.id, result: { completion: { values, total: values.length, hasMore: false } } });
    }
  }
}

createInterface({ input: process.stdin }).on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.id === undefined) return; // notification
  switch (msg.method) {
    case 'initialize':
      const failFile = process.env.FAIL_INIT_IF_EXISTS;
      if (process.env.FAIL_INIT || (failFile && existsSync(failFile))) return send({ jsonrpc: '2.0', id: msg.id, error: { code: -1, message: 'nope' } });
      return void setTimeout(() => send({ jsonrpc: '2.0', id: msg.id, result: {
        protocolVersion: features ? '2025-06-18' : '2024-11-05',
        capabilities: features
          ? { tools: {}, resources: { subscribe: true }, prompts: {}, logging: {}, completions: {} }
          : { tools: {} },
        serverInfo: { name: 'fake', version: '1' },
      } }), initDelayMs);
    case 'tools/list': {
      const page = Number(msg.params?.cursor ?? 0);
      const next = page + 1 < pages ? String(page + 1) : undefined;
      const tools = [{ name: `echo${page || ''}`, description: 'echo' }];
      if (features) for (const name of ['progress', 'log', 'touch', 'crash']) tools.push({ name, description: name });
      return send({ jsonrpc: '2.0', id: msg.id, result: { tools, ...(next ? { nextCursor: next } : {}) } });
    }
    case 'ping':
      return send({ jsonrpc: '2.0', id: msg.id, result: {} });
    case 'tools/call': {
      const { name, arguments: args } = msg.params;
      if (name === 'crash') process.exit(3);
      if (name === 'env') return send({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: JSON.stringify({ env: process.env, cwd: process.cwd() }) }] } });
      if (name === 'progress') {
        const token = msg.params._meta?.progressToken;
        let i = 0;
        const tick = () => {
          i++;
          if (token !== undefined) send({ jsonrpc: '2.0', method: 'notifications/progress', params: { progressToken: token, progress: i, total: 3, message: `step ${i}` } });
          if (i < 3) return void setTimeout(tick, 10);
          send({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: token === undefined ? 'no-token' : 'done' }] } });
        };
        return void setTimeout(tick, 10);
      }
      if (name === 'log') {
        log('debug', 'dbg');
        log('info', 'inf');
        log('error', { problem: 'err' });
        return send({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: 'logged' }] } });
      }
      if (name === 'touch') {
        for (const uri of subscribed) send({ jsonrpc: '2.0', method: 'notifications/resources/updated', params: { uri } });
        return send({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: [...subscribed].join(',') }] } });
      }
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
      const echoed = process.env.SERVER_TAG ? { ...args, _server: process.env.SERVER_TAG } : args;
      setTimeout(() => send({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: JSON.stringify(echoed) }] } }), delay);
      return;
    }
    default:
      if (msg.result !== undefined || msg.error !== undefined) return; // reply to our ping
      if (features && FEATURE_METHODS.has(msg.method)) return void handleFeature(msg);
      return send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'unknown' } });
  }
});
