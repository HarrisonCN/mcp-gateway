#!/usr/bin/env node
/**
 * Kernel benchmark (12.0): cold start time, memory and evaluated feature modules of the BUILT gateway (dist/).
 *
 *   node bench/kernel.mjs [--runs 5] [--json] [--compare bench/baseline.json] [--write bench/baseline.json]
 *
 * Each sample is a fresh `node --expose-gc` process that imports dist/gateway/index.js, starts a gateway on an
 * ephemeral port (no upstream servers) and reports: import ms, start ms, total ms, RSS / heap after GC, and how many
 * dist/features/*.js modules were evaluated (module-load tracing via module.registerHooks). Two profiles:
 * `minimal` (no features configured) and `all` (every feature section that validates with an empty object).
 *
 * --compare prints the delta against a recorded baseline and exits 1 only on a gross regression (> 2× the baseline
 * median for time, > 1.5× for memory) — CI runners are noisy, so the numbers are recorded, not tightly asserted.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const arg = (n, d) => {
  const i = process.argv.indexOf(n);
  return i > 0 ? process.argv[i + 1] : d;
};
const runs = Number(arg('--runs', 5));

const child = String.raw`
const t0 = performance.now();
const { registerHooks } = await import('node:module');
const loaded = new Set();
registerHooks({ load(url, ctx, next) { if (url.includes('/dist/features/')) loaded.add(url.replace(/.*\/dist\/features\//, '')); return next(url, ctx); } });
const profile = process.argv[process.argv.length - 1];
const { Gateway } = await import(process.env.MGW_DIST + '/gateway/index.js');
const { logger } = await import(process.env.MGW_DIST + '/utils/logger.js');
logger.setLevel('error');
const t1 = performance.now();
const base = { port: 0, host: '127.0.0.1', logLevel: 'error', servers: [], auth: { strategy: 'api-key', apiKeys: ['k'.repeat(40)] }, monitor: { requestLog: false } };
let cfg = base;
if (profile === 'all') {
  const { validateConfig } = await import(process.env.MGW_DIST + '/config/loader.js');
  const { FEATURE_CONFIG_KEYS } = await import(process.env.MGW_DIST + '/gateway/features.js');
  const features = {};
  for (const k of FEATURE_CONFIG_KEYS) {
    try { validateConfig({ version: 11, servers: [], features: { [k]: {} } }); features[k] = {}; } catch {}
  }
  cfg = { ...validateConfig({ version: 11, servers: [], features }), ...base };
}
const gw = new Gateway(cfg);
await gw.start();
const t2 = performance.now();
globalThis.gc?.(); globalThis.gc?.();
const m = process.memoryUsage();
await gw.stop();
console.log(JSON.stringify({ importMs: t1 - t0, startMs: t2 - t1, totalMs: t2 - t0, rssMb: m.rss / 1048576, heapMb: m.heapUsed / 1048576, featureModules: loaded.size }));
`;

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};
const result = { node: process.version, platform: `${process.platform}-${process.arch}`, runs, profiles: {} };
for (const profile of ['minimal', 'all']) {
  const samples = [];
  for (let i = 0; i < runs; i++) {
    const r = spawnSync(process.execPath, ['--expose-gc', '--input-type=module', '-e', child, profile], { env: { ...process.env, MGW_DIST: join(root, 'dist') }, encoding: 'utf8', timeout: 60_000 });
    const line = r.stdout.trim().split('\n').pop();
    if (r.status !== 0 || !line?.startsWith('{')) {
      console.error(r.stderr || r.stdout);
      process.exit(2);
    }
    samples.push(JSON.parse(line));
  }
  const keys = Object.keys(samples[0]);
  result.profiles[profile] = Object.fromEntries(keys.map((k) => [k, Math.round(median(samples.map((s) => s[k])) * 10) / 10]));
}

const out = arg('--write');
if (out) writeFileSync(join(root, out), JSON.stringify({ ...result, recordedAt: new Date().toISOString() }, null, 2) + '\n');
const cmp = arg('--compare');
let failed = false;
if (process.argv.includes('--json')) console.log(JSON.stringify(result, null, 2));
else {
  const base = cmp ? JSON.parse(readFileSync(join(root, cmp), 'utf8')) : undefined;
  console.log(`Node ${result.node} · ${result.platform} · median of ${runs}`);
  console.log('| profile | metric | value | baseline | Δ |');
  console.log('|---|---|---:|---:|---:|');
  for (const [p, v] of Object.entries(result.profiles)) {
    for (const [k, x] of Object.entries(v)) {
      const b = base?.profiles?.[p]?.[k];
      const d = b ? `${(((x - b) / b) * 100).toFixed(0)}%` : '';
      console.log(`| ${p} | ${k} | ${x} | ${b ?? ''} | ${d} |`);
      if (b && /Ms$/.test(k) && x > 2 * b + 50) failed = true;
      if (b && /Mb$/.test(k) && x > 1.5 * b + 10) failed = true;
    }
  }
}
if (failed) {
  console.error('Gross regression against the recorded baseline (see table).');
  process.exit(1);
}
