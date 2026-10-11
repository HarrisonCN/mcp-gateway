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
| `Node 22` | CI | audit, typecheck, full test suite with coverage thresholds, build, CLI smoke test, example validation, kernel benchmark guard |
| `Node 24` | CI | the same on Node 24 |
| `Supply chain (Trivy, SBOM)` | CI | Trivy on dependencies and the container image, image smoke test, SBOM |
| `Docs check` | CI | [`scripts/docs-check.ts`](../scripts/docs-check.ts): config snippets validated against schema v11, CLI commands and flags, links and anchors, image tags and version numbers (fails on stale versions) |
| `JS client (Node 20)` | CI | `@winstonsayno/mcp-gateway-client` tests and build |
| `JS client (Node 22)` | CI | idem |
| `JS client (Node 24)` | CI | idem |
| `Kotlin client` | CI | Kotlin client build and tests |
| `MCP compat matrix` | CI | official TypeScript / Python SDK clients x protocol revisions, upstream transports, Motionary E2E ([client compatibility](guides/client-compatibility.md); required since 13.7.0) |
| `Analyze (javascript-typescript)` | CodeQL | static analysis |

## Conditional checks

Path-filtered workflows: they may be absent on a commit that does not touch their paths, but when they ran they must
conclude `success` (or `skipped`):

| Check | Workflow | Runs when |
|---|---|---|
| `Lint and render chart` | Helm | `deploy/**` changes |
| `Load + faults (Node 22)` | Performance | gateway sources change |
| `Compose example boots` | Deployment examples | examples, deployment docs, chart, Dockerfile or sources change |
| `Kubernetes and Helm examples boot (kind)` | Deployment examples | idem |

## Everything else

Any other check run on the release commit that concludes `failure`, `cancelled`, `timed_out`, `action_required` or
`stale` refuses the gate too, except these informational ones: `Scorecard analysis` (OpenSSF Scorecard), `Build site`
and `Deploy` (dashboard demo on GitHub Pages) and the post-release jobs `assets`, `image`, `npm`, `maven-central`
(they run *because* of the release).

`Multi-instance reliability (real Redis)` (CI, 13.7.0) is gated by this rule until it has run green on `main`; then it
moves to `required` (as `MCP compat matrix` did in 13.7.0).

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
