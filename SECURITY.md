# Security policy

## Supported versions

| Version | Supported |
|---|---|
| 13.x (current) | ✅ new features, bug and security fixes |
| 12.x | ⚠️ superseded — upgrade to 13.x ([Migrating to 13.0](docs/guides/migrating-to-v13.md)) |
| 11.x | ⚠️ superseded — 11.2.0 carries the 11.1 / 11.2 security fixes; upgrade to 12.x ([Migrating to 12.0](docs/guides/migrating-to-v12.md)) |
| 10.x (LTS) | ✅ bug and security fixes until 2027-10-31, then security fixes only until 2028-10-31 |
| < 10.0 | ❌ — please upgrade (`mcp-gateway migrate`, see [Migrating to 10.0](docs/guides/migrating-to-v10.md) and [Migrating to 11.0](docs/guides/migrating-to-v11.md)) |

13.x is the current line (config schema v11, central authorizer, isolated stdio servers, on-demand feature modules). 10.x is the long-term-support line:
config schema v10 stays stable across every 10.x minor release, and its LTS dates are unchanged by 11.0.
`ltsStatus()` / `GET /api/v1/admin/kernel` report the running line and the 10.x support window. Security fixes for
10.x ship as 10.x patch releases.

## Reporting a vulnerability

Please **do not** open a public issue. Use
[GitHub private vulnerability reporting](https://github.com/HarrisonCN/mcp-gateway/security/advisories/new)
with steps to reproduce and the affected version. You will get an answer within a few days; fixes are released as
patch versions and credited in the CHANGELOG unless you prefer otherwise.

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
