#!/usr/bin/env node
/**
 * Release gate (13.4.0): refuse to publish unless the required checks on a commit are green.
 *
 *   node scripts/release-gate.mjs <sha> [--repo owner/name] [--wait <seconds>] [--interval <seconds>] [--json]
 *
 * Rules (scripts/required-checks.json, documented in docs/release-gates.md):
 *   - every `required` check run must exist on the commit and have concluded `success`;
 *   - a `conditional` check (path-filtered workflows) may be absent, but if it ran it must be `success` or `skipped`;
 *   - any other check run that concluded failure / cancelled / timed_out / action_required / stale fails the gate,
 *     except the `informational` ones (post-release jobs, Scorecard);
 *   - pending checks are waited for up to --wait seconds (default 0 = refuse while anything is pending).
 * Exit 0 = gate open, 1 = refused, 2 = usage / API error. Uses GITHUB_TOKEN / GH_TOKEN when set, else `curl`
 * with whatever credentials the environment injects.
 */
import { readFileSync } from 'fs';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const here = dirname(fileURLToPath(import.meta.url));
export const loadPolicy = (file = join(here, 'required-checks.json')) => JSON.parse(readFileSync(file, 'utf8'));

const BAD = new Set(['failure', 'cancelled', 'timed_out', 'action_required', 'stale', 'startup_failure']);

/**
 * Evaluate the gate for a list of check runs ({name, status, conclusion, started_at}). When the same check ran
 * several times (re-runs) the most recent run wins.
 */
export function evaluateGate(runs, policy) {
  const latest = new Map();
  for (const r of runs) {
    const prev = latest.get(r.name);
    if (!prev || String(r.started_at ?? r.completed_at ?? '') >= String(prev.started_at ?? prev.completed_at ?? '')) latest.set(r.name, r);
  }
  const problems = [];
  const pending = [];
  for (const name of policy.required) {
    const r = latest.get(name);
    if (!r) problems.push(`required check "${name}" has not run on this commit`);
    else if (r.status !== 'completed') pending.push(name);
    else if (r.conclusion !== 'success') problems.push(`required check "${name}" concluded ${r.conclusion}`);
  }
  for (const [name, r] of latest) {
    if (policy.required.includes(name) || policy.informational.includes(name)) continue;
    if (r.status !== 'completed') {
      pending.push(name);
      continue;
    }
    const ok = policy.conditional.includes(name) ? ['success', 'skipped', 'neutral'].includes(r.conclusion) : !BAD.has(r.conclusion);
    if (!ok) problems.push(`check "${name}" concluded ${r.conclusion}`);
  }
  return {
    open: problems.length === 0 && pending.length === 0,
    problems,
    pending,
    checks: [...latest.values()].map((r) => ({ name: r.name, status: r.status, conclusion: r.conclusion })),
  };
}

function api(path) {
  const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
  const args = ['-sf', '-H', 'Accept: application/vnd.github+json', ...(token ? ['-H', `Authorization: Bearer ${token}`] : []), `https://api.github.com${path}`];
  return JSON.parse(execFileSync('curl', args, { encoding: 'utf8', maxBuffer: 32 << 20 }));
}

/** Every check run of a commit (paged). */
export function checkRuns(repo, sha, get = api) {
  const out = [];
  for (let page = 1; page < 20; page++) {
    const r = get(`/repos/${repo}/commits/${sha}/check-runs?per_page=100&page=${page}`);
    out.push(...r.check_runs);
    if (r.check_runs.length < 100) break;
  }
  return out;
}

async function main() {
  const argv = process.argv.slice(2);
  const valued = new Set(['--repo', '--wait', '--interval', '--policy']);
  const opt = (n, d) => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : d);
  const sha = argv.find((a, i) => !a.startsWith('--') && !valued.has(argv[i - 1]));
  if (!sha || !/^[0-9a-f]{7,40}$/.test(sha)) {
    console.error('usage: release-gate.mjs <sha> [--repo owner/name] [--wait seconds] [--interval seconds] [--json]');
    process.exit(2);
  }
  const repo = opt('--repo', 'HarrisonCN/mcp-gateway');
  const deadline = Date.now() + Number(opt('--wait', '0')) * 1000;
  const interval = Number(opt('--interval', '30')) * 1000;
  const policy = loadPolicy(opt('--policy'));
  for (;;) {
    let result;
    try {
      result = evaluateGate(checkRuns(repo, sha), policy);
    } catch (e) {
      console.error(`release-gate: cannot read check runs: ${e.message}`);
      process.exit(2);
    }
    if (result.open || result.problems.length || Date.now() >= deadline) {
      if (argv.includes('--json')) console.log(JSON.stringify({ sha, ...result }, null, 2));
      else {
        for (const p of result.problems) console.error(`✗ ${p}`);
        for (const p of result.pending) console.error(`… ${p} still running`);
        console.log(result.open ? `release-gate: OPEN — ${policy.required.length} required checks green on ${sha}` : `release-gate: REFUSED for ${sha}`);
      }
      process.exit(result.open ? 0 : 1);
    }
    await new Promise((r) => setTimeout(r, interval));
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await main();
