// v15 gate A harness: scripts/gate-a-report.mjs evaluates criteria A1–A8 from a soak report + RSS samples.
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const H = 3600e3;
function soakReport(over: Record<string, unknown> = {}) {
  const durationMs = 72 * H;
  return {
    harness: 'scripts/soak.mjs (14.9.0)', impl: '15.0.0-rc.2', settings: { durationMs, rps: 60, concurrency: 8, faultEveryMs: 300000, warmupMs: 30000, sampleEveryMs: 10000 },
    faults: Array.from({ length: Math.floor((durationMs - 60000) / 300000) }, (_, i) => ({ kind: 'kill -9 instance A (down 5 s)', recoveryMs: 900 + i })),
    invariants: { crossTenantAttempts: 1000, crossTenantAllowed: 0, responseLeaks: 0, ledgerEntries: 5000, duplicateExecutions: 0, durable: { submitted: 10, executedOnce: 10, notExecuted: 0, clientRetries: 0 } },
    violations: [], pass: true, throughput: {}, latencyMs: {}, errors: {}, recoveryMs: {},
    ...over,
  };
}
// RSS of B every 10 min for 72 h: rises 50 → 150 MB over the first 6 h, then flat (+slope after) — and A for noise
function rss(plateauSlope: number, pidChangeAtH?: number) {
  const lines: string[] = [];
  for (let m = 0; m <= 72 * 60; m += 10) {
    const h = m / 60;
    const mb = h < 6 ? 50 + (100 * h) / 6 : 150 + plateauSlope * (h - 6);
    const pid = pidChangeAtH !== undefined && h >= pidChangeAtH ? 2 : 1;
    lines.push(JSON.stringify({ ts: 1_700_000_000_000 + m * 60e3, inst: 'B', pid, rssMb: mb }), JSON.stringify({ ts: 1_700_000_000_000 + m * 60e3, inst: 'A', pid: 9, rssMb: 999 }));
  }
  return lines.join('\n') + '\n';
}
function run(report: object, samples: string) {
  const d = mkdtempSync(join(tmpdir(), 'gate-a-'));
  writeFileSync(join(d, 's.json'), JSON.stringify(report));
  writeFileSync(join(d, 'r.jsonl'), samples);
  const r = spawnSync(process.execPath, ['scripts/gate-a-report.mjs', '--soak', join(d, 's.json'), '--rss', join(d, 'r.jsonl'), '--out', join(d, 'g.json')], { encoding: 'utf8' });
  const g = JSON.parse(readFileSync(join(d, 'g.json'), 'utf8'));
  return { code: r.status, g, crit: Object.fromEntries(g.criteria.map((c: { id: string; pass: boolean }) => [c.id, c.pass])) };
}

describe('gate A report (scripts/gate-a-report.mjs)', () => {
  it('G1 all criteria met: 72 h, faults recovered, no violations, RSS plateaus → exit 0; windows are per 6 h of instance B only', () => {
    const { code, g, crit } = run(soakReport(), rss(0));
    expect(code).toBe(0);
    expect(g.verdict).toBe('criteria-met (needs sign-off)');
    expect(Object.values(crit).every(Boolean)).toBe(true);
    expect(g.memory.windows).toHaveLength(12);
    expect(g.memory.windows[0].slopeMbPerHour).toBeCloseTo(100 / 6, 0);
    expect(Math.abs(g.memory.plateauSlopeMbPerHour)).toBeLessThan(0.01);
    expect(g.memory.windows.every((w: { maxMb: number }) => w.maxMb < 999)).toBe(true); // instance A ignored
  });

  it('G2 memory still growing over the last 24 h fails A8 (and only A8)', () => {
    const { code, crit, g } = run(soakReport(), rss(60));
    expect(code).toBe(1);
    expect(crit['A8.memory-plateau']).toBe(false);
    expect(g.memory.plateauSlopeMbPerHour).toBeCloseTo(60, 0);
    expect(Object.entries(crit).filter(([, v]) => !v).map(([k]) => k)).toEqual(['A8.memory-plateau']);
  });

  it('G3 a short run, a duplicate execution, a cross-tenant leak or a restarted instance B each fail their criterion', () => {
    expect(run(soakReport({ settings: { ...soakReport().settings, durationMs: 2 * H } }), rss(0)).crit['A1.duration']).toBe(false);
    const dup = run(soakReport({ invariants: { ...soakReport().invariants, duplicateExecutions: 1 }, violations: ['non-idempotent call c-7 executed 2 times'], pass: false }), rss(0));
    expect(dup.crit['A5.no-duplicate-execution']).toBe(false);
    expect(dup.crit['A6.no-violations']).toBe(false);
    expect(run(soakReport({ invariants: { ...soakReport().invariants, crossTenantAllowed: 1 } }), rss(0)).crit['A4.no-cross-tenant-access']).toBe(false);
    expect(run(soakReport(), rss(0, 30)).crit['A7.instance-B-never-restarted']).toBe(false);
    expect(run(soakReport({ faults: [{ kind: 'kill', recoveryMs: null }] }), rss(0)).crit['A3.faults-injected']).toBe(false);
  });
});
