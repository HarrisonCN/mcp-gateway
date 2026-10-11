// MGW-2026-018 regression (14.6.0; LTS backports): edge-autonomy outbox
//  (1) replayed queued calls on reconnect under the principal captured when the call was queued — a key removed (or
//      re-scoped) while the edge was offline still had its queued calls executed upstream;
//  (2) wrote outbox.json / cache.json with the process umask (typically world-readable 0644) although they carry the
//      queued arguments, cached results and the caller's principal.
// Self-contained (inline upstream fixture, a tool name no offline policy treats as high-risk): the same file runs on
// the LTS lines.
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, existsSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Gateway } from '../src/gateway/index.js';
import { edgeState } from '../src/features/edge-autonomy.js';
import type { GatewayConfig } from '../src/utils/types.js';

const FIXTURE = `
const { createInterface } = require('readline');
const { appendFileSync } = require('fs');
const send = (m) => process.stdout.write(JSON.stringify(m) + '\\n');
createInterface({ input: process.stdin }).on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.id === undefined) return;
  if (msg.method === 'initialize') return send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'ledger', version: '1' } } });
  if (msg.method === 'tools/list') return send({ jsonrpc: '2.0', id: msg.id, result: { tools: ['note', 'lookup'].map((name) => ({ name, description: name, inputSchema: { type: 'object' } })) } });
  if (msg.method === 'ping') return send({ jsonrpc: '2.0', id: msg.id, result: {} });
  if (msg.method === 'tools/call') {
    const name = msg.params.name, args = msg.params.arguments || {};
    appendFileSync(process.env.LEDGER, JSON.stringify({ tool: name, args }) + '\\n');
    return send({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: JSON.stringify({ ok: name }) }] } });
  }
  if (msg.result === undefined && msg.error === undefined) send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'unknown' } });
});
`;

const gws: Gateway[] = [];
afterEach(async () => {
  for (const g of gws.splice(0)) await g.stop().catch(() => undefined);
  edgeState.reset();
});

describe('MGW-2026-018: edge-autonomy outbox replays', () => {
  it('a key removed while the edge was offline does not get its queued calls executed; state files are 0600 in a 0700 dir', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mgw-018-'));
    const fixture = join(dir, 'ledger.cjs');
    writeFileSync(fixture, FIXTURE);
    const ledger = join(dir, 'ledger.jsonl');
    const notes = () => (existsSync(ledger) ? readFileSync(ledger, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((l) => l.tool === 'note').length : 0);
    const state = join(dir, 'edge');
    const config = {
      port: 0, host: '127.0.0.1', logLevel: 'error', monitor: { requestLog: false },
      servers: [{ id: 'ledger', name: 'ledger', transport: 'stdio', command: process.execPath, args: [fixture], env: { LEDGER: ledger }, timeout: 10_000 }],
      auth: { strategy: 'api-key', apiKeys: [{ key: 'op', name: 'ops' }, { key: 'k-temp', name: 'temp' }] },
      edgeAutonomy: { dir: state, rules: [{ match: 'ledger/lookup', action: 'cache' }, { match: 'ledger/*', action: 'queue' }], reconcile: { intervalMs: 3_600_000 } },
    } as unknown as GatewayConfig;
    const gw = new Gateway(config);
    await gw.start();
    gws.push(gw);
    const base = `http://127.0.0.1:${gw.address()!.port}`;
    const req = async (path: string, body?: unknown, key = 'op', method?: string) => {
      const r = await fetch(`${base}/api/v1/${path}`, { method: method ?? (body === undefined ? 'GET' : 'POST'), headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      return { status: r.status, body: (await r.json().catch(() => undefined)) as any }; // eslint-disable-line @typescript-eslint/no-explicit-any
    };
    await new Promise((r) => setTimeout(r, 250)); // start-up reconcile pass
    expect((await req('tools/call', { server: 'ledger', tool: 'lookup', arguments: { q: 1 } }, 'k-temp')).status).toBe(200); // cached
    expect((await req('admin/edge-autonomy/connectivity', { disconnected: true })).status).toBe(200);
    const q = await req('tools/call', { server: 'ledger', tool: 'note', arguments: { text: 'queued while offline' } }, 'k-temp');
    expect(q.status).toBe(200);
    expect(q.body.result.structuredContent.queued).toBe(true);
    const before = notes();

    // while the edge is offline, the operator removes the key
    await gw.reload({ ...config, auth: { strategy: 'api-key', apiKeys: [{ key: 'op', name: 'ops' }] } } as never);
    expect((await req('tools/call', { server: 'ledger', tool: 'note', arguments: {} }, 'k-temp')).status).toBe(401);

    await req('admin/edge-autonomy/connectivity', { disconnected: false });
    await req('admin/edge-autonomy/reconcile', {});
    await req('admin/edge-autonomy/reconcile', {});
    expect(notes() - before).toBe(0); // the removed key's queued call never reached the upstream
    const entries = (await req('admin/edge-autonomy/outbox')).body.entries as Array<{ status: string }>;
    expect(entries).toHaveLength(1);
    expect(entries[0]!.status).not.toBe('applied');

    // (2) permissions of the persisted state
    expect(statSync(state).mode & 0o777).toBe(0o700);
    for (const f of ['outbox.json', 'cache.json']) {
      expect(existsSync(join(state, f))).toBe(true);
      expect(statSync(join(state, f)).mode & 0o777).toBe(0o600);
    }
  });
});
