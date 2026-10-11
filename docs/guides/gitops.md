# GitOps and config governance (14.7)

Keep the gateway config in git, review every change as a diff between environments and against the live gateway,
see which allow / deny decisions a change flips before it ships, and let the gateway accept only **signed, approved
releases**. Builds on [declarative config](declarative-config.md) (`diff` / `apply`, 7.1), the config generations and
[cluster rollout](cluster-rollout.md) (14.1) and schema v12 (14.0). A complete repository layout with a GitHub Actions
workflow is in [`examples/gitops`](../../examples/gitops/README.md).

## Config directory: base + environment overlays

```
config/
  base.yml                 # shared by every environment (required)
  servers.yml              # pulled in with `include:`
  policy.yml
  environments/
    staging.yml            # overlay for `staging`
    prod.yml               # overlay for `prod`
    _prod-policy.yml       # a partial (leading `_`): only included, never an environment
```

<!-- docs-check: skip -->
```yaml
# base.yml — a fragment: `include:` is resolved by `mcp-gateway gitops render`
version: 12
include: [servers.yml, policy.yml]
auth:
  strategy: api-key
  apiKeys:
    - {name: operator, key: "${MCP_GATEWAY_ADMIN_KEY}"}
    - {name: agents, key: "${AGENTS_KEY}", scope: {servers: [github]}}
servers:
  - {id: github, name: GitHub, transport: streamable-http, url: "https://api.githubcopilot.com/mcp/", headers: {Authorization: "Bearer ${GITHUB_TOKEN}"}}
rateLimit: {windowSeconds: 60, limit: 600}
```

`mcp-gateway gitops render -d config -e prod` builds the **bundle** for one environment:

1. `base.yml` — its `include:` files first (in order), then the file itself;
2. `environments/<env>.yml` — its includes first, then the file — merged on top.

Merge rules:

| In the overlay | Result |
|---|---|
| a mapping | merged key by key (deep) |
| a list whose entries all have `id` (`servers`, peers, …) | merged by `id`: an entry with a known id is merged into it, a new id is appended |
| `{ id: scratch, $delete: true }` in such a list | removes that entry |
| `key: null` | removes the key |
| any other list or value | replaces the base value |

Includes are relative to the including file and must stay inside the directory (symlinks are resolved); absolute
paths, `..` escapes and include cycles are refused. `policy.files` are read and inlined, so a bundle is self-contained.

### Secrets by reference only

A secret field — `auth.apiKeys` / `key`, `token`, `password`, `secret`, `authorization`, `jwtSecret`, `privateKey`,
`clientSecret`, …, entries of `env` / `headers` whose name looks secret (`*TOKEN*`, `*KEY*`, `*SECRET*`, `*AUTH*`, …) and
URLs with credentials — must hold a reference: `${ENV_VAR}`, `secret://provider/path#field` (see
[secret providers](../configuration.md)) or a `sha256:` key hash (`mcp-gateway hash-key`). `render`, `plan` and `apply`
refuse a literal and name its path, never its value:

```
secrets must be references (${ENV_VAR} or secret://…), literal secret at: servers.github.headers.Authorization
```

References are resolved by the gateway that runs the config, from its own environment / secret providers — the
bundle, the manifest and CI never see the values. Since 14.7 every API key form and `controlPlane.token` expand
`${VAR}`, and an unset variable is a config error ([MGW-2026-019](../../SECURITY.md#security-advisories)).

## Review: env diff, plan

```bash
mcp-gateway gitops diff -d config -e staging --against-env prod      # staging → prod, no gateway needed
mcp-gateway gitops diff -d config -e prod --url $GW --key $OP_KEY     # running gateway → prod
mcp-gateway gitops plan -d config -e prod --manifest release.json --url $GW --key $OP_KEY
```

`diff` exits `3` when there are changes (`0` when none), like `mcp-gateway diff`. Secret fields are shown as
`<redacted>`.

`plan` asks the gateway (`POST /api/v1/admin/gitops/plan`) what applying the bundle would do:

```
Environment prod (enforced) — bundle sha256:4f1c…

~ rateLimit: {"windowSeconds":60,"limit":600} → {"windowSeconds":60,"limit":1000}
~ policy: …

✓ release 9d2e…c41 for prod: author release-bot, 2/2 approvals (alice, bob)
→ would be applied

Policy simulation (replay, 1834 calls): 3 decision(s) change — allow→deny 3
  agents → github/create_issue: allow→deny: no rule matches github/create_issue; the default is deny (was: no rule matches github/create_issue; the default is allow)
  ops → scratch/read_file: allow→deny: server "scratch" is removed (was: no rule matches scratch/read_file; the default is allow)
  ci → github/search_code: allow→deny: key "ci" may not call search_code (tools: read_*, list_*) (was: …)
```

`--json` prints the full report (`changes`, `restart`, `verification`, `wouldApply`, `refusal`, `simulation`).

### Policy simulation

Every call is decided the way the gateway decides it, layer by layer, under the running config and under the
candidate:

1. **server** — a call to a server the candidate removes is denied;
2. **scope** — a named API key that is removed, or whose `scope.servers` / `scope.tools` no longer cover the call;
3. **policy** — the tool policy (`policy.rules`, first match, then `default`).

Each changed decision carries the layer, the deciding rule and an explanation; `byClient` / `byTool` count the
impact. The calls come from `--calls <file>` (a JSON array or JSON lines of `{ clientId?, serverId, tool, args? }`),
else the replay recorder (`replay.enabled: true` — with arguments, so argument matchers work), else recent request
metrics. The [policy simulation](policy-sim.md) endpoints (6.5) still compare a candidate *policy* only; `plan`
compares whole releases.

## Signed releases

A **release manifest** binds a rendered bundle to who made it and who approved it:

```json
{
  "schema": "mcp-gateway/release-manifest@1",
  "env": "prod",
  "configHash": "sha256:4f1c…",
  "gitSha": "9d2e…c41",
  "author": "release-bot",
  "keyId": "ci",
  "createdAt": "2026-10-11T14:00:00.000Z",
  "expiresAt": "2026-10-18T14:00:00.000Z",
  "signature": "…ed25519…",
  "approvals": [
    { "keyId": "alice", "by": "alice", "at": "2026-10-11T14:20:00.000Z", "signature": "…" },
    { "keyId": "bob", "by": "bob", "at": "2026-10-11T14:31:00.000Z", "signature": "…" }
  ]
}
```

- `configHash` is the SHA-256 of the canonical JSON of the bundle's config (keys sorted) — any change to the config
  invalidates every signature.
- The author signs `{ env, configHash, gitSha, author, keyId, createdAt, expiresAt }`; each approver signs the same
  fields plus their own `{ keyId, by, at }`. Keys are **ed25519**.

```bash
mcp-gateway gitops keygen --out ~/.mcp-gateway/alice          # alice.key (0600) + alice.pub
mcp-gateway gitops sign -d config -e prod --key ci.key --key-id ci --author release-bot --git-sha $GITHUB_SHA --expires-in 168 -o release.json
mcp-gateway gitops approve release.json --key ~/.mcp-gateway/alice.key --key-id alice --by alice
mcp-gateway gitops verify release.json -d config -e prod --trust config/environments/prod.yml
```

`sign` takes the git sha from `--git-sha`, else `$GITHUB_SHA`, else `git rev-parse HEAD` in the directory. `verify`
reads the trusted keys from `controlPlane.gitops` of any config file and exits `1` when the gateway would refuse the
release.

### Trust and approvals

```yaml
version: 12
controlPlane:
  configApi: true
  gitops:
    environment: prod
    enforce: true
    requiredApprovals: {prod: 2, "*": 1}
    recordFile: .gitops-release.json
    trustedKeys:
      - {id: ci, name: release-bot, publicKey: "ed25519:rii8NOw6MSmmi4EyapOhXXt+eald3gXVJiYITjVO2qM=", roles: [author]}
      - {id: alice, name: alice, publicKey: "ed25519:ZPK3vNfk9BYDkUvbBbWcGZQafPrI8VdwrQ2OQYtNtDE=", roles: [approver]}
      - {id: bob, name: bob, publicKey: "ed25519:84kFUUvAxhkllhMKEsyc9j+WLpLAR9x3OxPcC0q24EU=", roles: [approver]}
```

A manifest verifies when:

- its environment is the gateway's `environment` and the bundle's, and `configHash` matches the bundle;
- the author key is a trusted key with role `author` and the signature is valid;
- it is not older than `maxManifestAgeSeconds`, not expired, not created more than 5 minutes in the future, and newer
  than the release applied last (**replay protection** — roll back by signing a new release of the old content);
- at least `requiredApprovals` distinct **names** approved it with trusted `approver` keys and valid signatures. The
  author's name never counts (separation of duties), a name counts once however many keys it holds, untrusted or
  invalid approvals are ignored (and listed).

`requiredApprovals` is a number or a map per environment with `"*"` as fallback; without it `prod` / `production`
need 2 and other environments 0.

## Apply and enforcement

```bash
mcp-gateway gitops apply -d config -e prod --manifest release.json --url $GW --key $OP_KEY
mcp-gateway gitops apply -d config -e prod --manifest release.json --dry-run
```

`POST /api/v1/admin/gitops/apply` `{ bundle, manifest?, dryRun? }` verifies again on the gateway, then hot-applies the
config like `PUT /admin/config` (restart-only sections are reported with `restart: true`). On a control plane the new
config is the next **config generation** and reaches the data planes by the `controlPlane.rollout` strategy (canary,
automatic rollback, divergence reporting).

With `enforce: true`:

| Request | Answer |
|---|---|
| `gitops apply` without a manifest | `403` — `unsigned bundle: gitops enforcement requires a signed, approved release manifest` |
| a manifest that does not verify (tampered, untrusted, too few approvals, replay, expired, other environment) | `403` with every reason |
| `PUT /api/v1/admin/config` (`mcp-gateway apply`, the dashboard's Config tab) | `409` — dry runs still work |
| `POST /api/v1/admin/reload` | `409` |
| feature modules that apply config (config assistant) | refused with the same message |

Without `enforce`, an unsigned bundle is applied and recorded as `signed: false`; a manifest that is sent must still
verify. A bundle with `<redacted>` placeholders, a literal secret, `policy.files`, a wrong `configHash` or another
environment is always `400`. Applies are serialized.

Enforcement covers the admin API. A config file that is edited and reloaded by the file watcher, a restart with
another file, or a cluster rollback (`POST /admin/cluster/rollback`, an operator emergency action) is not blocked —
it shows up as **drift**.

## Status and drift

```bash
mcp-gateway gitops status --url $GW --key $OP_KEY        # exit 2 when drifted
```

```
Environment prod — enforcement ON
Release 9d2e…c41 by release-bot, approved by alice, bob, applied 2026-10-11T14:40:02.114Z
✓ in sync with the release
```

`GET /api/v1/admin/gitops/status` returns the environment, enforcement, required approvals, trusted key ids, the
release applied last (`env`, `configHash`, `gitSha`, `author`, `approvers`, `signed`, `appliedAt`, `appliedBy`), the
live config hash, `drift` (`drifted`, the changed paths, `checkedAt`) and the latest events. The running config is
compared with the applied release every `driftCheckIntervalMs`, on every status request and on every metrics scrape.

With `recordFile` the applied release (and its hash) survives restarts — replay protection and the drift baseline
included; the changed paths of a drift are only listed until the first restart (the hash still detects it).

## Audit and metrics

Every apply, refusal and drift transition is logged and written as an audit entry: server `_gitops`, tool
`gitops.apply` (decision `applied` / `refused`) or `gitops.drift` (`drift` / `in-sync`), the operator's client id and
the reason (release, author, approvers; or why it was refused). Query them like any audit entry
(`GET /api/v1/requests?server=_gitops`, the audit store, SIEM export).

| Metric | |
|---|---|
| `mcp_gateway_gitops_applies_total{result}` | `applied`, `refused`, `dry_run`, `invalid` |
| `mcp_gateway_gitops_drift` | `1` while the running config differs from the applied release |
| `mcp_gateway_gitops_enforced` | `1` with `enforce: true` |
| `mcp_gateway_gitops_release_info{env,git_sha}` | the applied release |
| `mcp_gateway_gitops_last_apply_timestamp_seconds` | when it was applied |

Alert on `mcp_gateway_gitops_drift == 1` and on `increase(mcp_gateway_gitops_applies_total{result="refused"}[1h]) > 0`.

## CI: GitHub Actions

[`examples/gitops/workflow.yml`](../../examples/gitops/workflow.yml):

- **pull request** — `render` every environment (fails on literal secrets), `diff -e staging --against-env prod`,
  `plan` against each live gateway into the job summary;
- **push to main** — the release bot signs a manifest per environment (its private key is a CI secret of a protected
  GitHub environment) and uploads it; approvers add their signatures on their own machines (`gitops approve`) and
  commit `releases/<env>.json` in a pull request — approver keys never reach CI;
- **releases merged** — `verify`, `apply` (the gateway verifies again), `status`.

The operator key used by CI (`MCP_GATEWAY_ADMIN_KEY`) can apply releases but, with enforcement on, cannot change the
config any other way.

## Limits

- Signatures are ed25519 keys you manage; sigstore / keyless signing is not supported yet.
- Enforcement guards the admin API of the gateway that runs `controlPlane.gitops`; protect the config file and the
  process environment of that host as before.
- Policy simulation covers server presence, API key scopes and the tool policy — not tenants, quotas, rate limits or
  feature-module decisions (DLP, approval flows, policy engine).
