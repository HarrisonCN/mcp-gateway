#!/usr/bin/env node
/**
 * Per-module performance cost report (13.8.0) for the BUILT gateway (`npm run build` first).
 *
 *   node scripts/module-costs.mjs [--calls 400] [--rounds 3] [--json docs/perf/module-costs.json] [--md docs/perf/module-costs.md]
 *
 * For each of the feature modules in the manifest (src/features/manifest.ts):
 *  - import cost: a fresh Node process loads the gateway core and the module's dependencies, then evaluates the module
 *    and reports the time and heap that import added (median of `--rounds`);
 *  - call-path cost, for modules that register a call hook: an in-process gateway in front of one HTTP upstream, with
 *    nothing but that module activated (its config section with defaults, `{}`), sends `--calls` sequential REST tool
 *    calls; the module's added latency (p50 / p99) and heap allocation per call are the difference with a gateway
 *    without features, measured interleaved (baseline, module, baseline, ...) and taken as medians over `--rounds`.
 *    Allocation per call = heap growth over the measured calls with GC exposed and a 64 MiB young generation (so no
 *    scavenge runs in between), divided by the call count. Approximate: it includes what the upstream client allocates.
 *    A module whose section does not validate with defaults, or that does not become active with them, is reported as
 *    `not-activated` (its cost with a real config is not measured here).
 *  - modules without a call hook are `not-on-call-path`: they add no per-call work by construction.
 *
 * Numbers depend on the machine; the CI job "Module cost report" (non-required) runs this on every PR and uploads the
 * JSON; the committed docs/perf/module-costs.{md,json} are a reference run (see `machine` in the JSON).
 */
import { spawnSync } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import { cpus } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = process.env.MGW_ROOT ?? join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const arg = (n, d) => {
  const i = args.indexOf(n);
  return i >= 0 ? args[i + 1] : d;
};

if (typeof globalThis.gc !== 'function' && !args.includes('--import-probe')) {
  const r = spawnSync(process.execPath, ['--expose-gc', '--max-semi-space-size=64', fileURLToPath(import.meta.url), ...args], { stdio: 'inherit', env: process.env });
  process.exit(r.status ?? 1);
}

const dist = join(root, 'dist');

// ── child mode: import cost of one module ──
if (args.includes('--import-probe')) {
  const id = arg('--import-probe');
  const { FEATURE_MANIFEST } = await import(join(dist, 'features/manifest.js'));
  const byId = new Map(FEATURE_MANIFEST.map((e) => [e.id, e]));
  const deps = [];
  const walk = (x) => {
    for (const d of byId.get(x)?.dependsOn ?? []) walk(d);
    if (x !== id && !deps.includes(x)) deps.push(x);
  };
  walk(id);
  // the gateway core (and everything modules share with it) is loaded first: the cost below is the module's own
  await import(join(dist, 'gateway/public.js'));
  for (const d of deps) await byId.get(d).load();
  globalThis.gc?.();
  const h0 = process.memoryUsage().heapUsed;
  const t0 = performance.now();
  await byId.get(id).load();
  const ms = performance.now() - t0;
  globalThis.gc?.();
  process.stdout.write(JSON.stringify({ ms, heapKb: (process.memoryUsage().heapUsed - h0) / 1024 }));
  process.exit(0);
}

const CALLS = Number(arg('--calls', 400));
const ROUNDS = Number(arg('--rounds', 3));
const jsonOut = arg('--json');
const mdOut = arg('--md');

const { FEATURE_MANIFEST } = await import(join(dist, 'features/manifest.js'));
const { Gateway, logger } = await import(join(dist, 'gateway/public.js'));
const { validateConfig } = await import(join(dist, 'config/loader.js'));
const U = await import(join(root, 'bench/lib/upstreams.mjs'));
logger.setLevel('error');

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.floor((s.length - 1) / 2)] : 0;
};
const pct = (s, p) => s[Math.min(s.length - 1, Math.max(0, Math.ceil(p * s.length) - 1))];
const r3 = (n) => Math.round(n * 1000) / 1000;

function importCost(id) {
  const ms = [];
  const kb = [];
  for (let i = 0; i < ROUNDS; i++) {
    const r = spawnSync(process.execPath, ['--expose-gc', fileURLToPath(import.meta.url), '--import-probe', id], { encoding: 'utf8', env: { ...process.env, MGW_ROOT: root } });
    try {
      const j = JSON.parse(r.stdout);
      ms.push(j.ms);
      kb.push(j.heapKb);
    } catch {
      return { ms: -1, heapKb: -1, error: (r.stderr || '').split('\n')[0] };
    }
  }
  return { ms: r3(median(ms)), heapKb: Math.round(median(kb)) };
}

const KEY = 'module-cost-key-'.padEnd(40, 'x');
const up = await U.startHttpUpstream({ tag: 'h' });

async function measure(features) {
  let cfg;
  try {
    cfg = validateConfig({ version: 11, monitor: { requestLog: false }, servers: [{ id: 'h', name: 'h', transport: 'streamable-http', url: up.url, timeoutMs: 5000 }], ...(features ? { features } : {}) });
  } catch (e) {
    return { invalid: String(e.message ?? e).split('\n')[0] };
  }
  const gw = new Gateway({ ...cfg, port: 0, host: '127.0.0.1', logLevel: 'error', auth: { strategy: 'api-key', apiKeys: [{ name: 'mc', key: KEY }] } });
  await gw.start();
  try {
    const states = (gw.featureRouter?.modules?.() ?? []).filter((m) => m.state === 'active' || m.state === 'failed').map((m) => ({ id: m.id, state: m.state }));
    const url = `http://127.0.0.1:${gw.address().port}/api/v1/tools/call`;
    const headers = { 'content-type': 'application/json', authorization: `Bearer ${KEY}` };
    const call = async (i) => {
      const t = performance.now();
      const r = await fetch(url, { method: 'POST', headers, body: JSON.stringify({ server: 'h', tool: 'echo', arguments: { n: i } }) });
      await r.arrayBuffer();
      return { ms: performance.now() - t, status: r.status };
    };
    for (let i = 0; i < 60; i++) await call(i);
    globalThis.gc();
    globalThis.gc();
    const h0 = process.memoryUsage().heapUsed;
    const lat = [];
    let errors = 0;
    for (let i = 0; i < CALLS; i++) {
      const r = await call(i);
      lat.push(r.ms);
      if (r.status !== 200) errors++;
    }
    const allocKb = (process.memoryUsage().heapUsed - h0) / 1024 / CALLS;
    lat.sort((a, b) => a - b);
    return { states, p50: pct(lat, 0.5), p99: pct(lat, 0.99), allocKb, errors };
  } finally {
    await gw.stop();
  }
}

const results = [];
const baselines = [];
const t0 = Date.now();
for (const e of FEATURE_MANIFEST) {
  const imp = importCost(e.id);
  const section = e.hook ? (e.activation?.[0] ?? e.hookWhen) : undefined;
  let callInfo;
  if (!e.hook) callInfo = { status: 'not-on-call-path' };
  else if (!section) callInfo = { status: 'not-activated', note: 'no config section activates the hook' };
  else {
    const mod = [];
    const base = [];
    let note;
    for (let i = 0; i < ROUNDS && !note; i++) {
      const b = await measure(undefined);
      base.push(b);
      baselines.push(b);
      const m = await measure({ [section]: {} });
      if (m.invalid) note = `features.${section}: {} does not validate (${m.invalid})`;
      else if (!m.states.some((s) => s.id === e.id && s.state === 'active')) note = `features.${section}: {} does not activate the module${m.states.find((s) => s.id === e.id)?.state === 'failed' ? ' (failed)' : ''}`;
      else mod.push(m);
    }
    if (note) callInfo = { status: 'not-activated', section, note };
    else {
      const d = (k) => r3(median(mod.map((m) => m[k])) - median(base.map((b) => b[k])));
      callInfo = {
        status: 'measured',
        section,
        addedP50Ms: d('p50'),
        addedP99Ms: d('p99'),
        addedAllocKbPerCall: r3(median(mod.map((m) => m.allocKb)) - median(base.map((b) => b.allocKb))),
        p50Ms: r3(median(mod.map((m) => m.p50))),
        p99Ms: r3(median(mod.map((m) => m.p99))),
        errors: mod.reduce((n, m) => n + m.errors, 0),
      };
    }
  }
  results.push({ id: e.id, since: e.since, hook: e.hook ?? null, failurePolicy: e.failurePolicy ?? null, import: imp, call: callInfo });
  process.stderr.write(`${e.id}: import ${imp.ms} ms · ${callInfo.status}${callInfo.status === 'measured' ? ` +p50 ${callInfo.addedP50Ms} ms +p99 ${callInfo.addedP99Ms} ms +${callInfo.addedAllocKbPerCall} KiB/call` : ''}\n`);
}
await up.down();

const ver = (await import(join(dist, 'utils/version.js'))).VERSION;
const bl = baselines.filter((b) => b.p50 !== undefined);
const report = {
  version: ver,
  generatedAt: new Date().toISOString(),
  machine: { node: process.version, platform: `${process.platform}-${process.arch}`, cpus: cpus().length, cpuModel: cpus()[0]?.model },
  method: { callsPerRun: CALLS, rounds: ROUNDS, concurrency: 1, tool: 'echo over Streamable HTTP (REST /api/v1/tools/call)', allocation: 'heap growth / calls, --expose-gc --max-semi-space-size=64' },
  baseline: bl.length ? { p50Ms: r3(median(bl.map((b) => b.p50))), p99Ms: r3(median(bl.map((b) => b.p99))), allocKbPerCall: r3(median(bl.map((b) => b.allocKb))) } : null,
  durationSeconds: Math.round((Date.now() - t0) / 1000),
  modules: results,
};

if (jsonOut) {
  mkdirSync(dirname(jsonOut), { recursive: true });
  writeFileSync(jsonOut, JSON.stringify(report, null, 2) + '\n');
}
const lines = [
  '# Feature module costs',
  '',
  `Generated by \`node scripts/module-costs.mjs\` (13.8.0) — gateway ${report.version}, Node ${report.machine.node}, ${report.machine.platform}, ${report.machine.cpus} CPU. Machine-dependent: compare rows with each other, and runs on the same machine with each other. The CI job \`Module cost report\` (non-required) regenerates it on every PR (artifact \`module-costs\`).`,
  '',
  `Method: per module, an in-process gateway with only that module activated (\`features.<section>: {}\`) answers ${CALLS} sequential REST \`echo\` calls to one Streamable HTTP upstream; **added** = module run − gateway without features, medians over ${ROUNDS} interleaved rounds. Import = time / heap to evaluate the module in a fresh process (after its dependencies). Small negative values are noise.`,
  '',
  report.baseline ? `Baseline (no feature modules): p50 ${report.baseline.p50Ms} ms · p99 ${report.baseline.p99Ms} ms · ${report.baseline.allocKbPerCall} KiB allocated per call.` : '',
  '',
  '| Module | Since | Call hook | Import ms | Import heap KiB | Call path | +p50 ms | +p99 ms | +KiB / call |',
  '|---|---|---|---:|---:|---|---:|---:|---:|',
  ...results.map((m) => `| \`${m.id}\` | ${m.since} | ${m.hook ? `\`${m.hook}\`` : '—'} | ${m.import.ms} | ${m.import.heapKb} | ${m.call.status}${m.call.status === 'not-activated' && m.call.section ? ` (\`${m.call.section}\`)` : ''} | ${m.call.addedP50Ms ?? '—'} | ${m.call.addedP99Ms ?? '—'} | ${m.call.addedAllocKbPerCall ?? '—'} |`),
  '',
  '`not-on-call-path`: the module registers no call hook, so it adds no per-call work. `not-activated`: its section needs real settings (it does not activate with defaults), so its call cost is not measured here — measure it with your own config (`bench/load.mjs`).',
  '',
];
if (mdOut) {
  mkdirSync(dirname(mdOut), { recursive: true });
  writeFileSync(mdOut, lines.join('\n'));
}
if (!jsonOut && !mdOut) process.stdout.write(JSON.stringify(report, null, 2) + '\n');
process.exit(0);
