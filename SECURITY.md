# Security policy

## Supported versions

| Version | Supported |
|---|---|
| 13.x (current) | ✅ new features, bug and security fixes |
| 12.x | ⚠️ superseded by 13.x — 12.0.4 carries the MGW-2026-001, MGW-2026-005, MGW-2026-007, MGW-2026-008, MGW-2026-009 and MGW-2026-010 fixes ([Migrating to 13.0](https://github.com/HarrisonCN/mcp-gateway/blob/main/docs/guides/migrating-to-v13.md)) |
| 11.x | ⚠️ superseded — 11.2.0 carries the 11.1 / 11.2 security fixes; upgrade to 12.x ([Migrating to 12.0](docs/guides/migrating-to-v12.md)) |
| 10.x (LTS) | ✅ bug and security fixes until 2027-10-31, then security fixes only until 2028-10-31 |
| < 10.0 | ❌ — please upgrade (`mcp-gateway migrate`, see [Migrating to 10.0](docs/guides/migrating-to-v10.md) and [Migrating to 11.0](docs/guides/migrating-to-v11.md)) |

12.x is the current line (config schema v11, central authorizer, isolated stdio servers). 10.x is the long-term-support line:
config schema v10 stays stable across every 10.x minor release, and its LTS dates are unchanged by 11.0.
`ltsStatus()` / `GET /api/v1/admin/kernel` report the running line and the 10.x support window. Security fixes for
10.x ship as 10.x patch releases.

## Reporting a vulnerability

Please **do not** open a public issue. Use
[GitHub private vulnerability reporting](https://github.com/HarrisonCN/mcp-gateway/security/advisories/new)
with steps to reproduce and the affected version. You will get an answer within a few days; fixes are released as
patch versions and credited in the CHANGELOG unless you prefer otherwise.

## Security advisories

| ID | Severity | Fixed in | Summary |
|---|---|---|---|
| MGW-2026-001 | High | 13.1.0, 12.0.1, 10.9.2 | Re-authorization after reroute: call hooks (`rollouts`, `blue-green`, `self-healing`, `realtime-budgets` downgrade) and `routing` splits could move a call to another server after the central authorizer ran, so a client allowed only on the stable server could reach a canary / fallback it was not allowed on. Fixed by a mandatory final authorization against the final target immediately before the upstream send, and a frozen authorized target. Affected: 7.5.0 – 13.0.0, only deployments that use rollouts, blue/green, self-healing fallbacks / rollbacks, budget downgrades or routing splits. |
| MGW-2026-005 | Medium | 13.1.1, 12.0.2, 10.9.3 | Caches shared entries across routing-split targets: the tool cache and the semantic cache keyed entries on the requested server, but a `routing` split picks the real upstream after the lookup, so a cached answer from one split target could be served to a caller routed to another — with `cache` `scope: shared` or a semantic cache scoped `tenant` / `global`, also to a caller not authorized on the target that produced it (bypassing the MGW-2026-001 check of split targets). Fixed by deciding and authorizing the split before any cache lookup and keying both caches on the routed target. Affected: deployments that combine `routing` splits with `cache` rules or `semanticCache`; verified in 10.9.2, 12.0.1 and 13.1.0. |
| MGW-2026-007 | High | 13.1.2, 12.0.3, 10.9.4 | Delegated agent calls were evaluated as the agent instead of the delegator: calls made with an agent delegation token were authorized correctly (delegator scope ∩ token grant), but client policy rules, tenant membership, quotas, budgets, data residency, per-tenant credential injection, the tool cache (`scope: client`), the semantic cache (`scope: tenant`) and the audit record saw `agent:<id>` — so an agent could bypass its delegator's client-specific deny rules (or lend every delegator an `allow` rule written for the agent under `policy.default: deny`), escape tenant quotas / budgets / residency, and two tenants sharing one agent shared cache entries. The same applied to calls feature modules make for a request under their own label (replays, debug sessions, adaptive retries, task graphs). Fixed by one identity context per call: the original caller is the subject every module keys on, agents are recorded as actors (`actor` / `chain` in audit records), rules naming an agent can only restrict. Affected: deployments using `agentIdentity` (since 8.1.0) or those feature modules together with client policy rules, tenants, quotas, budgets, residency or caches; verified in 13.1.1, 12.0.2 and 10.9.3. |
| MGW-2026-008 | Medium | 13.1.2, 12.0.3, 10.9.4 | OAuth / JWT client ids ignored the token issuer: with several trusted issuers (`auth.oauth.issuer` list / several `authorizationServers`, `auth.jwt.issuer` list) a user of one issuer whose `sub` equals a user of another issuer became the same client (tenant membership and role, policy rules, quotas, budgets, agent delegation rights, client-scoped cache, request history). Fixed by issuer-qualified ids `oauth:<issuer>#<sub>` / `jwt:<issuer>#<sub>` when more than one issuer is trusted (single issuer unchanged); unqualified `oauth:` / `jwt:` client patterns are then a configuration error. Affected: only multi-issuer deployments; verified in 13.1.1, 12.0.2 and 10.9.3. |
| MGW-2026-009 | High | 13.1.3, 12.0.4, 10.9.5 | Routing-split targets received the requested server's credentials: per-call credentials (`inject:` tool arguments or `_meta` fields) were resolved for the server the caller asked for, so a call that a `routing` split moved from server A to server B sent A's credential (API key, bearer token, per-tenant secret) to B — an upstream that may belong to another party or trust boundary (a canary, a vendor A/B test). Hook reroutes (rollouts, blue/green, self-healing, budget downgrades) were not affected. Fixed by always injecting the credentials of the server the call is sent to (recorded as the credential target of the final call snapshot); split targets need their own `inject:`. Affected: deployments that combine `routing` splits with `inject:` on a split source server; verified in 13.1.2, 12.0.3 and 10.9.4 (earlier versions with both features likely affected too). |
| MGW-2026-010 | Medium | 13.1.3, 12.0.4, 10.9.5 | Argument rewrites by call hooks bypassed argument-dependent checks: tool policy rules with `args` conditions, approval holds and the security guard modules that ran before a rewriting hook (DLP, sanitize, approval flows, policy engine, …) were re-checked only when a hook also changed the target server, so arguments rewritten on the same server (by a budget downgrade, DLP redaction followed by another hook, or a plugin call hook) were sent unchecked, and an operator could approve arguments other than the ones sent. Fixed by re-running the policy and every guard whose verdict was given on other arguments until the arguments are stable, placing approval holds on the final arguments, and refusing at the send any call that differs from the final security snapshot. Affected: deployments with argument rules / approvals / argument guards together with a call hook that rewrites arguments; verified in 13.1.2, 12.0.3 and 10.9.4. |
| MGW-2026-011 | Medium | 13.2.0, 12.0.5, 10.9.6 | Calls in flight across a hot reload ran with the new configuration: a call authorized under one configuration that was still waiting when a reload committed — held for an operator approval (`approve` rule) or in a slow plugin / call hook — was sent with the configuration committed meanwhile: to the new upstream session of a server whose settings changed, with that server's new `inject:` credentials, and without the new policy or tenant mapping being applied (a call approved under a policy that the reload replaced with `deny` still ran, with the new credentials). Fixed in 13.2.0 by pinning every call to the config generation it started in (server config, credentials, session, policy, plugins); 12.0.5 and 10.9.6 refuse to send a call whose target server config, policy or tenants changed since it started (`config-changed`, retryable). Affected: deployments that hot reload server settings / credentials or policy while calls are held or in flight; verified in 13.1.3, 12.0.4 and 10.9.5 (earlier versions with hot reload and approvals likely affected too). |

The full list (including 13.x-only advisories) is in SECURITY.md on the `main` branch.

## Incident response and supply chain

- [docs/security/incident-response.md](docs/security/incident-response.md) — triage targets by severity, fix and
  disclosure process, and what happens when a release artifact is compromised.
- [docs/security/supply-chain.md](docs/security/supply-chain.md) — cosign keyless signatures, SLSA provenance and
  SBOM attestations on the container image, CycloneDX / SPDX SBOMs and checksums on each GitHub Release, Trivy
  scanning and Dependabot. Verify an image with:

  ```bash
  cosign verify ghcr.io/harrisoncn/mcp-gateway:11 \
    --certificate-identity-regexp '^https://github.com/HarrisonCN/mcp-gateway/.github/workflows/docker.yml@' \
    --certificate-oidc-issuer https://token.actions.githubusercontent.com
  ```

## Threat model

[docs/security/threat-model.md](docs/security/threat-model.md) describes the data flow (client → auth → policy →
upstream MCP servers / child processes), the trust boundaries, known limitations and the findings of each audit.

## Hardening a deployment

mcp-gateway forwards tool calls to processes and services that can read files, call APIs and spend money, so treat
it like any other privileged service. The full checklist is in
[docs/deployment.md](docs/deployment.md#security-checklist); the essentials:

| Risk | Setting |
|---|---|
| Unauthenticated access | `auth.strategy: api-key` or `jwt`; since 10.3 the gateway refuses to start without auth on a non-loopback address (`--insecure` opts out) and the Helm chart requires an API key |
| Leaked config file | store keys as `sha256:` digests (`mcp-gateway gen-key`, `hash-key`); `expiresAt` / `disabled` per key |
| Key guessing | `security.authLockout: true` (429 after repeated failures per IP) plus `rateLimit` |
| Forged / confused JWTs | `auth.jwt.issuer`, `audience`, `requireExp`, `algorithms`; HMAC and asymmetric algorithms are never mixed |
| DNS rebinding / drive-by requests against a local gateway | on by default for a loopback gateway without auth (10.2); otherwise `security.dnsRebindingProtection: true` (Host + Origin checks), `mcp.allowedOrigins` |
| Exposure beyond your network | `security.ipAllowlist`, `security.allowedHosts`, `security.trustProxy` behind a proxy |
| Oversized payloads | `security.maxBodyBytes`, `security.maxToolArgumentsBytes` |
| Secrets in logs / history | built-in redaction of token-shaped strings and secret keys; `security.redactPatterns` for your own formats |
| Clickjacking / MIME sniffing | security headers and a hash-based CSP for the dashboard (on by default) |
| Information leaks in errors | internal error messages and stacks are hidden unless `security.exposeErrorDetails` or `NODE_ENV=development` |

`mcp-gateway validate --strict` exits non-zero on security warnings, and `GET /api/v1/security` reports the current
posture (never key material).

## Scope

In scope: the gateway (`src/`), the dashboard, the published npm package and container image. Vulnerabilities in
upstream MCP servers you connect are out of scope, but reports about the gateway failing to contain them (scope
bypasses, cross-session data leaks, request smuggling between sessions) are very welcome.
