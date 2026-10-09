# mcp-gateway

**One authenticated, observable endpoint in front of all your MCP servers.**

[![npm](https://img.shields.io/npm/v/@winstonsayno/mcp-gateway.svg)](https://www.npmjs.com/package/@winstonsayno/mcp-gateway)
[![CI](https://github.com/HarrisonCN/mcp-gateway/actions/workflows/ci.yml/badge.svg)](https://github.com/HarrisonCN/mcp-gateway/actions/workflows/ci.yml)
[![CodeQL](https://github.com/HarrisonCN/mcp-gateway/actions/workflows/codeql.yml/badge.svg)](https://github.com/HarrisonCN/mcp-gateway/actions/workflows/codeql.yml)
[![OpenSSF Scorecard](https://api.securityscorecards.dev/projects/github.com/HarrisonCN/mcp-gateway/badge)](https://securityscorecards.dev/viewer/?uri=github.com/HarrisonCN/mcp-gateway)
[![Node.js](https://img.shields.io/badge/node-%3E%3D22-brightgreen.svg)](https://nodejs.org)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

[Docs](docs/README.md) · [Configuration](docs/configuration.md) · [API reference](docs/api-reference.md) ·
[Deployment](docs/deployment.md) · [Security](SECURITY.md) · [Changelog](CHANGELOG.md) · [中文](docs/README.zh-CN.md)

mcp-gateway sits between AI clients (Claude Code, Cursor, your own agents) and the
[Model Context Protocol](https://modelcontextprotocol.io) servers they use. Instead of every client launching and
authenticating to every server, clients connect once — over MCP Streamable HTTP at `/mcp` or a plain REST API — and
the gateway routes each call to the right upstream with one place for keys, scopes, rate limits, logs and metrics.

```
 Claude Code · Cursor · agents · scripts
                 │  /mcp (Streamable HTTP)  ·  /api/v1 (REST)
                 ▼
 ┌──────────────── mcp-gateway ────────────────┐
 │ auth · scopes · rate limits · policy        │
 │ routing · reconnect · health · metrics · log│
 └──────┬───────────────┬──────────────┬───────┘
        │ stdio         │ HTTP / SSE   │ WebSocket
        ▼               ▼              ▼
   local servers   remote servers   …
```

Try the dashboard with simulated traffic (runs in your browser, no backend): <https://harrisoncn.github.io/mcp-gateway/>

## Quick start

Requires Node.js 22 or newer.

```bash
npx @winstonsayno/mcp-gateway init      # writes mcp-gateway.yml (two example stdio servers)
npx @winstonsayno/mcp-gateway gen-key   # prints a key for clients + its sha256 digest for the config
```

Edit `mcp-gateway.yml` — a minimal, authenticated setup:

```yaml
version: 10
host: 127.0.0.1
port: 4000

auth:
  strategy: api-key
  apiKeys:
    - sha256:<digest printed by gen-key>

security:
  dnsRebindingProtection: true   # Host / Origin checks on /mcp and the API
  authLockout: true              # lock out IPs after repeated failed keys

servers:
  - id: filesystem
    name: Filesystem
    transport: stdio
    command: npx
    args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"]
```

```bash
npx @winstonsayno/mcp-gateway validate --strict   # schema check; exits 2 if there are security warnings
npx @winstonsayno/mcp-gateway start               # or: npm i -g @winstonsayno/mcp-gateway && mcp-gateway start
```

Call it over REST:

```bash
curl -H "Authorization: Bearer $KEY" http://localhost:4000/api/v1/tools
curl -X POST http://localhost:4000/api/v1/tools/call \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"tool": "read_text_file", "arguments": {"path": "/tmp/hello.txt"}}'
```

…or point an MCP client at it:

```bash
claude mcp add --transport http gateway http://localhost:4000/mcp --header "Authorization: Bearer $KEY"
```

```jsonc
// Cursor: ~/.cursor/mcp.json
{ "mcpServers": { "gateway": { "url": "http://localhost:4000/mcp", "headers": { "Authorization": "Bearer <key>" } } } }
```

stdio-only clients can bridge with [`mcp-remote`](https://www.npmjs.com/package/mcp-remote):
`npx mcp-remote http://localhost:4000/mcp --header "Authorization: Bearer <key>"`. The dashboard is at
`http://localhost:4000/dashboard`.

> `init` writes `host: 0.0.0.0` with auth commented out. Either enable auth or bind to `127.0.0.1` before exposing
> the port — `validate` and `start` warn when auth is off on a non-loopback address.

### Docker

Multi-arch images (`linux/amd64`, `linux/arm64`) are published to GHCR with tags `<version>`, `<major>.<minor>`,
`<major>` and `latest`. The image runs as the unprivileged `node` user and looks for `/app/mcp-gateway.yml`.

```bash
docker run -d -p 4000:4000 \
  -v "$PWD/mcp-gateway.yml:/app/mcp-gateway.yml:ro" \
  -v mcp-gateway-data:/app/data \
  -e MCP_GATEWAY_API_KEYS=change-me \
  ghcr.io/harrisoncn/mcp-gateway:10
```

`MCP_GATEWAY_API_KEYS` (comma-separated, plain or `sha256:<hex>`) turns on API-key auth without editing the file.
stdio servers run inside the container, which ships Node.js/npm; install anything else (Python, `uvx`, …) in a derived
image. A Compose example with Prometheus is in [`examples/docker`](examples/docker).

### Kubernetes (Helm)

The chart lives in this repository (it is not published to a chart registry):

```bash
git clone https://github.com/HarrisonCN/mcp-gateway.git && cd mcp-gateway
kubectl create secret generic gw-secrets --from-literal=MCP_GATEWAY_API_KEYS=change-me
helm install gw ./deploy/helm/mcp-gateway --set existingSecret=gw-secrets
```

Gateway config goes in the chart's `config:` value. Pods run non-root with a read-only root filesystem; HPA, PDB,
`ServiceMonitor` and an optional operator (`McpGateway` CRD) are off by default. Liveness / readiness probes use
`/api/v1/health/live` and `/api/v1/health/ready`. See the [Kubernetes guide](docs/guides/kubernetes.md).

## Features

**Core gateway**
- MCP endpoint at `/mcp` (Streamable HTTP; protocol revisions `2025-11-25` back to `2024-11-05`) that aggregates tools,
  resources and prompts from every upstream, including progress, cancellation, logging, completions and subscriptions.
- Upstream transports: `stdio`, `streamable-http`, legacy `sse` and `websocket`, with per-server headers / env.
- REST API under `/api/v1`: tool discovery and calls, resources, prompts, request history, live stats (SSE).
  `GET /api/v1/tools?format=openai|openai-responses|anthropic` returns function-calling schemas for LLM APIs.
- Automatic reconnect with backoff and jitter, MCP `ping` health checks, per-server concurrency limits and timeouts,
  tool allow / deny filters per server.
- Hot reload of servers, keys, limits and CORS when the config file changes (`start --no-watch` to disable).

**Access control**
- Auth: API keys (constant-time compare, `sha256:` digests, expiry / disable), JWT (HMAC, PEM or JWKS; issuer /
  audience / exp checks), OAuth 2.1 resource server per the MCP authorization spec. Misconfiguration fails closed.
- Per-key scopes (server and tool globs, own rate limit) for keys and JWT claims, enforced on REST and `/mcp`;
  tenants with roles; sliding-window rate limits; brute-force lockout.
- Network guards: IP allowlist, Host / Origin checks against DNS rebinding (on by default for a loopback gateway
  without auth), body and argument size limits, security headers with a hash-based CSP.

**Operations**
- Prometheus `/api/v1/metrics`, OpenTelemetry tracing, optional SQLite audit log, secret redaction in logs, history
  and API output.
- Web dashboard: guided setup, live traffic, latency and errors, server health, tool playground, request history.
- Liveness / readiness probes, Docker image, Helm chart, Kubernetes operator.
- CLI: `init`, `validate`, `diff` / `apply` (config against a running gateway), `gen-key` / `hash-key`, `migrate`,
  `bench`, `conformance` (MCP conformance suite against any Streamable HTTP endpoint), `desktop`, `plugin`, `operator`.
- Embeddable as a library (`import { Gateway, loadConfig } from '@winstonsayno/mcp-gateway'`).

**Extended modules** — opt-in under `features:` in the config, each documented in [`docs/guides`](docs/guides):
policy as code and approvals, DLP and prompt-injection sanitising, result and semantic caching, plugins (signed, WASM),
OpenAI / A2A bridges, control plane / data plane, multi-region, workflows, SLA and cost reporting, and more. These
are compact implementations with unit tests, but they have seen far less real-world use than the core; read the guide
and test in your environment before depending on one.

**Experimental (interface-level)**
- **Confidential computing / TEE attestation** ([guide](docs/guides/confidential.md)): the gateway checks a signed
  JSON attestation report from a key you trust, plus measurement allowlists and single-use nonces. It does **not**
  verify native SEV-SNP / TDX / Nitro / SGX evidence or vendor certificate chains, and the report is not bound to the
  upstream connection — treat it as a hook for an external attestation verifier.
- **Post-quantum TLS** ([guide](docs/guides/pq-tls.md)): offers hybrid `X25519MLKEM768` key exchange on upstream
  HTTPS (Streamable HTTP / SSE) connections and can probe what an upstream negotiates. It does not cover the gateway's
  own listener or WebSocket upstreams, and ML-KEM needs OpenSSL 3.5+.

**Client libraries** — TypeScript ([`clients/js`](clients/js), published as `@winstonsayno/mcp-gateway-client`),
Kotlin / JVM / Android ([`clients/kotlin`](clients/kotlin)), Python ([`clients/python`](clients/python)),
Go ([`clients/go`](clients/go)) and Swift ([`clients/swift`](clients/swift)); the non-JS clients are used from source.

## Security posture

The gateway runs tool calls that can read files, call APIs and spend money, so treat it as a privileged service.
Here is what has and has not been checked:

| Done | Not done |
|---|---|
| [Threat model](docs/security/threat-model.md) with trust boundaries, known limitations and per-release audit findings (10.1, 10.2) | No independent third-party security audit |
| CodeQL and OpenSSF Scorecard on every push to `main`; `npm audit --audit-level=high` blocks CI (currently clean) | No continuous / coverage-guided fuzzing — randomized testing is limited to fast-check property tests |
| Property tests (fast-check) for config parsing, JSON-RPC framing, argument limits, JWT / bearer, Host and SAN parsing | The extended modules and experimental features above have not had the same review depth as the core |
| Authorization matrix: every `/api/v1/admin/*` route answers 401 / 403 for unauthenticated and non-operator callers | The gateway does not sandbox stdio servers — they run as the gateway's OS user |

Things to know before deploying:

- **Operators are root-equivalent.** Any unrestricted client can change config, including which commands stdio
  servers run. Give end users scoped keys or tenant roles.
- **Auth is off by default.** Turn it on (`auth.strategy`, or `MCP_GATEWAY_API_KEYS`), or bind to loopback.
- `mcp-gateway validate --strict` fails on security warnings; `GET /api/v1/security` reports the running posture.
- stdio servers do not inherit `MCP_GATEWAY_*` variables, so third-party servers can't read the gateway's own keys.

Hardening checklist: [SECURITY.md](SECURITY.md) and [docs/deployment.md](docs/deployment.md#security-checklist).
Report vulnerabilities privately via
[GitHub security advisories](https://github.com/HarrisonCN/mcp-gateway/security/advisories/new), not in public issues.

## Supported versions

| Version | Status |
|---|---|
| 10.x (LTS) | Bug and security fixes until 2027-10-31, then security fixes only until 2028-10-31 |
| < 10.0 | Unsupported — upgrade with `mcp-gateway migrate --to 10` ([guide](docs/guides/migrating-to-v10.md)) |

The project follows [Semantic Versioning](https://semver.org/). Within 10.x the REST API under `/api/v1`, `/mcp`
behaviour, config schema v10, CLI commands and flags, root library exports and Prometheus metric names change only
in backward-compatible ways. Deep imports, log format, the dashboard and the audit database schema are not covered —
see [stability and versioning](docs/api-reference.md#stability-and-versioning).

## What's New in v10.2

Test-depth release, no new features: fast-check property tests, an authorization matrix over every admin route and
regression tests — plus the fixes they found (replica secrets in `GET /api/v1/servers`, URL credentials in
`GET /api/v1/admin/config`, deep-nesting redaction, and DNS-rebinding protection now on by default for a loopback
gateway without auth). Full history: [CHANGELOG.md](CHANGELOG.md).

## Documentation

| | |
|---|---|
| [Getting started](docs/guides/getting-started.md) | First gateway, step by step |
| [Configuration](docs/configuration.md) | Every config key, env overrides, scopes, hot reload |
| [API reference](docs/api-reference.md) | REST `/api/v1`, admin API, `/mcp`, error codes |
| [Deployment](docs/deployment.md) | Docker, Kubernetes, reverse proxy, systemd, security checklist |
| [Guides](docs/guides) | One page per module, plus migration guides |
| [Threat model](docs/security/threat-model.md) | Data flow, trust boundaries, audit findings |
| [Roadmap](docs/ROADMAP.md) | 10.x hardening plan and what comes after |
| [Dashboard](dashboard/README.md) | The built-in web UI |

## Contributing

```bash
git clone https://github.com/HarrisonCN/mcp-gateway.git && cd mcp-gateway
npm ci
npm run typecheck && npm test
npm run dev -- start -c examples/basic/mcp-gateway.yml
```

See [CONTRIBUTING.md](docs/CONTRIBUTING.md).

## License

[MIT](LICENSE) © 2026 HarrisonCN
