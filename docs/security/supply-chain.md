# Supply chain (10.4)

What is produced for each release, how it is checked, and how to verify it yourself.

| Artifact | Where | Integrity / provenance |
|---|---|---|
| npm package `@winstonsayno/mcp-gateway` | npmjs.com | published from a maintainer machine (not CI), so **no npm provenance attestation**; the same tarball (`npm pack`) is attached to the GitHub Release with `SHA256SUMS` |
| Container image `ghcr.io/harrisoncn/mcp-gateway` | GHCR, tags `<version>`, `<major>.<minor>`, `<major>`, `latest` | **signed with cosign keyless** (Sigstore, GitHub OIDC identity of `docker.yml`), BuildKit **SLSA provenance** and **SBOM** attestations |
| SBOMs | GitHub Release assets | `mcp-gateway-<version>.cdx.json` (CycloneDX 1.5) and `.spdx.json` (SPDX 2.3) of the production dependency tree (`npm sbom --omit dev`) |
| JS client `@winstonsayno/mcp-gateway-client` | npmjs.com | published from CI with `npm publish --provenance` |

## Verify the container image

```bash
cosign verify ghcr.io/harrisoncn/mcp-gateway:11 \
  --certificate-identity-regexp '^https://github.com/HarrisonCN/mcp-gateway/.github/workflows/docker.yml@' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com
```

A successful verification proves the image digest was signed by this repository's `Docker image` workflow (the
certificate also names the tag / commit that triggered it). Pin the digest it prints in production manifests.

BuildKit attestations (provenance and image SBOM):

```bash
docker buildx imagetools inspect ghcr.io/harrisoncn/mcp-gateway:11 --format '{{ json .Provenance }}'
docker buildx imagetools inspect ghcr.io/harrisoncn/mcp-gateway:11 --format '{{ json .SBOM }}'
```

## Verify the npm package against the release

```bash
V=10.4.0
curl -sLO https://github.com/HarrisonCN/mcp-gateway/releases/download/v$V/SHA256SUMS
npm pack @winstonsayno/mcp-gateway@$V && grep "winstonsayno-mcp-gateway-$V.tgz" SHA256SUMS | sha256sum -c -
```

The release tarball is built by CI from the tagged commit and the npm tarball by `npm pack` locally from the same
commit; if a checksum ever differs, compare the file lists (`tar tzf`) and report it (see
[incident response](incident-response.md)).

## Scanning and updates

- **CI on every pull request** (`.github/workflows/ci.yml`, job *Supply chain*):
  - `npm audit --audit-level=high` (blocking);
  - **Trivy** filesystem scan of every lockfile in the repository — blocking on fixable HIGH / CRITICAL;
  - the container image is built and **Trivy**-scanned — blocking on fixable CRITICAL; fixable HIGH findings are
    printed (they currently come from the npm CLI bundled in the official `node:22-alpine` base image, which the image
    keeps so stdio servers can run through `npx`);
  - image smoke test: the container must refuse to start without auth and serve with `MCP_GATEWAY_API_KEYS`;
  - CycloneDX / SPDX SBOM generation.
- **After each release** the published image is signed, the signature verified, and a Trivy report uploaded to
  GitHub code scanning (category `trivy-image`).
- **CodeQL** (`codeql.yml`) and **OpenSSF Scorecard** (`scorecard.yml`) run on `main`.
- **Dependabot** (`.github/dependabot.yml`) opens weekly update PRs for npm (gateway + JS client), Gradle, pip, Go
  modules, GitHub Actions and the Docker base image. Majors are ignored and adopted by hand (they have broken CI
  before). Dependabot security updates are handled like any other PR: CI must be green.

## Known gaps

- No npm provenance for the main package until it is published from CI.
- The Kotlin, Swift, Python and Go clients are outside this document (Swift and Python are installed from the
  repository; Go modules are checked by the Go checksum database).
- Trivy and `npm audit` only know published advisories; they are not a substitute for reviewing new dependencies.
