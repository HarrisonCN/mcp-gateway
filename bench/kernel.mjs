#!/usr/bin/env node
/**
 * Kernel benchmark (12.0; 13.0: lean `./gateway` entry, schemas / manifest not counted, module-count guard): cold
 * start time, memory and evaluated feature modules of the BUILT gateway (dist/).
 *
 *   node bench/kernel.mjs [--runs 5] [--json] [--compare bench/baseline.json] [--write bench/baseline.json]
 *
 * Each sample is a fresh `node --expose-gc` process that imports dist/gateway/public.js (the `./gateway` export), starts a gateway on an
 * ephemeral port (no upstream servers) and reports: import ms, start ms, total ms, RSS / heap after GC, and how many
 * dist/features/<id>.js modules were evaluated (not schemas/ or the manifest) (module-load tracing via module.registerHooks). Two profiles:
 * `minimal` (no features configured) and `all` (every feature section that validates with an empty object).
 *
 * 13.3.0: also `modules` / `moduleKb` — every JS module (dist + node_modules) evaluated and its source size; unlike
 * the timings these do not depend on machine load, so they are held to 10 % of the baseline; `lazyDeps` counts the
 * on-demand packages (jose, ws, yaml, @noble/*) a profile evaluated and may never exceed the baseline (minimal: 0).
 *
 * --compare prints the delta against a recorded baseline and exits 1 only on a gross regression (> 2× the baseline
 * median for time, > 1.5× for memory) — CI runners are noisy, so the numbers are recorded, not tightly asserted.
 * Baselines are per platform (`platforms["linux-x64"]` = GitHub Actions runners); memory is only checked against a
 * baseline recorded on the same platform.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = process.env.MGW_ROOT ?? join(dirname(fileURLToPath(import.meta.url)), '..');
const arg = (n, d) => {
  const i = process.argv.indexOf(n);
  return i > 0 ? process.argv[i + 1] : d;
};
const runs = Number(arg('--runs', 5));

const child = String.raw`
const t0 = performance.now();
const { registerHooks } = await import('node:module');
const loaded = new Set();
let modules = 0, bytes = 0;
const lazy = new Set();
registerHooks({ load(url, ctx, next) { const m = /\/dist\/features\/([a-z0-9-]+)\.js$/.exec(url); if (m && m[1] !== 'manifest') loaded.add(m[1]); const d = /\/node_modules\/(jose|ws|yaml|@noble)\//.exec(url); if (d) lazy.add(d[1]); const r = next(url, ctx); if (!url.startsWith('node:')) { modules++; bytes += r.source ? r.source.length : 0; } return r; } });
const profile = process.argv[process.argv.length - 1];
const { Gateway, logger } = await import(process.env.MGW_DIST + '/gateway/public.js');
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
console.log(JSON.stringify({ importMs: t1 - t0, startMs: t2 - t1, totalMs: t2 - t0, rssMb: m.rss / 1048576, heapMb: m.heapUsed / 1048576, featureModules: loaded.size, modules, moduleKb: bytes / 1024, lazyDeps: lazy.size }));
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
  // 13.0: baselines are keyed by platform (bench/baseline.json `platforms`); fall back to the top-level profiles
  const platformBase = base?.platforms?.[result.platform];
  const samePlatform = !!platformBase || base?.platform === result.platform;
  const baseProfiles = platformBase?.profiles ?? base?.profiles;
  console.log(`Node ${result.node} · ${result.platform} · median of ${runs}`);
  if (base && !samePlatform) console.log(`(no ${result.platform} baseline recorded: comparing with ${base.platform}; memory is report-only)`);
  console.log('| profile | metric | value | baseline | Δ |');
  console.log('|---|---|---:|---:|---:|');
  for (const [p, v] of Object.entries(result.profiles)) {
    for (const [k, x] of Object.entries(v)) {
      const b = baseProfiles?.[p]?.[k];
      const d = b ? `${(((x - b) / b) * 100).toFixed(0)}%` : '';
      console.log(`| ${p} | ${k} | ${x} | ${b ?? ''} | ${d} |`);
      if (b && /Ms$/.test(k) && x > 2 * b + 50) failed = true;
      // memory differs a lot between platforms: only enforced against a baseline recorded on this platform
      if (b && /Mb$/.test(k) && samePlatform && x > 1.5 * b + 10) failed = true;
      // 13.0: a profile must never evaluate more feature modules than recorded (minimal: none)
      if (b !== undefined && k === 'featureModules' && x > b) failed = true;
      // 13.3.0: module count / bytes loaded are deterministic (not timing noise): > 10 % more than recorded fails
      if (b !== undefined && (k === 'modules' || k === 'moduleKb') && x > b * 1.1 + 5) failed = true;
      // 13.3.0: jose / ws / yaml / @noble are loaded on demand — a profile that does not use them must not load them
      if (b !== undefined && k === 'lazyDeps' && x > b) failed = true;
    }
  }
}
if (failed) {
  console.error('Gross regression against the recorded baseline (see table).');
  process.exit(1);
}
