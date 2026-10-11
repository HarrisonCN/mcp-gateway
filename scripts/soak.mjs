#!/usr/bin/env node
// 14.9.0 long-running soak harness: a 2-instance deployment sharing one real Redis, steady load from several tenants,
// and fault injection (kill -9 + restart of an instance, a network partition between an instance and Redis, a Redis
// restart). It checks the v15 gate invariants continuously and reports performance:
//
//   invariants  no cross-tenant leakage (every executed call carries the owning tenant's injected secret, every response
//               the caller's own; cross-tenant attempts are refused and never reach an upstream), no duplicate
//               execution of a non-idempotent call (each `charge` id at most once in the upstream ledger; durable task
//               runs submitted with an Idempotency-Key — retried against the other instance after errors — execute
//               exactly once)
//   metrics     p50 / p95 / p99 latency, throughput, error rate (overall and outside fault windows), RSS growth of the
//               instance that is never killed (MB/hour, linear fit), recovery time per fault
//
// The gateway under test is this checkout's dist/ (npm run build) or any installed release (`--impl <package dir>`),
// so a baseline (e.g. 13.3.0) is measured with the same harness, workload and machine:
//
//   node scripts/soak.mjs --duration 30m --out soak.json                       # this checkout
//   node scripts/soak.mjs --duration 30m --impl /tmp/v133/node_modules/@winstonsayno/mcp-gateway --out base.json
//   node scripts/soak.mjs --duration 72h --baseline base.json --out soak-72h.json   # the v15 gate (CI: soak.yml)
//
// Fixed settings (keep them identical between a run and its baseline): --rps 60 --concurrency 8 --fault-every 5m.
// Needs redis-server on PATH (or MGW_REDIS_SERVER). Exit code 1 when an invariant is violated.
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, appendFileSync } from 'node:fs';
import { createServer, connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const opt = (name, def) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : def;
};
const dur = (s) => {
  const m = /^(\d+(?:\.\d+)?)(ms|s|m|h)?$/.exec(String(s));
  if (!m) throw new Error(`bad duration ${s}`);
  return Number(m[1]) * { ms: 1, s: 1e3, m: 60e3, h: 3600e3 }[m[2] ?? 's'];
};
const SETTINGS = {
  durationMs: dur(opt('duration', '30m')),
  rps: Number(opt('rps', '60')),
  concurrency: Number(opt('concurrency', '8')),
  faultEveryMs: dur(opt('fault-every', '5m')),
  warmupMs: dur(opt('warmup', '30s')),
  sampleEveryMs: dur(opt('sample-every', '10s')),
};
const IMPL = resolve(opt('impl', ROOT));
const OUT = opt('out', join(process.cwd(), 'soak-report.json'));
const BASELINE = opt('baseline');
const LOG = opt('log');
const REDIS_BIN = process.env.MGW_REDIS_SERVER ?? 'redis-server';
const implVersion = JSON.parse(readFileSync(join(IMPL, 'package.json'), 'utf8')).version;
const [maj, min] = implVersion.split('.').map(Number);
const HAS_DURABLE = maj > 14 || (maj === 14 && min >= 4);
const CLI = join(IMPL, 'dist', 'cli.js');
if (!existsSync(CLI)) throw new Error(`${CLI} missing — run npm run build (or pass --impl)`);
if (spawnSync(REDIS_BIN, ['--version']).status !== 0) throw new Error('redis-server not found (set MGW_REDIS_SERVER)');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => Date.now();
const log = (m) => {
  const line = `${new Date().toISOString()} ${m}`;
  console.log(line);
  if (LOG) appendFileSync(LOG, line + '\n');
};
const freePort = () => new Promise((res, rej) => { const s = createServer(); s.once('error', rej); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });

const DIR = mkdtempSync(join(tmpdir(), 'mgw-soak-'));
const LEDGER = join(DIR, 'ledger.jsonl');

// ── upstream: line-delimited MCP server with side effects recorded in a shared ledger ─────────────────────────────
const UPSTREAM = join(DIR, 'upstream.mjs');
writeFileSync(UPSTREAM, `
import { createInterface } from 'node:readline';
import { appendFileSync } from 'node:fs';
const send = (m) => process.stdout.write(JSON.stringify(m) + '\\n');
createInterface({ input: process.stdin }).on('line', (line) => {
  let msg; try { msg = JSON.parse(line); } catch { return; }
  if (msg.id === undefined) return;
  if (msg.method === 'initialize') return send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: msg.params?.protocolVersion ?? '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: process.env.SERVER_ID, version: '1' } } });
  if (msg.method === 'tools/list') return send({ jsonrpc: '2.0', id: msg.id, result: { tools: ['charge', 'lookup'].map((name) => ({ name, description: name, inputSchema: { type: 'object' } })) } });
  if (msg.method === 'ping') return send({ jsonrpc: '2.0', id: msg.id, result: {} });
  if (msg.method === 'tools/call') {
    const { name, arguments: args = {} } = msg.params;
    if (name === 'charge') appendFileSync(process.env.LEDGER, JSON.stringify({ server: process.env.SERVER_ID, id: args.id, by: args.by, api_key: args.api_key }) + '\\n');
    const v = { server: process.env.SERVER_ID, tool: name, id: args.id, api_key: args.api_key };
    return send({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: JSON.stringify(v) }] } });
  }
  send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'unknown method' } });
});
`);

// ── Redis (AOF, fsync always — a durable deployment) and a TCP fault proxy per gateway ───────────────────────────
let redis;
let redisPort;
async function startRedis() {
  redisPort ??= await freePort();
  redis = spawn(REDIS_BIN, ['--port', String(redisPort), '--bind', '127.0.0.1', '--save', '', '--appendonly', 'yes', '--appendfsync', 'always', '--dir', DIR], { stdio: 'ignore' });
  for (let i = 0; i < 100; i++) {
    if (await new Promise((res) => { const s = connect(redisPort, '127.0.0.1', () => { s.end(); res(true); }); s.on('error', () => res(false)); })) return;
    await sleep(50);
  }
  throw new Error('redis did not start');
}
async function faultProxy(targetPort) {
  const socks = new Set();
  let refusing = false;
  const srv = createServer((c) => {
    if (refusing) return void c.destroy();
    const u = connect(targetPort, '127.0.0.1');
    socks.add(c); socks.add(u);
    c.pipe(u); u.pipe(c);
    const end = () => { c.destroy(); u.destroy(); socks.delete(c); socks.delete(u); };
    c.on('error', end); u.on('error', end); c.on('close', end); u.on('close', end);
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  return {
    port: srv.address().port,
    partition() { refusing = true; for (const s of socks) s.destroy(); socks.clear(); },
    heal() { refusing = false; },
    close() { refusing = true; for (const s of socks) s.destroy(); srv.close(); },
  };
}

// ── gateways ─────────────────────────────────────────────────────────────────────────────────────────────────────
const CLIENTS = { alice: { key: 'soak-alice-0123456789abcdef', tenant: 'acme' }, bob: { key: 'soak-bob-0123456789abcdef01', tenant: 'labs' }, carol: { key: 'soak-carol-0123456789abcdef0', tenant: 'labs' } };
const OP = 'soak-operator-0123456789abcdef';
const SECRET = { acme: 'tenant-secret-acme', labs: 'tenant-secret-labs' };
const OWNER = { 'acme-db': 'acme', 'labs-db': 'labs' };
function configText(port, proxyPort) {
  const v = maj >= 14 ? 12 : 11;
  const srv = (id) => `  - id: ${id}\n    name: ${id}\n    transport: stdio\n    command: ${JSON.stringify(process.execPath)}\n    args: [${JSON.stringify(UPSTREAM)}]\n    env: { LEDGER: ${JSON.stringify(LEDGER)}, SERVER_ID: ${id} }\n    inject:\n      - { ref: "secret://env/SOAK_SECRET_{tenant}", argument: api_key }\n`;
  return [
    `version: ${v}`, `host: 127.0.0.1`, `port: ${port}`, `logLevel: warn`,
    `auth:`, `  strategy: api-key`, `  apiKeys:`, `    - { name: ops, key: "${OP}" }`,
    ...Object.entries(CLIENTS).map(([n, c]) => `    - { name: ${n}, key: "${c.key}" }`),
    `secrets: { providers: [{ id: env, type: env }] }`,
    `store:`, `  backend: redis`, `  redis: { url: "redis://127.0.0.1:${proxyPort}", keyPrefix: "soak:", connectTimeoutMs: 1000, commandTimeoutMs: 1000 }`,
    `tenants:`,
    `  - { id: acme, servers: ["acme-*"], members: [{ client: "key:alice", role: admin }] }`,
    `  - { id: labs, servers: ["labs-*"], members: [{ client: "key:bob", role: admin }, { client: "key:carol", role: admin }] }`,
    `servers:`, srv('acme-db') + srv('labs-db'),
    ...(HAS_DURABLE ? [`features:`, `  taskGraphs:`, `    durable: { leaseMs: 3000, sweepIntervalMs: 500 }`, `    graphs:`, ...['acme-db', 'labs-db'].map((s) => `      - { id: pay-${s}, clients: true, nodes: [{ id: c, tool: ${s}/charge, args: { id: "{{input.id}}", by: "{{input.by}}" } }] }`)] : []),
    '',
  ].join('\n');
}
const instances = [];
async function startInstance(inst) {
  writeFileSync(inst.cfg, configText(inst.port, inst.proxy.port));
  inst.proc = spawn(process.execPath, [CLI, 'start', '-c', inst.cfg], { stdio: ['ignore', 'ignore', 'pipe'], env: { ...process.env, SOAK_SECRET_acme: SECRET.acme, SOAK_SECRET_labs: SECRET.labs, MCP_GATEWAY_SILENCE_DEPRECATIONS: '1' } });
  inst.proc.stderr.on('data', (d) => { inst.stderr = (inst.stderr + d).slice(-4000); });
  inst.startedAt = now();
  for (let i = 0; i < 300; i++) {
    try { const st = (await fetch(`${inst.base}/api/v1/health/live`)).status; inst.lastHealth = st; if (st === 200) return; } catch (e) { inst.lastHealth = e.cause?.code ?? e.message; }
    await sleep(100);
  }
  throw new Error(`instance ${inst.name} did not become healthy (last /health: ${inst.lastHealth}): ${inst.stderr}`);
}

// ── load ─────────────────────────────────────────────────────────────────────────────────────────────────────────
const lat = { all: [], steady: [] };
const counts = { ok: 0, err: 0, errSteady: 0, okSteady: 0, crossRefused: 0, crossAllowed: 0, leaks: 0, durableSubmitted: 0, durableRetries: 0 };
const violations = [];
const faults = [];
let inFault = false;
let faultMs = 0; // time spent inside fault windows (excluded from the steady-state numbers)
let seq = 0;
const durableKeys = new Map(); // key → { server, client }
const charges = new Map(); // id → { client, server } sent by the client (once)

async function call(inst, client, server, tool, args) {
  const t0 = performance.now();
  const r = await fetch(`${inst.base}/api/v1/tools/call`, { method: 'POST', headers: { authorization: `Bearer ${CLIENTS[client].key}`, 'content-type': 'application/json' }, body: JSON.stringify({ server, tool, arguments: args }), signal: AbortSignal.timeout(10_000) });
  const body = await r.json().catch(() => ({}));
  return { status: r.status, body, ms: performance.now() - t0 };
}
async function oneRequest() {
  const n = ++seq;
  const inst = instances[n % 2];
  const names = Object.keys(CLIENTS);
  const client = names[n % names.length];
  const own = Object.keys(OWNER).find((s) => OWNER[s] === CLIENTS[client].tenant);
  const other = Object.keys(OWNER).find((s) => s !== own);
  const steady = !inFault && now() - t0Load > SETTINGS.warmupMs;
  try {
    if (n % 25 === 0) {
      // cross-tenant attempt: must be refused
      const r = await call(inst, client, other, 'charge', { id: `x-${n}`, by: client, api_key: 'smuggled' });
      if (r.status === 200) { counts.crossAllowed++; violations.push(`cross-tenant call allowed: ${client} → ${other} (#${n})`); } else counts.crossRefused++;
      return;
    }
    if (HAS_DURABLE && n % 10 === 0) {
      const key = `d-${n}`;
      durableKeys.set(key, { server: own, client });
      counts.durableSubmitted++;
      for (let attempt = 0; attempt < 6; attempt++) {
        const target = instances[(n + attempt) % 2];
        try {
          const r = await fetch(`${target.base}/api/v1/features/task-graphs/run`, { method: 'POST', headers: { authorization: `Bearer ${CLIENTS[client].key}`, 'content-type': 'application/json', 'idempotency-key': key }, body: JSON.stringify({ graph: `pay-${own}`, input: { id: key, by: client } }), signal: AbortSignal.timeout(10_000) });
          if (r.status < 300) { durableKeys.get(key).runId = (await r.json()).runId; break; }
        } catch { /* retried below */ }
        counts.durableRetries++;
        await sleep(500 * (attempt + 1));
      }
      return;
    }
    const tool = n % 2 ? 'charge' : 'lookup';
    const id = `c-${n}`;
    if (tool === 'charge') charges.set(id, { client, server: own });
    const r = await call(inst, client, own, tool, { id, by: client });
    if (r.status === 200) {
      counts.ok++;
      lat.all.push(r.ms);
      if (steady) { counts.okSteady++; lat.steady.push(r.ms); }
      const echoed = JSON.parse(r.body?.result?.content?.[0]?.text ?? '{}');
      if (echoed.api_key !== SECRET[CLIENTS[client].tenant] || echoed.server !== own) { counts.leaks++; violations.push(`response leak: ${client} got ${JSON.stringify(echoed)} (#${n})`); }
    } else {
      counts.err++;
      if (steady) counts.errSteady++;
    }
  } catch {
    counts.err++;
    if (steady) counts.errSteady++;
  }
}
let t0Load = 0;
async function loadLoop(until) {
  t0Load = now();
  const interval = 1000 / SETTINGS.rps;
  let next = now();
  let active = 0;
  while (now() < until) {
    if (active < SETTINGS.concurrency) {
      active++;
      oneRequest().finally(() => { active--; });
      next += interval;
      const wait = next - now();
      if (wait > 0) await sleep(wait);
      else if (wait < -1000) next = now(); // overloaded: do not build an unbounded backlog
    } else await sleep(2);
  }
  while (active > 0) await sleep(20);
}

// ── faults ───────────────────────────────────────────────────────────────────────────────────────────────────────
async function okThrough(inst) {
  try { return (await call(inst, 'alice', 'acme-db', 'lookup', { id: 'probe' })).status === 200; } catch { return false; }
}
async function waitRecovered(insts, since, label) {
  for (;;) {
    const ok = await Promise.all(insts.map(okThrough));
    if (ok.every(Boolean)) return now() - since;
    if (now() - since > 120_000) { violations.push(`${label}: not recovered after 120 s`); return null; }
    await sleep(100);
  }
}
const FAULTS = [
  async function kill() {
    const a = instances[0];
    const t = now();
    a.proc.kill('SIGKILL');
    await new Promise((r) => a.proc.once('exit', r));
    await sleep(5000); // down for 5 s; B keeps serving
    const restartAt = now();
    await startInstance(a);
    const rec = await waitRecovered([a], restartAt, 'kill');
    faults.push({ kind: 'kill -9 instance A (down 5 s)', at: new Date(t).toISOString(), recoveryMs: rec, note: 'from restart to first successful call' });
  },
  async function partition() {
    const b = instances[1];
    const t = now();
    b.proxy.partition();
    await sleep(20_000);
    b.proxy.heal();
    const healAt = now();
    const rec = await waitRecovered([b], healAt, 'partition');
    faults.push({ kind: 'partition instance B ↔ Redis (20 s)', at: new Date(t).toISOString(), recoveryMs: rec, note: 'from heal to first successful call' });
  },
  async function redisRestart() {
    const t = now();
    redis.kill('SIGKILL');
    await new Promise((r) => redis.once('exit', r));
    await sleep(3000);
    await startRedis();
    const upAt = now();
    const rec = await waitRecovered(instances, upAt, 'redis restart');
    faults.push({ kind: 'Redis SIGKILL + restart (down 3 s, AOF)', at: new Date(t).toISOString(), recoveryMs: rec, note: 'from Redis up to both instances serving' });
  },
];
async function faultLoop(until) {
  let i = 0;
  await sleep(Math.min(SETTINGS.faultEveryMs, SETTINGS.warmupMs + 30_000));
  while (now() + 60_000 < until) {
    inFault = true;
    const fs0 = now();
    try { await FAULTS[i++ % FAULTS.length](); } catch (e) { violations.push(`fault ${i}: ${e.message}`); }
    await sleep(5000); // settle
    inFault = false;
    faultMs += now() - fs0;
    const wait = SETTINGS.faultEveryMs - 30_000;
    const end = Math.min(until - 60_000, now() + Math.max(wait, 10_000));
    while (now() < end) await sleep(1000);
  }
}

// ── memory sampling (instance B is never killed) ────────────────────────────────────────────────────────────────
const rss = [];
function rssMb(pid) {
  try {
    const m = /VmRSS:\s+(\d+) kB/.exec(readFileSync(`/proc/${pid}/status`, 'utf8'));
    return m ? Number(m[1]) / 1024 : undefined;
  } catch { return undefined; }
}
async function sampleLoop(until) {
  while (now() < until) {
    const b = rssMb(instances[1].proc.pid);
    if (b !== undefined) rss.push({ t: (now() - t0Load) / 3600e3, mb: b });
    await sleep(SETTINGS.sampleEveryMs);
  }
}
const slope = (pts) => {
  if (pts.length < 3) return null;
  const n = pts.length, sx = pts.reduce((a, p) => a + p.t, 0), sy = pts.reduce((a, p) => a + p.mb, 0);
  const sxx = pts.reduce((a, p) => a + p.t * p.t, 0), sxy = pts.reduce((a, p) => a + p.t * p.mb, 0);
  return (n * sxy - sx * sy) / (n * sxx - sx * sx);
};
const pct = (a, p) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return +s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))].toFixed(2); };

// ── run ──────────────────────────────────────────────────────────────────────────────────────────────────────────
async function main() {
  log(`soak: impl ${implVersion} (${IMPL}), ${JSON.stringify(SETTINGS)}, dir ${DIR}`);
  await startRedis();
  for (const name of ['A', 'B']) {
    const inst = { name, port: await freePort(), cfg: join(DIR, `gw-${name}.yml`), stderr: '', proxy: await faultProxy(redisPort) };
    inst.base = `http://127.0.0.1:${inst.port}`;
    await startInstance(inst);
    instances.push(inst);
  }
  log(`instances up: ${instances.map((i) => i.base).join(', ')}`);
  const until = now() + SETTINGS.durationMs;
  const progress = setInterval(() => log(`progress: ok ${counts.ok} err ${counts.err} p99 ${pct(lat.steady.slice(-5000), 99)} ms, faults ${faults.length}, violations ${violations.length}, rss B ${rss.at(-1)?.mb?.toFixed(1)} MB`), 60_000);
  await Promise.all([loadLoop(until), faultLoop(until), sampleLoop(until)]);
  clearInterval(progress);
  await sleep(SETTINGS.faultEveryMs > 0 ? 8000 : 2000); // durable runs finish

  // invariants on the ledger
  const ledger = existsSync(LEDGER) ? readFileSync(LEDGER, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
  const perId = new Map();
  for (const e of ledger) {
    perId.set(e.id, (perId.get(e.id) ?? 0) + 1);
    if (e.api_key !== SECRET[OWNER[e.server]]) violations.push(`upstream ${e.server} received ${e.api_key ? 'another tenant\'s / no' : 'no'} secret for ${e.id}`);
    if (String(e.id).startsWith('x-')) violations.push(`cross-tenant call reached upstream: ${e.id}`);
    const c = charges.get(e.id) ?? durableKeys.get(e.id);
    if (c && c.server !== e.server) violations.push(`call ${e.id} of ${c.client} executed on ${e.server}`);
  }
  const dup = [...perId].filter(([, n]) => n > 1);
  for (const [id, n] of dup.slice(0, 20)) violations.push(`non-idempotent call ${id} executed ${n} times`);
  let durableDone = 0, durableMissing = 0;
  if (HAS_DURABLE) {
    for (const [key, d] of durableKeys) {
      if (perId.get(key) === 1) durableDone++;
      else if (!perId.get(key)) {
        // not executed: acceptable only if the run is not succeeded (e.g. dead-lettered as outcome_unknown)
        let st;
        for (const inst of instances) {
          try { st = d.runId && (await (await fetch(`${inst.base}/api/v1/features/task-graphs/runs/${d.runId}`, { headers: { authorization: `Bearer ${CLIENTS[d.client].key}` } })).json()).status; } catch { /* next */ }
          if (st) break;
        }
        if (st === 'succeeded') violations.push(`durable run ${key} succeeded without an execution`);
        durableMissing++;
      }
    }
  }
  const steadySeconds = Math.max(1, (SETTINGS.durationMs - SETTINGS.warmupMs - faultMs) / 1000);
  const report = {
    harness: 'scripts/soak.mjs (14.9.0)', impl: implVersion, startedAt: new Date(t0Load).toISOString(), settings: SETTINGS, machine: { cpus: (await import('node:os')).cpus().length, arch: process.arch, node: process.version },
    throughput: { okPerSecond: +(counts.ok / (SETTINGS.durationMs / 1000)).toFixed(2), steadyOkPerSecond: +(counts.okSteady / steadySeconds).toFixed(2) },
    latencyMs: { all: { p50: pct(lat.all, 50), p95: pct(lat.all, 95), p99: pct(lat.all, 99) }, steady: { p50: pct(lat.steady, 50), p95: pct(lat.steady, 95), p99: pct(lat.steady, 99) } },
    errors: { total: counts.err, steady: counts.errSteady, rate: +(counts.err / Math.max(1, counts.ok + counts.err)).toFixed(4), steadyRate: +(counts.errSteady / Math.max(1, counts.okSteady + counts.errSteady)).toFixed(4) },
    memory: { instance: 'B (never killed)', firstMb: rss[0]?.mb ?? null, lastMb: rss.at(-1)?.mb ?? null, maxMb: rss.length ? Math.max(...rss.map((r) => r.mb)) : null, growthMbPerHour: slope(rss.filter((r) => r.t * 3600e3 > SETTINGS.warmupMs)) },
    faults,
    recoveryMs: Object.fromEntries(['kill', 'partition', 'Redis'].map((k) => { const xs = faults.filter((f) => f.kind.includes(k) && f.recoveryMs != null).map((f) => f.recoveryMs); return [k, xs.length ? { max: Math.max(...xs), mean: Math.round(xs.reduce((a, b) => a + b, 0) / xs.length), n: xs.length } : null]; })),
    invariants: { crossTenantAttempts: counts.crossRefused + counts.crossAllowed, crossTenantAllowed: counts.crossAllowed, responseLeaks: counts.leaks, ledgerEntries: ledger.length, duplicateExecutions: dup.length, durable: HAS_DURABLE ? { submitted: counts.durableSubmitted, executedOnce: durableDone, notExecuted: durableMissing, clientRetries: counts.durableRetries } : 'n/a (< 14.4)' },
    violations,
    pass: violations.length === 0,
  };
  if (BASELINE && existsSync(BASELINE)) {
    const b = JSON.parse(readFileSync(BASELINE, 'utf8'));
    const d = (x, y) => (x == null || y == null ? null : +(((x - y) / y) * 100).toFixed(1));
    report.vsBaseline = {
      baseline: { impl: b.impl, settings: b.settings, startedAt: b.startedAt },
      sameSettings: JSON.stringify({ ...b.settings, durationMs: 0 }) === JSON.stringify({ ...SETTINGS, durationMs: 0 }),
      p95SteadyPct: d(report.latencyMs.steady.p95, b.latencyMs.steady.p95),
      p99SteadyPct: d(report.latencyMs.steady.p99, b.latencyMs.steady.p99),
      throughputSteadyPct: d(report.throughput.steadyOkPerSecond, b.throughput.steadyOkPerSecond),
      memoryGrowthMbPerHour: { run: report.memory.growthMbPerHour, baseline: b.memory.growthMbPerHour },
      recoveryMaxMs: Object.fromEntries(Object.keys(report.recoveryMs).map((k) => [k, { run: report.recoveryMs[k]?.max ?? null, baseline: b.recoveryMs?.[k]?.max ?? null }])),
    };
  }
  writeFileSync(OUT, JSON.stringify(report, null, 2));
  log(`report → ${OUT}: pass=${report.pass} p95 ${report.latencyMs.steady.p95} p99 ${report.latencyMs.steady.p99} ms, ${report.throughput.steadyOkPerSecond}/s, rss +${report.memory.growthMbPerHour?.toFixed?.(2)} MB/h, violations ${violations.length}`);
  return report.pass;
}

let code = 1;
try {
  code = (await main()) ? 0 : 1;
} catch (e) {
  log(`soak failed: ${e.stack ?? e}`);
} finally {
  for (const i of instances) { try { i.proc.kill('SIGTERM'); } catch { /* gone */ } i.proxy.close(); }
  try { redis?.kill('SIGKILL'); } catch { /* gone */ }
  setTimeout(() => process.exit(code), 1500).unref();
}
