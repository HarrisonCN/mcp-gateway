# v15 release gates A / B / C

15.0.0 ships only when gates A, B and C are closed, in addition to the required CI checks
([release gates](../release-gates.md#v15-gates), status in the [roadmap](../ROADMAP.md)). Release candidates are
published before that so the frozen surface can be tried; a candidate never claims a gate is met.

**Status: A, B and C are open.** The harness below exists so the gates can be run on dedicated hardware; nothing on
this page has been run to completion yet. A gate closes only when the maintainer (Winston) records the evidence and
signs it off in the roadmap.

| Gate | Requirement | Evidence | Who runs it |
|---|---|---|---|
| A | 72 h load + fault injection, two instances sharing Redis; no cross-tenant access, no repeated non-idempotent execution, memory plateaus | `gate-a-report.json` from `scripts/gate-a.sh` (workflow `Gate A (72 h soak)`) | Winston, on his own dedicated machine |
| B | Same harness, settings and machine against the v13.3 baseline: p95 / p99 / throughput / memory growth / recovery time | `vsBaseline` + `baseline` in the same run's reports | Winston, same machine as A |
| C | Independent security audit, or at least one external expert review; every high finding in scope closed | Review report + closed advisories | An external reviewer Winston engages |

## Gate A — 72-hour soak with fault injection

### What runs

`scripts/gate-a.sh` drives `scripts/soak.mjs` (the harness the 30-minute soaks use) for 72 hours:

- **Topology**: gateway instances A and B, each with its own config, sharing one `redis-server` (AOF, `appendfsync
  always`) through a TCP proxy per instance so a network partition can be injected.
- **Load**: 60 requests/s at concurrency 8 from three API keys in two tenants (`acme`, `labs`): plain tool calls,
  non-idempotent `charge` calls recorded in an upstream ledger, durable task-graph runs submitted with an
  `Idempotency-Key` (retried against the other instance after errors), and every 25th request a cross-tenant attempt.
- **Faults**, one every 5 minutes in rotation: `kill -9` of instance A and a restart 5 s later; a 20 s partition between
  instance B and Redis; `SIGKILL` of Redis and a restart 3 s later (AOF replay).
- **Memory**: `scripts/gate-a-sampler.mjs` records the RSS of both instances every 10 s into `rss.jsonl` while the run
  is going (instance B is never killed, so its curve is the one that counts).
- **Baseline first** (default 13.3.0, 6 h, same settings and machine) so gate B gets its numbers from the same box.

### Criteria (`gate-a-report.json`)

`scripts/gate-a-report.mjs` evaluates these automatically; the job is green (exit code 0) only when all of them hold.

| Id | Criterion |
|---|---|
| A1 | the run lasted at least 72 h |
| A2 | two instances on one shared Redis (always true for `scripts/soak.mjs`; recorded for the evidence) |
| A3 | a fault was injected every 5 minutes and every fault recovered (no `not recovered after 120 s`) |
| A4 | no cross-tenant call allowed or reaching an upstream, no response with another tenant's secret |
| A5 | no non-idempotent call executed twice — plain `charge` calls and durable runs alike — and no durable run reported `succeeded` without executing |
| A6 | zero invariant violations overall (`soak-report.json` `pass: true`) |
| A7 | instance B kept one process for the whole run (its RSS curve is continuous) |
| A8 | memory plateaus: the linear RSS slope of instance B over the last 24 h is at most 45 MB/h (1.5 × the 30 MB/h that 13.3.0 showed with this harness); override with `--max-plateau-mb-per-hour` when the baseline measured on the same machine says otherwise |

The report also lists the RSS slope per 6-hour window, throughput, p50 / p95 / p99 latency, error rates (overall and
outside fault windows), recovery time per fault kind, and the durable-run accounting
(submitted / executed once / not executed / client retries).

A green job is evidence, not the decision: Winston reviews the report and the logs, then marks gate A closed in
`docs/ROADMAP.md` with a link to the run.

### How to run it

On a GitHub self-hosted runner (recommended — artifacts and a step summary are kept by GitHub):

```bash
# once: register the machine as a runner for HarrisonCN/mcp-gateway with the labels self-hosted, linux, soak
gh workflow run gate-a.yml -f version=next -f duration=72h -f baseline=13.3.0 -f baseline_duration=6h
```

`version` is a published npm version or dist-tag (the candidate under test), or `checkout` to build the workflow's ref.
The job uploads everything in `gate-a-out/` as the artifact `gate-a-<run id>`, also when it fails or is cancelled.

Directly on the machine, without GitHub:

```bash
git clone https://github.com/HarrisonCN/mcp-gateway && cd mcp-gateway && npm ci --ignore-scripts
nohup bash scripts/gate-a.sh --version next --duration 72h --out-dir gate-a-out > gate-a.log 2>&1 &
```

A rehearsal (`--duration 2h --baseline none`) checks the machine and the setup; it fails A1 on purpose.

If the machine reboots or the run dies, the files written so far stay in the output directory (`rss.jsonl`, the
`soak*.log` progress lines every minute), but the 72 hours start again: a gate A run has to be one continuous run.

### What Winston must provide for gate A

- **A dedicated Linux machine** (x86-64 or arm64) that runs nothing else for about 80 hours (6 h baseline + 72 h
  soak + setup): at least 4 CPU cores, 8 GB RAM, an SSD, stable power, no sleep or automatic updates/reboots.
- **Software**: Node.js 22, npm, git, `redis-server` on `PATH` (the harness starts its own Redis on a free port; a
  system Redis may stay stopped), outbound access to registry.npmjs.org and github.com.
- **Either** a self-hosted runner registered on the repository with the labels `self-hosted`, `linux`, `soak`
  (repository Settings → Actions → Runners → New self-hosted runner) **or** a shell on the machine to run
  `scripts/gate-a.sh` directly.
- **The evidence back**: `gate-a-report.json`, `soak-report.json`, `soak-baseline.json`, `rss.jsonl`,
  `rss-baseline.jsonl`, `env.json` and the logs (the workflow artifact contains all of them).
- **The sign-off**: a decision on the A8 ceiling if the same-machine baseline differs from 30 MB/h, and the roadmap
  update closing gate A.

## Gate B — comparison with the v13.3 baseline on fixed hardware

Gate B uses the same machine and harness as gate A. `scripts/gate-a.sh` measures the baseline release first
(`--baseline 13.3.0`, settings identical by construction), and the run's `soak-report.json` carries `vsBaseline`:
p95 and p99 latency change (steady state, outside fault windows), throughput change, RSS growth of both, and the
maximum recovery time per fault kind.

The numbers from the shared development sandbox (30-minute soaks next to other jobs) are not a baseline and do not
count for gate B.

**Acceptance thresholds are not fixed yet.** Proposal for Winston to confirm or change before the run: p95 and p99 no
more than 10 % above 13.3.0, steady throughput no more than 5 % below, RSS growth over the last 24 h within criterion
A8, and maximum recovery time per fault kind no more than 20 % above 13.3.0. A memory comparison needs a long
baseline: use `--baseline-duration 24h` (or more) when memory growth is the question; 6 h is enough for latency,
throughput and recovery.

### What Winston must provide for gate B

- The gate A machine and run (B is read from the same run), with a baseline of at least 6 h — 24 h if memory growth
  is compared.
- The decision on the thresholds above.
- The sign-off in the roadmap.

## Gate C — external security review

An independent security audit, or at least one external expert review, of the 15.0 scope, with every high (and
critical) finding in scope closed before 15.0.0.

- **Scope**: the frozen surface in the [freeze list](freeze.md) — REST and admin API, `/mcp`, the CLI, plugin API v5
  and the worker runtime, config schema v12 and its loader, multi-tenant isolation, secrets injection, Redis/SQLite
  state, the Docker image and the release supply chain. Starting points: [threat model](../security/threat-model.md),
  [stdio isolation](../security/stdio-isolation.md), [supply chain](../security/supply-chain.md),
  [incident response](../security/incident-response.md), and the security regression suite (`npm run test:security`).
- **Findings** are reported through GitHub private vulnerability reporting ([SECURITY.md](../../SECURITY.md)) and
  fixed through advisories; each high finding needs a fix, a regression test, and the advisory published or closed.

### What Winston must provide for gate C

- **The reviewer**: a person or firm independent of the code's authors, and their agreement on scope and timeline.
- **Access**: the repository is public; for a review of a running deployment, a test environment with the candidate
  and the reviewer's credentials (never production keys).
- **Triage decisions** on severity where the reviewer and the maintainers disagree, and the final report (or a public
  summary of it) linked from the roadmap.

## What is in the repository

| File | Purpose |
|---|---|
| `scripts/gate-a.sh` | gate A / B harness: baseline + 72 h soak + sampler + report |
| `scripts/gate-a-sampler.mjs` | RSS of the soak's gateway instances every 10 s → `rss.jsonl` (Linux `/proc`) |
| `scripts/gate-a-report.mjs` | evaluates A1–A8, RSS slope per window → `gate-a-report.json` |
| `scripts/soak.mjs` | the soak itself (two instances, Redis, load, faults, invariants) |
| `.github/workflows/gate-a.yml` | `workflow_dispatch` on a `self-hosted, linux, soak` runner; uploads the evidence |
| `.github/workflows/soak.yml` | general soak workflow (short runs on GitHub-hosted runners, long ones self-hosted) |
