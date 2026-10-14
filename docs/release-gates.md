# Release gates

A release (GitHub release, npm publish, container images) is cut from the **merge commit on `main`** (for the
maintenance lines: the merge commit on `lts/12.x` / `lts/10.x`). Since 13.4.0 nothing is published unless the checks
that CI runs on that commit are green. The policy is machine-readable in
[`scripts/required-checks.json`](../scripts/required-checks.json) and enforced by
[`scripts/release-gate.mjs`](../scripts/release-gate.mjs):

```bash
node scripts/release-gate.mjs <merge-commit-sha> --wait 2400   # waits up to 40 min for running checks
```

Exit code 0 means the gate is open; 1 means refused (a required check missing, failed, cancelled or still running at
the deadline, or any other check failing); 2 means the check runs could not be read. The release scripts call it after
the merge and before they tag, create the GitHub release or run `npm publish`; a refused gate stops the release with
nothing published.

## Required checks

Must exist on the release commit and conclude `success`:

| Check | Workflow | What it covers |
|---|---|---|
| `Node 24` | CI | audit, typecheck, full test suite with coverage thresholds, build, CLI smoke test, example validation, kernel benchmark guard (16.x: Node 24 only, `engines.node >= 24`; the 15.x / 14.x branches keep `Node 22` + `Node 24`) |
| `Supply chain (Trivy, SBOM)` | CI | Trivy on dependencies and the container image, image smoke test, SBOM |
| `Docs check` | CI | [`scripts/docs-check.ts`](../scripts/docs-check.ts): config snippets validated against schema v11, CLI commands and flags, links and anchors, image tags and version numbers (fails on stale versions) |
| `JS client (Node 20)` | CI | `@winstonsayno/mcp-gateway-client` tests and build |
| `JS client (Node 22)` | CI | idem |
| `JS client (Node 24)` | CI | idem |
| `Kotlin client` | CI | Kotlin client build and tests |
| `MCP compat matrix` | CI | official TypeScript / Python SDK clients x protocol revisions, upstream transports, Motionary E2E ([client compatibility](guides/client-compatibility.md); required since 13.7.0) |
| `Multi-instance reliability (real Redis)` | CI | two gateway instances on a real `redis-server` with TCP fault injection: session delete/cancel across instances, store reconnect (SELECT/AUTH before commands), re-publish after data loss (required since 13.8.0) |
| `Analyze (javascript-typescript)` | CodeQL | static analysis |

## Conditional checks

Path-filtered workflows: they may be absent on a commit that does not touch their paths, but when they ran they must
conclude `success` (or `skipped`):

| Check | Workflow | Runs when |
|---|---|---|
| `Lint and render chart` | Helm | `deploy/**` changes |
| `Load + faults (Node 24)` | Performance | gateway sources change (Node 22 on the 15.x / 14.x branches) |
| `Compose example boots` | Deployment examples | examples, deployment docs, chart, Dockerfile or sources change |
| `Kubernetes and Helm examples boot (kind)` | Deployment examples | idem |
| `Upgrade + security regressions (real Redis)` | CI | every CI run (14.9.0; conditional until it has run green on `main`, then required) |

## Everything else

Any other check run on the release commit that concludes `failure`, `cancelled`, `timed_out`, `action_required` or
`stale` refuses the gate too, except these informational ones: `Scorecard analysis` (OpenSSF Scorecard), `Module cost report` (Performance, 13.8.0: per-module cost report, report only), `Build site`
and `Deploy` (dashboard demo on GitHub Pages) and the post-release jobs `assets`, `image`, `npm`, `maven-central`
(they run *because* of the release).

A re-run that succeeds replaces the failed attempt (the most recent run of a check counts). After two failed re-runs
of the same infrastructure failure (registry rate limits, an arm64 emulation hang) the release is stopped and the
cause reported rather than retried further.

## After the release

Post-release workflows (`Docker image`, `Release assets`, `Publish clients`) are verified separately: GHCR tags and
digests, `cosign verify` of the image, and an install-and-start check of the npm package. They are not part of the
gate because they need the release to exist.

## Changing the policy

Add a job to `required` only once it has run green on `main`; rename entries together with the job. The test
`test/release-gate-13-4-0.test.ts` fails when a listed check is no longer a job name in the workflows or is missing
from this page.

## v15 gates

15.0.0 ships only when these hold in addition to the required checks (roadmap; status in
[docs/v15/release-candidate.md](v15/release-candidate.md)):

How to run gates A / B / C, their criteria and what the maintainer has to provide: [docs/v15/gates.md](v15/gates.md)
(harness `scripts/gate-a.sh`, workflow `Gate A (72 h soak)` on a self-hosted runner).

1. **72 h soak** — workflow `Soak` (`.github/workflows/soak.yml`, `workflow_dispatch`) on a dedicated self-hosted runner
   (labels `self-hosted, linux, soak`; GitHub-hosted jobs stop after 6 h): `gh workflow run soak.yml -f duration=72h
   -f runner=soak -f baseline=13.3.0 -f baseline_duration=6h`. `scripts/soak.mjs` runs two instances sharing a real
   Redis (AOF, fsync always), steady load from three tenants plus cross-tenant attempts, and every 5 minutes one fault:
   kill -9 + restart of instance A, a 20 s partition between instance B and Redis, or a Redis kill + restart. It fails
   on any cross-tenant call that is allowed or reaches an upstream, any response carrying another tenant's data, and
   any non-idempotent call executed more than once (plain calls and durable task runs retried with the same
   Idempotency-Key).
2. **Baseline comparison** — the same harness, settings and machine with `--impl` pointing at 13.3.0: p95, p99,
   throughput, RSS growth (linear fit over the run, instance that is never killed) and recovery time per fault
   (`vsBaseline` in the report).
3. **External security review** of the release scope, high findings closed.
4. **Migration and rollback** 13.x / 14.x → 15 — CI job `Upgrade + security regressions (real Redis)` and
   `test/rc-migration-14-9-0.test.ts`.

A short soak (30–45 min) on a shared machine shows the harness and the invariants work; it is not the gate, and its
latency numbers are not comparable with a baseline measured at another time on a busy machine.
