# Incident response (10.4)

How a security problem in mcp-gateway is handled, from report to fix. It applies to the gateway, the dashboard,
the npm packages, the container image and the Helm chart.

## 1. Report

- Private: [GitHub private vulnerability reporting](https://github.com/HarrisonCN/mcp-gateway/security/advisories/new)
  (preferred). Do not open a public issue for an unfixed vulnerability.
- Include the affected version, configuration (redact keys), steps to reproduce and impact.

## 2. Triage (target: 3 working days)

1. Acknowledge the report and open a draft GitHub Security Advisory (GHSA) — all discussion stays there.
2. Reproduce on the latest release of every supported line (see [SECURITY.md](../../SECURITY.md)).
3. Rate severity with CVSS v3.1 and decide the affected range.

| Severity | Examples | Fix target |
|---|---|---|
| Critical | unauthenticated tool execution or admin access, auth bypass, RCE through the gateway | 7 days |
| High | scope / tenant escape, secret disclosure to authenticated clients, signature verification bypass | 14 days |
| Medium | DoS by an authenticated client, information leaks without secrets | next minor |
| Low | hardening gaps, defense in depth | best effort |

## 3. Fix

1. Develop the fix in a private fork of the advisory (GitHub temporary private fork); add a regression test.
2. Release patch versions for every supported line (10.x LTS gets security fixes until 2028-10-31).
3. Request a CVE through the advisory; credit the reporter unless they decline.

## 4. Disclose

1. Publish the advisory together with the releases; the CHANGELOG `### Security` section links it.
2. Note the upgrade path and any workaround (config setting, version pin).
3. Coordinated disclosure: 90 days from the report at the latest, earlier once fixed releases are out.

## 5. Compromised release artifacts

If an npm version, container image or release asset is suspected to be tampered with or built from unreviewed code:

1. **npm**: `npm deprecate @winstonsayno/mcp-gateway@<v> "compromised — upgrade to <fixed>"`; unpublish only within
   npm's policy window and only if no one can depend on it; move the `latest` dist-tag to a good version.
2. **Container image**: delete the affected tags in GHCR, re-tag the last good digest; the cosign signature of a
   rebuilt image must verify against the `docker.yml` workflow identity (see [supply-chain.md](supply-chain.md)).
3. **Credentials**: revoke and rotate the npm token, GitHub tokens and any repository secrets that could have been
   exposed; review recent workflow runs and `git log` on `main` for unexpected changes.
4. Publish an advisory naming the affected versions / digests and the verified replacements.

## 6. Operators: when you suspect an incident in your deployment

1. Revoke exposed keys (`auth.apiKeys[].disabled: true` or remove them — hot reload ends their sessions); rotate
   upstream tokens held in the gateway's environment.
2. Preserve evidence: the audit log (`audit.path`), request history (`GET /api/v1/requests`), container logs.
3. Check `GET /api/v1/security` and `mcp-gateway validate --strict` for posture regressions.
4. Report gateway bugs privately as in step 1.

## Review

This process and the [threat model](threat-model.md) are reviewed at every minor release of a supported line.
