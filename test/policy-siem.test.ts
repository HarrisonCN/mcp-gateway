import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { fileURLToPath } from 'url';
import { createSocket } from 'dgram';
import { createServer as createTcpServer, type AddressInfo } from 'net';
import { createServer, type Server } from 'http';
import { spawnSync } from 'child_process';
import { createRequire } from 'module';
import { loadConfig, loadPolicyFiles } from '../src/config/loader.js';
import { runPolicyTests, evaluatePolicy } from '../src/policy/tool-policy.js';
import { AuditExporter, formatSyslog, toAuditEvent } from '../src/monitor/siem.js';
import { Gateway } from '../src/gateway/index.js';
import type { RequestMetric } from '../src/utils/types.js';
import { logger } from '../src/utils/logger.js';

logger.setLevel('error');
const fixture = fileURLToPath(new URL('./fixtures/fake-mcp-server.mjs', import.meta.url));
const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'mcpgw-pol-'));
  dirs.push(d);
  return d;
};
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

const metric = (over: Partial<RequestMetric> = {}): RequestMetric => ({
  id: 'r1', timestamp: new Date('2026-10-07T12:00:00Z'), serverId: 'gh', toolName: 'search', durationMs: 12, success: true, clientId: 'key:a', via: 'rest', ...over,
});

describe('policy-as-code files', () => {
  function setup() {
    const d = tmp();
    writeFileSync(join(d, 'base.yaml'), `version: 1
default: deny
rules:
  - name: fs-read
    effect: allow
    tools: ["fs/read_*"]
    args: [{ path: path, under: ["/data"] }]
tests:
  - name: read inside data
    call: { server: fs, tool: read_file, args: { path: /data/a.txt } }
    expect: allow
    rule: fs-read
  - call: { server: fs, tool: read_file, args: { path: /etc/passwd } }
    expect: deny
`);
    writeFileSync(join(d, 'extra.json'), JSON.stringify([{ effect: 'approve', tools: ['deploy'] }]));
    writeFileSync(join(d, 'mcp-gateway.yml'), `servers: []
policy:
  rules:
    - name: admin
      effect: allow
      clients: ["key:admin"]
  files: [base.yaml, extra.json]
  tests:
    - call: { client: "key:admin", server: x, tool: anything }
      expect: allow
      rule: admin
    - call: { server: ci, tool: deploy }
      expect: approve
`);
    return d;
  }

  it('merges inline rules first, then files in order; takes the file default', async () => {
    const d = setup();
    const cfg = await loadConfig(join(d, 'mcp-gateway.yml'));
    expect(cfg.policy?.rules?.map((r) => r.name)).toEqual(['admin', 'fs-read', 'extra.json#1']);
    expect(cfg.policy?.default).toBe('deny');
    expect(evaluatePolicy(cfg.policy, { serverId: 'ci', tool: 'deploy', args: {} }).effect).toBe('approve');
    const results = runPolicyTests(cfg.policy);
    expect(results).toHaveLength(4);
    expect(results.every((r) => r.passed)).toBe(true);
  });

  it('re-merging an already merged policy does not duplicate file rules (admin GET → PUT round trip, 3.0.1)', async () => {
    const d = setup();
    const cfg = await loadConfig(join(d, 'mcp-gateway.yml'));
    const again = await loadPolicyFiles(JSON.parse(JSON.stringify(cfg.policy)), d);
    expect(again.rules?.map((r) => r.name)).toEqual(['admin', 'fs-read', 'extra.json#1']);
    expect(again.tests).toHaveLength(4);
  });

  it('reports failing tests and invalid files', async () => {
    const d = setup();
    writeFileSync(join(d, 'bad-test.yaml'), 'tests: [{ call: { server: fs, tool: write }, expect: allow }]\n');
    writeFileSync(join(d, 'c2.yml'), 'servers: []\npolicy: { files: [base.yaml, bad-test.yaml] }\n');
    const results = runPolicyTests((await loadConfig(join(d, 'c2.yml'))).policy);
    expect(results.filter((r) => !r.passed).map((r) => r.actual)).toEqual(['deny (default)']);

    writeFileSync(join(d, 'broken.yaml'), 'rules: [{ effect: maybe }]\n');
    writeFileSync(join(d, 'c3.yml'), 'servers: []\npolicy: { files: [broken.yaml] }\n');
    await expect(loadConfig(join(d, 'c3.yml'))).rejects.toThrow(/policy file broken.yaml/);
    writeFileSync(join(d, 'c4.yml'), 'servers: []\npolicy: { files: [missing.yaml] }\n');
    await expect(loadConfig(join(d, 'c4.yml'))).rejects.toThrow(/missing.yaml/);
    writeFileSync(join(d, 'rx.yaml'), 'rules: [{ effect: deny, args: [{ path: a, regex: "(" }] }]\n');
    writeFileSync(join(d, 'c5.yml'), 'servers: []\npolicy: { files: [rx.yaml] }\n');
    await expect(loadConfig(join(d, 'c5.yml'))).rejects.toThrow(/invalid regex/);
  });

  it('`mcp-gateway policy test` exits non-zero on failures', () => {
    const require = createRequire(import.meta.url);
    const TSX = join(require.resolve('tsx/package.json'), '..', 'dist', 'cli.mjs');
    const CLI = resolve(__dirname, '..', 'src', 'cli.ts');
    const d = setup();
    const ok = spawnSync(process.execPath, [TSX, CLI, 'policy', 'test', '-c', join(d, 'mcp-gateway.yml'), '--json'], { encoding: 'utf-8', timeout: 30_000 });
    expect(ok.status).toBe(0);
    expect(JSON.parse(ok.stdout)).toMatchObject({ total: 4, failed: 0 });
    writeFileSync(join(d, 'bad.yml'), 'servers: []\npolicy: { default: deny, tests: [{ call: { server: a, tool: b }, expect: allow }] }\n');
    const bad = spawnSync(process.execPath, [TSX, CLI, 'policy', 'test', '-c', join(d, 'bad.yml')], { encoding: 'utf-8', timeout: 30_000 });
    expect(bad.status).toBe(1);
    expect(bad.stdout).toContain('✗');
  }, 60_000);
});

describe('SIEM audit export', () => {
  it('formats RFC 5424 syslog lines with structured data', () => {
    const line = formatSyslog(toAuditEvent(metric({ success: false, errorMessage: 'boom', toolName: 'a"b' })), { facility: 'auth', appName: 'gw' });
    expect(line.startsWith('<36>1 2026-10-07T12:00:00.000Z ')).toBe(true); // auth(4)*8 + warning(4)
    expect(line).toContain(' gw - request [mcpgw@32473 server="gh" name="a\\"b" client="key:a" success="false" durationMs="12"] {');
    expect(JSON.parse(line.slice(line.indexOf('] {') + 2))).toMatchObject({ event: 'mcp_gateway.request', error: 'boom', kind: 'tool' });
  });

  it('batches webhook deliveries, retries, filters and counts failures', async () => {
    const bodies: string[] = [];
    let fail = 1;
    const f = (async (_u: unknown, init?: RequestInit) => {
      if (fail-- > 0) return new Response('', { status: 503 });
      bodies.push(String(init?.body));
      return new Response('', { status: 200 });
    }) as typeof fetch;
    const ex = new AuditExporter(
      [
        { type: 'webhook', url: 'https://siem.example/hec', batchSize: 2, flushIntervalMs: 20, format: 'ndjson' },
        { type: 'webhook', url: 'https://siem.example/errors', failuresOnly: true, retries: 0 },
        { type: 'webhook', url: 'https://off.example', enabled: false },
      ],
      { fetch: f },
    );
    expect(ex.size).toBe(2);
    ex.push(metric({ id: '1' }));
    ex.push(metric({ id: '2', success: false }));
    ex.push(metric({ id: '3' }));
    await ex.flush();
    await new Promise((r) => setTimeout(r, 300));
    await ex.flush();
    const hec = bodies.filter((b) => !b.startsWith('{"events"'));
    expect(hec.join('').trim().split('\n').map((l) => JSON.parse(l).id)).toEqual(['1', '2', '3']);
    const errs = bodies.filter((b) => b.startsWith('{"events"'));
    expect(errs.flatMap((b) => JSON.parse(b).events.map((e: { id: string }) => e.id))).toEqual(['2']);
    const [s1] = ex.stats();
    expect(s1).toMatchObject({ sent: 3, failed: 0, queued: 0, lastError: expect.stringContaining('503') });
    await ex.close();
  });

  it('drops the oldest records beyond maxQueue', async () => {
    const ex = new AuditExporter([{ type: 'webhook', url: 'https://x.example', maxQueue: 2, batchSize: 100, retries: 0 }], { fetch: (async () => new Response('', { status: 500 })) as typeof fetch });
    for (const id of ['1', '2', '3', '4']) ex.push(metric({ id }));
    expect(ex.stats()[0]).toMatchObject({ dropped: 2, queued: 2 });
    await ex.flush();
    expect(ex.stats()[0]).toMatchObject({ failed: 2 });
    await ex.close();
  });

  it('sends syslog over UDP and octet-counted TCP', async () => {
    const udp = createSocket('udp4');
    const udpGot = new Promise<string>((r) => udp.once('message', (m) => r(m.toString())));
    await new Promise<void>((r) => udp.bind(0, '127.0.0.1', () => r()));
    let tcpData = '';
    const tcp = createTcpServer();
    const tcpGot = new Promise<void>((r) => {
      tcp.on('connection', (s) => s.on('data', (c) => { tcpData += c; if (tcpData.split(' <').length > 2) r(); }));
    });
    await new Promise<void>((r) => tcp.listen(0, '127.0.0.1', () => r()));
    const ex = new AuditExporter([
      { type: 'syslog', host: '127.0.0.1', port: (udp.address() as AddressInfo).port },
      { type: 'syslog', host: '127.0.0.1', port: (tcp.address() as AddressInfo).port, protocol: 'tcp', batchSize: 2 },
    ]);
    ex.push(metric({ id: 'u1' }));
    ex.push(metric({ id: 'u2' }));
    await ex.flush();
    expect(await udpGot).toMatch(/^<134>1 /);
    await tcpGot;
    expect(tcpData).toMatch(/^\d+ <134>1 /);
    expect(ex.stats().map((s) => s.sent)).toEqual([2, 2]);
    await ex.close();
    udp.close();
    tcp.close();
  });

  it('gateway exports every request to a webhook', async () => {
    const got: Array<{ events: Array<{ name: string; server: string; via: string }> }> = [];
    const hook: Server = createServer((req, res) => {
      let b = '';
      req.on('data', (c) => (b += c));
      req.on('end', () => {
        got.push(JSON.parse(b));
        res.end();
      });
    });
    await new Promise<void>((r) => hook.listen(0, '127.0.0.1', () => r()));
    const gw = new Gateway({
      port: 0, host: '127.0.0.1', logLevel: 'error', monitor: { requestLog: false },
      servers: [{ id: 'fake', name: 'fake', transport: 'stdio', command: process.execPath, args: [fixture], timeout: 5000 }],
      audit: { export: [{ type: 'webhook', url: `http://127.0.0.1:${(hook.address() as AddressInfo).port}/`, flushIntervalMs: 10 }] },
    });
    try {
      await gw.start();
      const res = await fetch(`http://127.0.0.1:${gw.address()!.port}/api/v1/tools/call`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ tool: 'echo', arguments: {} }) });
      expect(res.status).toBe(200);
      await gw.flushAuditExport();
      expect(got.flatMap((g) => g.events)[0]).toMatchObject({ name: 'echo', server: 'fake', via: 'rest' });
      expect(gw.auditExportStats()[0]).toMatchObject({ type: 'webhook', sent: 1 });
    } finally {
      await gw.stop();
      hook.close();
    }
  });
});
