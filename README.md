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

It is not tied to one model vendor or one kind of client:

- **Any LLM with function calling** — OpenAI, xAI Grok, DeepSeek and other OpenAI-compatible APIs, or Anthropic
  Claude: fetch the tools in the provider's format and execute the model's tool calls through the gateway
  ([Use with any LLM](#use-with-any-llm)).
- **Web pages and apps** — browser front-ends, mobile and desktop apps reach the same tools over REST or the client
  libraries (JS, Kotlin/Android, Swift/iOS, Python, Go), with keys kept out of the bundle
  ([Use from web pages and apps](#use-from-web-pages-and-apps)).

```
 Claude Code · Cursor · agents · LLM apps (OpenAI, Grok, DeepSeek, Claude) · web / mobile apps
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
version: 11
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

> `init` writes `host: 127.0.0.1` with auth commented out. Without auth the gateway **refuses to start** on a
> non-loopback address: configure auth before binding to `0.0.0.0`, or — only on a trusted network — pass
> `start --insecure` (`security.insecure: true`).

### Docker

Multi-arch images (`linux/amd64`, `linux/arm64`) are published to GHCR with tags `<version>`, `<major>.<minor>`,
`<major>` and `latest`, signed with cosign (keyless) and carrying SLSA provenance and SBOM attestations — see
[supply chain](docs/security/supply-chain.md) for `cosign verify`. The image runs as the unprivileged `node` user and looks for `/app/mcp-gateway.yml`.

```bash
docker run -d -p 4000:4000 \
  -v "$PWD/mcp-gateway.yml:/app/mcp-gateway.yml:ro" \
  -v mcp-gateway-data:/app/data \
  -e MCP_GATEWAY_API_KEYS=change-me \
  ghcr.io/harrisoncn/mcp-gateway:11
```

(`:10` stays on the last 10.x LTS release.)

`MCP_GATEWAY_API_KEYS` (comma-separated, plain or `sha256:<hex>`) turns on API-key auth without editing the file.
stdio servers run inside the container, which ships Node.js/npm; install anything else (Python, `uvx`, …) in a derived
image. A Compose example with Prometheus is in [`examples/docker`](examples/docker).

### Kubernetes (Helm)

The chart lives in this repository (it is not published to a chart registry):

```bash
git clone https://github.com/HarrisonCN/mcp-gateway.git && cd mcp-gateway
kubectl create secret generic gw-secrets --from-literal=MCP_GATEWAY_API_KEYS=sha256:<hash from gen-key>
helm install gw ./deploy/helm/mcp-gateway --set existingSecret=gw-secrets
```

An API key is required: without `existingSecret` (or `apiKeys` / `config.auth`) the chart fails at install time with
a message explaining how to provide one. `--set security.insecure=true` is the explicit, warned opt-out for trusted
networks. See the [chart README](deploy/helm/mcp-gateway/README.md).

Gateway config goes in the chart's `config:` value. Pods run non-root with a read-only root filesystem; HPA, PDB,
`ServiceMonitor` and an optional operator (`McpGateway` CRD) are off by default. Liveness / readiness probes use
`/api/v1/health/live` and `/api/v1/health/ready`. See the [Kubernetes guide](docs/guides/kubernetes.md).

## Use with any LLM

The gateway does not call a model itself; your code does. `GET /api/v1/tools?format=…` returns the tools the caller's
key may use in the provider's function-calling format, plus a `mapping` from the (sanitized) LLM tool name to the
gateway `{ server, tool }`. Execute each tool call the model makes with `POST /api/v1/tools/call` — scopes, policy,
rate limits and the audit log apply exactly as for any other client.

| Provider | Tools format | API |
|---|---|---|
| OpenAI | `format=openai` (Chat Completions) or `format=openai-responses` (Responses API) | `https://api.openai.com/v1` |
| DeepSeek | `format=openai` (OpenAI-compatible Chat Completions) | `https://api.deepseek.com` |
| xAI Grok | `format=openai-responses` (xAI's recommended Responses API) or `format=openai` (Chat Completions) | `https://api.x.ai/v1` |
| Anthropic Claude | `format=anthropic` (Messages API `tools`) | Anthropic SDK |
| other OpenAI-compatible APIs | `format=openai` | their base URL |

A complete loop with the OpenAI SDK — switch provider by changing `LLM_BASE_URL` / `LLM_MODEL`
([examples/llm-tools](examples/llm-tools)):

```js
import OpenAI from 'openai';
const gw = (path, init = {}) => fetch(`http://127.0.0.1:4000/api/v1${path}`, { ...init,
  headers: { 'content-type': 'application/json', authorization: `Bearer ${process.env.GATEWAY_KEY}` } });

const llm = new OpenAI({ apiKey: process.env.LLM_API_KEY, baseURL: process.env.LLM_BASE_URL }); // e.g. https://api.deepseek.com
const { tools, mapping } = await (await gw('/tools?format=openai')).json();
const messages = [{ role: 'user', content: 'List the files in /tmp' }];
for (let round = 0; round < 8; round++) {
  const msg = (await llm.chat.completions.create({ model: process.env.LLM_MODEL, messages, tools })).choices[0].message;
  messages.push(msg);
  if (!msg.tool_calls?.length) { console.log(msg.content); break; }
  for (const call of msg.tool_calls) {
    const { server, tool } = mapping[call.function.name];
    const out = await (await gw('/tools/call', { method: 'POST',
      body: JSON.stringify({ server, tool, arguments: JSON.parse(call.function.arguments || '{}') }) })).json();
    messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(out.result ?? out) });
  }
}
```

Alternatives: the JS client wraps this as `toolSchemas()` / `callLlmTool()` ([clients/js](clients/js)), and the
[OpenAI-compatible bridge](docs/guides/bridges.md) (`openai:` with `upstream.baseUrl`) can run the whole loop inside
the gateway — point any OpenAI-compatible SDK at `http://<gateway>/openai/v1` and the gateway injects its tools,
executes them and returns the final answer. Model names change often; check each provider's documentation. These
are plain HTTP integrations, not partnerships with or endorsements by any model vendor.

## Use from web pages and apps

Front-ends and apps call the gateway like any other client: REST under `/api/v1` (or `/mcp`), directly or through
the client libraries — [JS / TypeScript](clients/js) (browsers, React Native, Node, Deno, Bun),
[Kotlin / Android](clients/kotlin), [Swift / iOS / macOS](clients/swift), [Python](clients/python) and
[Go](clients/go).

**Never ship a long-lived API key in a browser bundle or an app binary** — anyone can extract it and call every tool
in its scope. Use one of these instead:

1. **Your backend in the middle** (simplest): the page / app talks to your server, which holds the gateway key and
   calls the gateway.
2. **Short-lived, scoped JWTs**: your backend signs in the user and mints a token the gateway verifies; the app
   sends it as `Authorization: Bearer <jwt>`.

```yaml
auth:
  strategy: jwt
  jwt:
    jwksUrl: https://auth.example.com/.well-known/jwks.json   # or publicKey / jwtSecret
    issuer: https://auth.example.com/
    audience: mcp-gateway
    requireExp: true             # reject tokens without "exp"
    maxTokenAgeSeconds: 900      # and tokens issued more than 15 minutes ago
# token claims mcp_servers / mcp_tools narrow what each token may call, like a scoped key
cors:
  origins: ["https://app.example.com"]        # browser origins allowed to call /api/v1
mcp:
  allowedOrigins: ["https://app.example.com"]  # browser origins allowed on /mcp
security:
  allowedHosts: ["gateway.example.com"]        # reject other Host headers
  authLockout: true
```

Server-side API keys can also carry scopes (`servers`, `tools`), their own `rateLimit` and an `expiresAt` — see
[Configuration](docs/configuration.md#per-key-scopes). Terminate TLS in front of the gateway.

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

**Extended modules** — opt-in under `features:` in the config (since 11.0 a module is loaded only when its section is
configured), each documented in [`docs/guides`](docs/guides):
policy as code and approvals, [Cedar / OPA policies](docs/guides/policy-engine.md) with tests and impact analysis,
[time-travel replay](docs/guides/time-travel.md), [real-time cost / carbon budgets](docs/guides/realtime-budgets.md),
[durable task graphs](docs/guides/task-graphs.md) (cross-gateway, checkpoints, resume, compensation),
DLP and prompt-injection sanitising, result and semantic caching, plugins (signed, WASM, and the
[kernel plugin SDK](docs/guides/plugin-sdk.md) for hooks + config + routes),
OpenAI / A2A bridges, control plane / data plane, multi-region, SLA and cost reporting, and more. These
are compact implementations with unit tests, but they have seen far less real-world use than the core; read the guide
and test in your environment before depending on one.

**Experimental** — `validate`, startup and `GET /api/v1/security` print an EXPERIMENTAL notice when one is enabled.
- **Confidential computing / TEE attestation** ([guide](docs/guides/confidential.md)): the gateway checks a signed
  JSON attestation report from a key you trust, plus measurement allowlists and single-use nonces. It does **not**
  verify native SEV-SNP / TDX / Nitro / SGX evidence or vendor certificate chains, and the report is not bound to the
  upstream connection — treat it as a hook for an external attestation verifier.
- **Post-quantum TLS** ([guide](docs/guides/pq-tls.md)): offers hybrid `X25519MLKEM768` key exchange on upstream
  HTTPS (Streamable HTTP / SSE) connections and can probe what an upstream negotiates. It does not cover the gateway's
  own listener or WebSocket upstreams, and ML-KEM needs OpenSSL 3.5+.
- **Edge autonomy** ([guide](docs/guides/edge-autonomy.md)): while an upstream is unreachable, answers matching calls
  from the last good result or a local WASM tool, queues them into an outbox, or refuses them, and replays the outbox
  on reconnect. No conflict resolution (rejected replays are parked for an operator), at-least-once replay.
- **Privacy computing** ([guide](docs/guides/privacy.md)): protected tools answer only Laplace-noised aggregates
  (count / sum / mean / histogram) with per-client ε budgets, and federated queries combine noisy results from peer
  gateways so raw rows stay in their domain. The guarantee assumes one row per person and data-independent bounds.
- **Post-quantum identity** ([guide](docs/guides/pq-identity.md)): Ed25519 + ML-DSA hybrid signatures for a gateway
  identity document, a signed tool manifest, a hash-chained audit log with signed checkpoints, and plugin artifacts.
  ML-DSA uses `node:crypto` where the runtime has it, otherwise `@noble/post-quantum` (not independently audited); no
  X.509 hybrid certificates.

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
- **No auth means loopback only.** Turn auth on (`auth.strategy`, or `MCP_GATEWAY_API_KEYS`); without it the
  gateway refuses to start on a non-loopback address unless you pass `--insecure`. The Helm chart requires an API key.
- `mcp-gateway validate --strict` fails on security warnings; `GET /api/v1/security` reports the running posture.
- Releases: signed container images, CycloneDX / SPDX SBOMs and checksums on each GitHub Release, Trivy and
  `npm audit` in CI, Dependabot — [supply chain](docs/security/supply-chain.md),
  [incident response](docs/security/incident-response.md).
- stdio servers do not inherit `MCP_GATEWAY_*` variables, so third-party servers can't read the gateway's own keys.

Hardening checklist: [SECURITY.md](SECURITY.md) and [docs/deployment.md](docs/deployment.md#security-checklist).
Report vulnerabilities privately via
[GitHub security advisories](https://github.com/HarrisonCN/mcp-gateway/security/advisories/new), not in public issues.

## Supported versions

| Version | Status |
|---|---|
| 11.x (current) | New features, bug and security fixes |
| 10.x (LTS) | Bug and security fixes until 2027-10-31, then security fixes only until 2028-10-31 |
| < 10.0 | Unsupported — upgrade with `mcp-gateway migrate` ([10.0 guide](docs/guides/migrating-to-v10.md), [11.0 guide](docs/guides/migrating-to-v11.md)) |

Upgrading from 10.x: `npx @winstonsayno/mcp-gateway@11 migrate --write` rewrites the config to schema v11 — see
[Migrating to 11.0](docs/guides/migrating-to-v11.md).

The project follows [Semantic Versioning](https://semver.org/). Within a major line the REST API under `/api/v1`,
`/mcp` behaviour, the config schema (v11 for 11.x, v10 for 10.x), CLI commands and flags, root library exports and
Prometheus metric names change only in backward-compatible ways. Deep imports, log format, the dashboard and the
audit database schema are not covered — see [stability and versioning](docs/api-reference.md#stability-and-versioning).

## What's New in v10.9

Bridge to 11.0. **Config schema v11** and the **lazy modular kernel** (`kernel.modules: lazy` — only configured
feature modules are mounted) are available now, and what 11.0 removes is deprecated: schema v10 and the 6.2
workflow engine (task graphs replace it). `mcp-gateway migrate --to 11` rewrites a config — including workflows →
task graphs — keeping comments. Existing `version: 10` configs keep working on 10.x (LTS). See
[Migrating to 11.0](docs/guides/migrating-to-v11.md). Earlier in 10.x: privacy computing and post-quantum identity
(10.8), task graphs and edge autonomy (10.7), time-travel replay and real-time budgets (10.6), plugin SDK and Cedar /
OPA (10.5), signed images and SBOMs (10.4), secure defaults (10.3). Full history: [CHANGELOG.md](CHANGELOG.md).

## Documentation

| | |
|---|---|
| [Getting started](docs/guides/getting-started.md) | First gateway, step by step |
| [Configuration](docs/configuration.md) | Every config key, env overrides, scopes, hot reload |
| [API reference](docs/api-reference.md) | REST `/api/v1`, admin API, `/mcp`, error codes |
| [Deployment](docs/deployment.md) | Docker, Kubernetes, reverse proxy, systemd, security checklist |
| [Guides](docs/guides) | One page per module, plus migration guides |
| [Threat model](docs/security/threat-model.md) | Data flow, trust boundaries, audit findings |
| [Roadmap](docs/ROADMAP.md) | 10.x / 11.0 release plan and what comes after |
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
