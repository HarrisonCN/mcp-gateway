# Security policy

## Supported versions

| Version | Supported |
|---|---|
| 10.x (LTS) | ✅ bug and security fixes until 2027-10-31, then security fixes only until 2028-10-31 |
| < 10.0 | ❌ — please upgrade (`mcp-gateway migrate --to 10`, see [Migrating to 10.0](docs/guides/migrating-to-v10.md)) |

10.x is the first long-term-support line: config schema v10 stays stable across every 10.x minor release, and
`ltsStatus()` / `GET /api/v1/admin/kernel` report where the running release is in its support window.

## Reporting a vulnerability

Please **do not** open a public issue. Use
[GitHub private vulnerability reporting](https://github.com/HarrisonCN/mcp-gateway/security/advisories/new)
with steps to reproduce and the affected version. You will get an answer within a few days; fixes are released as
patch versions and credited in the CHANGELOG unless you prefer otherwise.

## Threat model

[docs/security/threat-model.md](docs/security/threat-model.md) describes the data flow (client → auth → policy →
upstream MCP servers / child processes), the trust boundaries, known limitations and the findings of each audit.

## Hardening a deployment

mcp-gateway forwards tool calls to processes and services that can read files, call APIs and spend money, so treat
it like any other privileged service. The full checklist is in
[docs/deployment.md](docs/deployment.md#security-checklist); the essentials:

| Risk | Setting |
|---|---|
| Unauthenticated access | `auth.strategy: api-key` or `jwt`; the gateway warns at startup when auth is off on a non-loopback address |
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
