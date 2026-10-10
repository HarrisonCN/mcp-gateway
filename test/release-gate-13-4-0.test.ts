/** 13.4.0: release gate — publishing is refused unless the required checks on the release commit are green. */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
// @ts-expect-error plain ESM script without types
import { evaluateGate, loadPolicy, checkRuns } from '../scripts/release-gate.mjs';

const policy = loadPolicy();
const green = (name: string, extra: Record<string, unknown> = {}) => ({ name, status: 'completed', conclusion: 'success', started_at: '2026-10-10T10:00:00Z', ...extra });
const allGreen = () => policy.required.map((n: string) => green(n));

describe('release gate', () => {
  it('opens only when every required check concluded success', () => {
    expect(evaluateGate(allGreen(), policy)).toMatchObject({ open: true, problems: [], pending: [] });
  });

  it('refuses when a required check is missing, failed, cancelled or still running', () => {
    const missing = allGreen().filter((r: { name: string }) => r.name !== 'Docs check');
    expect(evaluateGate(missing, policy)).toMatchObject({ open: false, problems: ['required check "Docs check" has not run on this commit'] });
    const failed = allGreen().map((r: { name: string }) => (r.name === 'Node 24' ? { ...r, conclusion: 'failure' } : r));
    expect(evaluateGate(failed, policy).problems).toEqual(['required check "Node 24" concluded failure']);
    const cancelled = allGreen().map((r: { name: string }) => (r.name === 'Supply chain (Trivy, SBOM)' ? { ...r, conclusion: 'cancelled' } : r));
    expect(evaluateGate(cancelled, policy).open).toBe(false);
    const running = allGreen().map((r: { name: string }) => (r.name === 'Node 22' ? { ...r, status: 'in_progress', conclusion: null } : r));
    expect(evaluateGate(running, policy)).toMatchObject({ open: false, problems: [], pending: ['Node 22'] });
  });

  it('a re-run that succeeded replaces the failed attempt', () => {
    const runs = [...allGreen(), green('Node 24', { conclusion: 'failure', started_at: '2026-10-10T09:00:00Z' })];
    expect(evaluateGate(runs, policy).open).toBe(true);
    const worse = [...allGreen(), green('Node 24', { conclusion: 'failure', started_at: '2026-10-10T11:00:00Z' })];
    expect(evaluateGate(worse, policy).open).toBe(false);
  });

  it('conditional checks may be absent or skipped, but not failing; unknown failing checks refuse; informational ones never do', () => {
    expect(evaluateGate([...allGreen(), green('Lint and render chart', { conclusion: 'skipped' })], policy).open).toBe(true);
    expect(evaluateGate([...allGreen(), green('Compose example boots', { conclusion: 'failure' })], policy).problems).toEqual(['check "Compose example boots" concluded failure']);
    expect(evaluateGate([...allGreen(), green('Some new job', { conclusion: 'timed_out' })], policy).open).toBe(false);
    expect(evaluateGate([...allGreen(), green('Scorecard analysis', { conclusion: 'failure' })], policy).open).toBe(true);
  });

  it('pages through the check runs of a commit', () => {
    const pages = [Array.from({ length: 100 }, (_, i) => green(`job ${i}`)), [green('last')]];
    const seen: string[] = [];
    const runs = checkRuns('o/r', 'abc1234', (p: string) => (seen.push(p), { check_runs: pages[seen.length - 1] }));
    expect(runs).toHaveLength(101);
    expect(seen[1]).toContain('page=2');
  });

  it('every workflow file is valid YAML (an invalid one never reports its checks)', async () => {
    const { readdirSync } = await import('fs');
    const { parse } = await import('yaml');
    const dir = fileURLToPath(new URL('../.github/workflows/', import.meta.url));
    for (const f of readdirSync(dir).filter((x) => x.endsWith('.yml'))) expect(() => parse(readFileSync(dir + f, 'utf8')), f).not.toThrow();
  });

  it('the required checks exist as job names in the workflows, and the policy is documented', () => {
    const wf = ['ci.yml', 'codeql.yml', 'helm.yml', 'perf.yml', 'deploy-examples.yml'].map((f) => readFileSync(fileURLToPath(new URL(`../.github/workflows/${f}`, import.meta.url)), 'utf8')).join('\n');
    for (const n of [...policy.required, ...policy.conditional]) {
      const matrix = n.replace(/\b(Node )\d+\b/, '$1${{ matrix.node }}');
      expect(wf.includes(`name: ${n}`) || wf.includes(`name: ${matrix}`), `job "${n}" not found in workflows`).toBe(true);
    }
    const doc = readFileSync(fileURLToPath(new URL('../docs/release-gates.md', import.meta.url)), 'utf8');
    for (const n of policy.required) expect(doc).toContain(n);
  });
});
