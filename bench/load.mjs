#!/usr/bin/env node
/**
 * Reproducible long-running concurrent load harness (13.3.0) for the BUILT gateway (`npm run build` first).
 *
 *   node bench/load.mjs [--profile ci|long] [--seed 42] [--concurrency 16] [--requests 4000] [--faults]
 *                       [--store memory|redis] [--json] [--compare bench/baseline.json] [--write bench/baseline.json]
 *
 * One in-process gateway in front of three controllable upstreams (bench/lib/upstreams.mjs):
 *  - `h`  Streamable HTTP, with one replica (round-robin, failover on not-connected + timeout, ejection);
 *  - `s`  a stdio child process;
 * and every reliability-relevant module in the hot path: API-key auth, rate limit, response cache, quotas, budgets,
 * policy rules, optionally the Redis store (fake RESP server). N workers send a FIXED number of requests; each worker
 * draws its operations from its own seeded PRNG (mulberry32(seed + worker)), so two runs send the same sequence:
 *
 *   echo@h 40 % · echo@s 25 % · cached@h 15 % · slow@h (5–20 ms) 10 % · fail@s 5 % (expected error) · priced@h 5 %
 *
 * Window accounting uses the time a request was SENT: a call sent during a fault counts to that fault even when it
 * completes (times out) after the fault cleared. A window counts only calls to the server it faulted, and its
 * after-recovery phase (from 300 ms after the fault cleared) ends when the next fault starts; faults never overlap
 * (the next one waits until the previous cleared 1.5 s ago). The fault run sends twice the profile's requests.
 *
 * Note on memory: the gateway keeps a bounded request history (monitor, 100k records) — heap grows while it fills;
 * the growth numbers include it, which is why they are compared with a generous margin.
 *
 * Reported: requests/s, latency mean / p50 / p95 / p99 / max (overall and per operation), unexpected-error rate,
 * RSS / heap (start, end after GC, peak, growth per 10k requests), event-loop delay p99, upstream TCP connections
 * opened (keep-alive pool) and sessions, failovers / resends / recycles from the gateway's telemetry.
 *
 * --faults injects, at fixed request counts (deterministic, not wall-clock): the `h` replica killed for 1 s, the
 * stdio child stalled for 1 s, `h` forgetting its sessions; each window reports its errors, the recovery time after
 * the fault clears, and the error rate after recovery (must be 0).
 *
 * --compare exits 1 only on a gross, unjustified regression against `bench/baseline.json` → `load.platforms[<os-arch>]`
 * (p50 / p95 / p99 > 3× + 15 ms, unexpected errors > baseline + 0.5 pp, heap growth > 2× + 8 MiB per 10k requests,
 * upstream connections > 2× + 8, throughput < ⅓). A deliberate change is justified by updating the baseline in the
 * same PR with a `justification` note. Without a baseline for this platform the comparison is report-only.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { cpus } from 'node:os';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = process.env.MGW_ROOT ?? join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const arg = (n, d) => {
  const i = args.indexOf(n);
  return i >= 0 ? args[i + 1] : d;
};

// GC must be exposed for honest heap numbers: re-run self with --expose-gc
if (typeof globalThis.gc !== 'function') {
  const r = spawnSync(process.execPath, ['--expose-gc', fileURLToPath(import.meta.url), ...args], { stdio: 'inherit', env: process.env });
  process.exit(r.status ?? 1);
}

const PROFILES = {
  ci: { requests: 4000, concurrency: 16 },
  long: { requests: 60000, concurrency: 32 },
};
const profileName = arg('--profile', 'ci');
const profile = PROFILES[profileName] ?? PROFILES.ci;
const seed = Number(arg('--seed', 42));
const concurrency = Number(arg('--concurrency', profile.concurrency));
const withFaults = flag('--faults');
// the fault run needs room for three spaced-out windows: twice the profile's request count by default
const total = Number(arg('--requests', withFaults ? profile.requests * 2 : profile.requests));
const storeKind = arg('--store', 'memory');

const { Gateway, logger } = await import(join(root, 'dist/gateway/public.js'));
const { validateConfig } = await import(join(root, 'dist/config/loader.js'));
const U = await import(join(root, 'bench/lib/upstreams.mjs'));
logger.setLevel('error');

function mulberry32(a) {
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const MIX = [
  ['echo@h', 40],
  ['echo@s', 25],
  ['cached@h', 15],
  ['slow@h', 10],
  ['fail@s', 5],
  ['priced@h', 5],
];
const MIX_TOTAL = MIX.reduce((n, [, w]) => n + w, 0);
function pick(rnd) {
  let x = rnd() * MIX_TOTAL;
  for (const [op, w] of MIX) if ((x -= w) < 0) return op;
  return MIX[0][0];
}

const pct = (sorted, p) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))] : 0);
const r2 = (n) => Math.round(n * 100) / 100;
const mb = (b) => r2(b / 1048576);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const H = await U.startHttpUpstream({ tag: 'h' });
  const H2 = await U.startHttpUpstream({ tag: 'h2' });
  const redis = storeKind === 'redis' ? await U.startFakeRedis() : undefined;
  const KEY = 'bench-key-'.padEnd(40, 'x');
  const cfg = validateConfig({
    version: 11,
    monitor: { requestLog: false },
    servers: [
      { id: 'h', name: 'h', transport: 'streamable-http', url: H.url, timeoutMs: 2000, reconnect: { initialDelayMs: 200, maxDelayMs: 1000, jitter: 0 }, replicas: [{ url: H2.url }], loadBalancing: { strategy: 'round-robin', failoverOn: ['not-connected', 'timeout'], ejectAfter: 3, ejectMs: 1000 } },
      { id: 's', name: 's', transport: 'stdio', command: process.execPath, args: [U.STDIO_SERVER], timeoutMs: 2000, reconnect: { initialDelayMs: 200, maxDelayMs: 1000, jitter: 0 } },
    ],
    rateLimit: { limit: 10_000_000, windowSeconds: 60 },
    cache: { rules: [{ tools: ['cached'], ttlSeconds: 60, scope: 'shared' }] },
    quotas: { rules: [{ name: 'q', limit: 100_000_000, period: 'day' }] },
    costs: { tools: [{ match: 'h/priced', perCall: 0.0001 }], budgets: [{ name: 'b', period: 'day', limit: 1_000_000, action: 'block' }] },
    policy: { rules: [{ name: 'no-admin', tools: ['admin_*'], effect: 'deny' }] },
    ...(redis ? { store: { backend: 'redis', redis: { url: redis.url, commandTimeoutMs: 1000 } } } : {}),
  });
  const gw = new Gateway({ ...cfg, port: 0, host: '127.0.0.1', logLevel: 'error', auth: { strategy: 'api-key', apiKeys: [{ name: 'bench', key: KEY }] } });
  await gw.start();
  const base = `http://127.0.0.1:${gw.address().port}/api/v1/tools/call`;
  const headers = { 'content-type': 'application/json', authorization: `Bearer ${KEY}` };

  const doCall = async (op, rnd) => {
    const [tool, server] = op.split('@');
    const a = tool === 'slow' ? { ms: 5 + Math.floor(rnd() * 16) } : tool === 'cached' ? { q: Math.floor(rnd() * 20) } : { n: Math.floor(rnd() * 1000) };
    const t = performance.now();
    let status = 0;
    try {
      const res = await fetch(base, { method: 'POST', headers, body: JSON.stringify({ server, tool, arguments: a }), signal: AbortSignal.timeout(10_000) });
      status = res.status;
      await res.arrayBuffer();
    } catch {
      status = 0;
    }
    const ms = performance.now() - t;
    const expectedError = tool === 'fail';
    const ok = expectedError ? status >= 400 && status !== 0 : status === 200;
    return { op, ms, status, ok, expectedError };
  };

  // warm-up (not measured): connections, JIT, sessions
  {
    const rnd = mulberry32(seed ^ 0x9e3779b9);
    await Promise.all(Array.from({ length: Math.min(concurrency, 8) }, async () => {
      for (let i = 0; i < 25; i++) await doCall(pick(rnd), rnd);
    }));
  }
  const conn0 = { h: H.stats().connections, h2: H2.stats().connections };
  const tele0 = telemetrySnapshot(gw);
  gc();
  gc();
  const mem0 = process.memoryUsage();
  const eld = monitorEventLoopDelay({ resolution: 10 });
  eld.enable();
  let rssPeak = mem0.rss;
  let heapPeak = mem0.heapUsed;
  const sampler = setInterval(() => {
    const m = process.memoryUsage();
    rssPeak = Math.max(rssPeak, m.rss);
    heapPeak = Math.max(heapPeak, m.heapUsed);
  }, 100);

  // ── fault plan (deterministic: by request count) ──
  const faults = [];
  let stdioPid;
  let sent = 0;
  const windows = [];
  if (withFaults) {
    const at = (frac) => Math.floor(total * frac);
    faults.push(
      { at: at(0.25), server: 'h', name: 'http-replica-killed-1s', start: () => H2.down(), stop: () => H2.up() },
      { at: at(0.5), server: 's', name: 'stdio-child-stalled-1s', start: async () => (stdioPid = await stdioPidOf(gw)) && process.kill(stdioPid, 'SIGUSR1'), stop: () => stdioPid && process.kill(stdioPid, 'SIGUSR1') },
      { at: at(0.75), server: 'h', name: 'http-sessions-forgotten', start: () => H.forgetSessions(), stop: () => undefined, instant: true },
    );
  }
  const fired = new Set();
  const maybeFault = () => {
    for (const f of faults) {
      if (fired.has(f.name) || sent < f.at) continue;
      // never overlap two faults: the next one waits until the previous cleared 1.5 s ago
      const prev = windows[windows.length - 1];
      if (prev && (!prev.clearedAt || performance.now() - prev.clearedAt < 1500)) return;
      fired.add(f.name);
      const w = { name: f.name, server: f.server, startedAt: performance.now(), clearedAt: 0, errors: 0, calls: 0, recoveredMs: -1, afterErrors: 0, afterCalls: 0 };
      windows.push(w);
      void Promise.resolve(f.start()).then(async () => {
        if (!f.instant) await sleep(1000);
        await f.stop();
        w.clearedAt = performance.now();
      });
    }
  };

  const results = [];
  let heapMid = 0;
  const t0 = performance.now();
  const perWorker = Math.ceil(total / concurrency);
  await Promise.all(
    Array.from({ length: concurrency }, async (_, wi) => {
      const rnd = mulberry32(seed + wi + 1);
      for (let i = 0; i < perWorker && sent < total; i++) {
        sent++;
        maybeFault();
        if (sent === Math.floor(total / 2)) {
          gc();
          heapMid = process.memoryUsage().heapUsed;
        }
        const sentAt = performance.now();
        const r = await doCall(pick(rnd), rnd);
        r.at = sentAt;
        results.push(r);
        for (let k = 0; k < windows.length; k++) {
          const w = windows[k];
          // a window only counts calls to the server it faulted, and its "after recovery" phase ends where the
          // next fault starts (otherwise the next fault's errors are charged to the previous one)
          if (r.op.split('@')[1] !== w.server) continue;
          const next = windows[k + 1];
          if (next && r.at >= next.startedAt) continue;
          if (!w.clearedAt || r.at <= w.clearedAt) {
            w.calls++;
            if (!r.ok) w.errors++;
          } else {
            if (w.recoveredMs < 0 && r.ok) w.recoveredMs = r2(r.at - w.clearedAt);
            if (r.at - w.clearedAt > 300) {
              w.afterCalls++;
              if (!r.ok) w.afterErrors++;
            }
          }
        }
      }
    }),
  );
  const elapsed = performance.now() - t0;
  clearInterval(sampler);
  eld.disable();
  await sleep(50);
  gc();
  gc();
  const mem1 = process.memoryUsage();
  const tele1 = telemetrySnapshot(gw);

  const summarize = (rs) => {
    const s = rs.map((r) => r.ms).sort((a, b) => a - b);
    return { count: s.length, meanMs: r2(s.reduce((a, b) => a + b, 0) / (s.length || 1)), p50Ms: r2(pct(s, 0.5)), p95Ms: r2(pct(s, 0.95)), p99Ms: r2(pct(s, 0.99)), maxMs: r2(s[s.length - 1] ?? 0) };
  };
  const unexpected = results.filter((r) => !r.ok);
  const byStatus = {};
  for (const r of unexpected) byStatus[r.status] = (byStatus[r.status] ?? 0) + 1;
  const perOp = {};
  for (const [op] of MIX) perOp[op] = summarize(results.filter((r) => r.op === op));
  const report = {
    tool: 'bench/load.mjs',
    version: JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version,
    node: process.version,
    platform: `${process.platform}-${process.arch}`,
    cpus: cpus().length,
    profile: profileName,
    seed,
    concurrency,
    requests: results.length,
    store: storeKind,
    faults: withFaults,
    rps: r2(results.length / (elapsed / 1000)),
    latency: summarize(results),
    perOp,
    errors: { unexpected: unexpected.length, rate: r2((unexpected.length / results.length) * 100), byStatus },
    memory: {
      rssStartMb: mb(mem0.rss),
      rssEndMb: mb(mem1.rss),
      rssPeakMb: mb(rssPeak),
      heapStartMb: mb(mem0.heapUsed),
      heapEndMb: mb(mem1.heapUsed),
      heapPeakMb: mb(heapPeak),
      heapGrowthPer10kMb: r2((mb(mem1.heapUsed - mem0.heapUsed) / results.length) * 10_000),
      // second half only (after the warm caches / pools of the first half); includes the bounded request history
      heapGrowthSecondHalfPer10kMb: heapMid ? r2((mb(mem1.heapUsed - heapMid) / (results.length / 2)) * 10_000) : null,
    },
    eventLoopDelayP99Ms: r2(eld.percentile(99) / 1e6),
    pool: { upstreamConnections: H.stats().connections - conn0.h + (H2.stats().connections - conn0.h2), openSockets: H.stats().openSockets + H2.stats().openSockets, sessions: H.stats().sessions + H2.stats().sessions },
    retries: { failovers: tele1.failovers - tele0.failovers, resends: tele1.resends - tele0.resends, recycles: tele1.recycles - tele0.recycles },
    ...(withFaults ? { faultWindows: windows.map((w) => ({ name: w.name, server: w.server, calls: w.calls, errors: w.errors, recoveredMs: w.recoveredMs, afterRecovery: { calls: w.afterCalls, errors: w.afterErrors } })) } : {}),
  };
  await gw.stop();
  await H.close();
  await H2.close();
  await redis?.close();
  return report;
}

function telemetrySnapshot(gw) {
  const t = gw.telemetry;
  const sum = (c) => (c ? c.series().reduce((n, s) => n + s.value, 0) : 0);
  return { failovers: sum(t?.failovers), resends: sum(t?.resends), recycles: gw.recycles ?? 0 };
}

async function stdioPidOf(gw) {
  // the stdio child's pid, from an echo through the gateway (the fixture reports it)
  const r = await gw.invoker.invoke({ serverId: 's', name: 'echo', kind: 'tool', method: 'tools/call', params: {}, clientId: 'bench', principal: { id: 'bench', kind: 'client' }, via: 'rest' }).catch(() => undefined);
  try {
    return JSON.parse(r?.result?.content?.[0]?.text ?? '{}').pid;
  } catch {
    return undefined;
  }
}

const report = await main();

// ── compare / write ──
const cmp = arg('--compare');
let failed = false;
const lines = [];
if (cmp) {
  const file = JSON.parse(readFileSync(join(root, cmp), 'utf8'));
  const key = `${report.profile}${report.faults ? '+faults' : ''}`;
  const b = file.load?.platforms?.[report.platform]?.[key];
  lines.push(`load ${key} · ${report.platform} · Node ${report.node} · ${report.requests} requests @ ${report.concurrency} · seed ${report.seed}`);
  if (!b) lines.push(`(no ${report.platform} "${key}" load baseline recorded: report-only)`);
  lines.push('| metric | value | baseline | limit |', '|---|---:|---:|---:|');
  const check = (name, v, bv, limit, bad) => {
    lines.push(`| ${name} | ${v} | ${bv ?? ''} | ${bv === undefined ? '' : r2(limit)} |`);
    if (bv !== undefined && bad) {
      failed = true;
      lines.push(`  ↑ regression: ${name}`);
    }
  };
  for (const k of ['p50Ms', 'p95Ms', 'p99Ms']) {
    const bv = b?.latency?.[k];
    const lim = bv === undefined ? 0 : bv * 3 + 15;
    check(`latency.${k}`, report.latency[k], bv, lim, bv !== undefined && report.latency[k] > lim);
  }
  {
    const bv = b?.errors?.rate;
    check('errors.rate %', report.errors.rate, bv, (bv ?? 0) + 0.5, bv !== undefined && report.errors.rate > bv + 0.5);
  }
  {
    const bv = b?.memory?.heapGrowthPer10kMb;
    const lim = bv === undefined ? 0 : Math.max(0, bv) * 2 + 8;
    check('memory.heapGrowthPer10kMb', report.memory.heapGrowthPer10kMb, bv, lim, bv !== undefined && report.memory.heapGrowthPer10kMb > lim);
  }
  {
    const bv = b?.pool?.upstreamConnections;
    const lim = bv === undefined ? 0 : bv * 2 + 8;
    check('pool.upstreamConnections', report.pool.upstreamConnections, bv, lim, bv !== undefined && report.pool.upstreamConnections > lim);
  }
  {
    const bv = b?.rps;
    const lim = bv === undefined ? 0 : bv / 3;
    check('rps (min)', report.rps, bv, lim, bv !== undefined && report.rps < lim);
  }
  if (report.faultWindows) {
    if (report.faultWindows.length < 3) {
      failed = true;
      lines.push(`  ↑ only ${report.faultWindows.length} of 3 faults fired (raise --requests)`);
    }
    for (const w of report.faultWindows) {
      const bad = w.afterRecovery.errors > 0 || w.recoveredMs < 0 || w.recoveredMs > 5000;
      lines.push(`| fault ${w.name}: errors ${w.errors}/${w.calls}, recovered ${w.recoveredMs} ms, after ${w.afterRecovery.errors}/${w.afterRecovery.calls} | | | must recover ≤ 5 s, 0 errors after |`);
      if (bad) failed = true;
    }
  }
  if (b?.justification) lines.push(`baseline note: ${b.justification}`);
}
const out = arg('--write');
if (out) {
  const p = join(root, out);
  const file = JSON.parse(readFileSync(p, 'utf8'));
  const key = `${report.profile}${report.faults ? '+faults' : ''}`;
  file.load ??= { note: 'bench/load.mjs baselines, per platform and profile (13.3.0)', platforms: {} };
  file.load.platforms[report.platform] ??= {};
  file.load.platforms[report.platform][key] = { ...report, recordedAt: new Date().toISOString() };
  writeFileSync(p, JSON.stringify(file, null, 2) + '\n');
}
if (flag('--json') || !cmp) console.log(JSON.stringify(report, null, 2));
if (lines.length) console.log(lines.join('\n'));
if (failed) {
  console.error('Load benchmark: regression against the recorded baseline (see table).');
  process.exit(1);
}
