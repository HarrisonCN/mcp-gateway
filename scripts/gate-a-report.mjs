#!/usr/bin/env node
// v15 gate A report: combines a scripts/soak.mjs report with the RSS samples written by scripts/gate-a-sampler.mjs and
// evaluates the gate A criteria (docs/v15/gates.md). Writes one JSON file; exit code 0 when every automatic criterion
// holds, 1 otherwise. The verdict is evidence for a human sign-off, not the sign-off itself.
//
//   node scripts/gate-a-report.mjs --soak soak-report.json --rss rss.jsonl [--baseline soak-baseline.json]
//        [--window 6h] [--plateau-window 24h] [--max-plateau-mb-per-hour 45] [--min-duration 72h] --out gate-a-report.json
//
// RSS windows: linear fit (MB/hour) of instance B (never killed) per window, measured from the first sample; the
// plateau criterion uses the last --plateau-window of the run. The default ceiling, 45 MB/h, is 1.5 × the 13.3.0
// harness baseline (30 MB/h); pass --max-plateau-mb-per-hour to use a baseline measured on the same machine instead.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d; };
const dur = (s) => { const m = /^(\d+(?:\.\d+)?)(ms|s|m|h)?$/.exec(String(s)); if (!m) throw new Error(`bad duration ${s}`); return Number(m[1]) * { ms: 1, s: 1e3, m: 60e3, h: 3600e3 }[m[2] ?? 's']; };
const SOAK = opt('soak'); const RSS = opt('rss'); const OUT = opt('out', 'gate-a-report.json'); const BASE = opt('baseline');
if (!SOAK || !RSS) { console.error('usage: gate-a-report.mjs --soak <soak.json> --rss <rss.jsonl> [--out file]'); process.exit(2); }
const WIN = dur(opt('window', '6h'));
const PLATEAU = dur(opt('plateau-window', '24h'));
const MAXP = Number(opt('max-plateau-mb-per-hour', '45'));
const MIN_DUR = dur(opt('min-duration', '72h'));

const soak = existsSync(SOAK) ? JSON.parse(readFileSync(SOAK, 'utf8')) : null;
const base = BASE && existsSync(BASE) ? JSON.parse(readFileSync(BASE, 'utf8')) : null;
const samples = existsSync(RSS) ? readFileSync(RSS, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
const b = samples.filter((s) => s.inst === 'B');
const t0 = b[0]?.ts ?? 0;
const pts = b.map((s) => ({ t: (s.ts - t0) / 3600e3, mb: s.rssMb, pid: s.pid }));
const slope = (p) => {
  if (p.length < 3) return null;
  const n = p.length, sx = p.reduce((a, q) => a + q.t, 0), sy = p.reduce((a, q) => a + q.mb, 0);
  const sxx = p.reduce((a, q) => a + q.t * q.t, 0), sxy = p.reduce((a, q) => a + q.t * q.mb, 0);
  const d = n * sxx - sx * sx;
  return d === 0 ? null : +((n * sxy - sx * sy) / d).toFixed(2);
};
const spanH = pts.length ? pts.at(-1).t : 0;
const windows = [];
for (let s = 0; s < spanH * 3600e3; s += WIN) {
  const a = s / 3600e3, z = (s + WIN) / 3600e3;
  const w = pts.filter((p) => p.t >= a && p.t < z);
  if (!w.length) continue;
  windows.push({ fromH: +a.toFixed(3), toH: +Math.min(z, spanH).toFixed(3), samples: w.length, firstMb: w[0].mb, lastMb: w.at(-1).mb, maxMb: Math.max(...w.map((p) => p.mb)), slopeMbPerHour: slope(w) });
}
const tail = pts.filter((p) => p.t >= spanH - PLATEAU / 3600e3);
const plateauSlope = slope(tail);
const bPids = [...new Set(pts.map((p) => p.pid))];

const crit = [];
const add = (id, ok, detail) => crit.push({ id, pass: !!ok, detail });
add('A1.duration', soak && soak.settings?.durationMs >= MIN_DUR, `run ${soak?.settings?.durationMs / 3600e3} h, required ${MIN_DUR / 3600e3} h`);
add('A2.two-instances-shared-redis', soak && soak.harness?.startsWith('scripts/soak.mjs'), 'scripts/soak.mjs always runs instances A and B on one Redis (AOF, fsync always)');
add('A3.faults-injected', soak && soak.faults?.length >= Math.floor((soak.settings.durationMs - 60_000) / soak.settings.faultEveryMs) - 1 && soak.faults.every((f) => f.recoveryMs != null), `${soak?.faults?.length ?? 0} faults, all recovered: ${soak?.faults?.every((f) => f.recoveryMs != null)}`);
add('A4.no-cross-tenant-access', soak && soak.invariants?.crossTenantAllowed === 0 && soak.invariants?.responseLeaks === 0 && !soak.violations?.some((v) => /cross-tenant|secret|leak/.test(v)), `allowed ${soak?.invariants?.crossTenantAllowed} of ${soak?.invariants?.crossTenantAttempts}, response leaks ${soak?.invariants?.responseLeaks}`);
add('A5.no-duplicate-execution', soak && soak.invariants?.duplicateExecutions === 0 && !soak.violations?.some((v) => /executed \d+ times|without an execution/.test(v)), `duplicates ${soak?.invariants?.duplicateExecutions}, durable ${JSON.stringify(soak?.invariants?.durable)}`);
add('A6.no-violations', soak && soak.pass === true && soak.violations?.length === 0, `${soak?.violations?.length ?? 'n/a'} violations`);
add('A7.instance-B-never-restarted', bPids.length === 1, `instance B pids seen: ${bPids.join(', ')}`);
add('A8.memory-plateau', plateauSlope != null && plateauSlope <= MAXP, `RSS slope over the last ${PLATEAU / 3600e3} h: ${plateauSlope} MB/h (ceiling ${MAXP} MB/h)`);

const report = {
  gate: 'A', generatedAt: new Date().toISOString(),
  impl: soak?.impl ?? null, machine: soak?.machine ?? null, settings: soak?.settings ?? null,
  verdict: crit.every((c) => c.pass) ? 'criteria-met (needs sign-off)' : 'criteria-not-met',
  criteria: crit,
  memory: { instance: 'B (never killed)', samples: pts.length, spanHours: +spanH.toFixed(3), wholeRunSlopeMbPerHour: slope(pts.filter((p) => p.t > 0.5 / 60)), plateauWindowHours: PLATEAU / 3600e3, plateauSlopeMbPerHour: plateauSlope, windows },
  soak: soak ? { throughput: soak.throughput, latencyMs: soak.latencyMs, errors: soak.errors, recoveryMs: soak.recoveryMs, invariants: soak.invariants, violations: soak.violations, vsBaseline: soak.vsBaseline ?? null } : 'missing (run died before writing its report?)',
  baseline: base ? { impl: base.impl, settings: base.settings, memoryGrowthMbPerHour: base.memory?.growthMbPerHour, latencyMs: base.latencyMs?.steady, throughput: base.throughput } : null,
};
writeFileSync(OUT, JSON.stringify(report, null, 2));
console.log(`gate A: ${report.verdict} → ${OUT}`);
for (const c of crit) console.log(`  ${c.pass ? 'ok  ' : 'FAIL'} ${c.id}: ${c.detail}`);
process.exit(crit.every((c) => c.pass) ? 0 : 1);
