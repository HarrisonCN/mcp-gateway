<div align="center">

<img src="https://raw.githubusercontent.com/HarrisonCN/mcp-gateway/main/docs/assets/logo.svg" alt="mcp-gateway" width="120" />

# mcp-gateway

**A lightweight, open-source gateway for your MCP servers.**

Route · Authenticate · Rate-limit · Monitor — all your [Model Context Protocol](https://modelcontextprotocol.io) servers from a single endpoint.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/node-%3E%3D20.0.0-brightgreen.svg)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.5-blue.svg)](https://www.typescriptlang.org)
[![npm version](https://img.shields.io/badge/npm-v0.2.0-blue.svg)](https://www.npmjs.com/package/mcp-gateway)
[![Docker](https://img.shields.io/badge/docker-ghcr.io-blue.svg)](https://ghcr.io/HarrisonCN/mcp-gateway)

[English](#) · [中文](docs/README.zh-CN.md) · [Docs](docs/) · [Examples](examples/)

</div>

---

## The Problem

As [MCP](https://modelcontextprotocol.io) becomes the standard protocol for AI agents to interact with tools, teams are running **dozens of MCP servers** — filesystem, GitHub, databases, Slack, search, and more. Managing them is chaos:

- Every AI client connects to every server independently
- No central authentication or access control
- No visibility into which tools are being called, by whom, and how often
- No rate limiting to prevent runaway agents from hammering your APIs

**mcp-gateway solves this.** It sits between your AI clients and your MCP servers, acting as a single, observable, secure entry point.

```
┌─────────────────────────────────────────────────────────┐
│                      AI Clients                         │
│   Claude Code · Cursor · Copilot · Your App · Scripts   │
└─────────────────────┬───────────────────────────────────┘
                      │  HTTP / REST
                      ▼
┌─────────────────────────────────────────────────────────┐
│                   mcp-gateway                           │
│                                                         │
│  ┌──────────┐  ┌──────────┐  ┌──────────────────────┐  │
│  │   Auth   │  │  Router  │  │  Metrics / Monitor   │  │
│  │ API Key  │  │ Tool →   │  │  Prometheus · Logs   │  │
│  │   JWT    │  │ Server   │  │  Dashboard           │  │
│  └──────────┘  └──────────┘  └──────────────────────┘  │
│                                                         │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐              │
│  │Rate Limit│  │ Registry │  │  Health  │              │
│  └──────────┘  └──────────┘  └──────────┘              │
└──────┬──────────────┬──────────────┬────────────────────┘
       │              │              │  stdio / SSE / WS
       ▼              ▼              ▼
┌──────────┐  ┌──────────┐  ┌──────────┐
│Filesystem│  │  GitHub  │  │PostgreSQL│  ... more
│  Server  │  │  Server  │  │  Server  │
└──────────┘  └──────────┘  └──────────┘
```

## Features

- **Unified API endpoint** — one URL for all your MCP tools, auto-routed by tool name
- **Authentication** — API key, JWT, or no-auth modes
- **Rate limiting** — per-key sliding window, with standard `X-RateLimit-*` headers
- **Health monitoring** — automatic health checks with configurable intervals
- **Metrics** — Prometheus-compatible `/metrics` endpoint + JSON aggregation
- **Tool discovery** — `GET /api/v1/tools` lists all tools across all servers
- **YAML/JSON config** — simple, declarative configuration with env var overrides
- **Docker-ready** — official Docker image, Compose examples included
- **TypeScript SDK** — embed the gateway as a library in your own project

## Quick Start

### Install

```bash
npm install -g mcp-gateway
# or
npx mcp-gateway init
```

### Configure

```bash
# Generate a default config file
mcp-gateway init

# Edit mcp-gateway.yml to add your servers
```

```yaml
# mcp-gateway.yml
port: 4000

servers:
  - id: filesystem
    name: Filesystem
    transport: stdio
    command: npx
    args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"]

  - id: github
    name: GitHub
    transport: stdio
    command: npx
    args: ["-y", "@modelcontextprotocol/server-github"]
    env:
      GITHUB_PERSONAL_ACCESS_TOKEN: "${GITHUB_TOKEN}"
```

### Run

```bash
mcp-gateway start
# → mcp-gateway listening on http://0.0.0.0:4000
# → ✓ Filesystem — 8 tools available
# → ✓ GitHub — 26 tools available
```

### Call a Tool

```bash
# List all available tools
curl http://localhost:4000/api/v1/tools

# Call a tool (auto-routes to the right server)
curl -X POST http://localhost:4000/api/v1/tools/call \
  -H "Content-Type: application/json" \
  -d '{"tool": "read_file", "arguments": {"path": "/tmp/hello.txt"}}'

# With authentication
curl -X POST http://localhost:4000/api/v1/tools/call \
  -H "Authorization: Bearer your-api-key" \
  -H "Content-Type: application/json" \
  -d '{"tool": "create_issue", "server": "github", "arguments": {"title": "Bug report", "body": "..."}}'
```

## API Reference

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/v1/health` | Gateway health and server summary |
| `GET` | `/api/v1/servers` | List all registered servers |
| `GET` | `/api/v1/servers/:id` | Get server details and tools |
| `GET` | `/api/v1/tools` | List all tools (filterable by `?server=` or `?tag=`) |
| `POST` | `/api/v1/tools/call` | Invoke a tool |
| `GET` | `/api/v1/metrics` | Aggregated metrics (JSON or Prometheus) |
| `GET` | `/api/v1/requests` | Recent request log |

## Performance Baseline Checklist

Use a repeatable baseline before tuning:

1. **Warm up the gateway** and verify all expected servers appear in `GET /api/v1/health`.
2. **Run a fixed load profile** against `POST /api/v1/tools/call` (same tool mix, payload size, and duration).
3. **Capture metrics snapshots** from `GET /api/v1/metrics?window=60000` during the run.
4. **Track and compare**:
   - `totalRequests`, `requestsPerMinute`
   - `successRate`
   - `avgLatencyMs`, `p95LatencyMs`, `p99LatencyMs`
   - `errorsByServer`

Recommended production-oriented starting points:

- Per-server `timeout`: `10000-30000` ms depending on upstream SLA
- Per-server `maxConcurrency`: start at `5-20`, then tune with `p95/p99` latency
- `rateLimit`: always enable for shared gateways
- `monitor.retentionHours`: reduce from `24` to lower values on memory-constrained hosts

## Configuration Reference

```yaml
port: 4000                    # HTTP port (env: MCP_GATEWAY_PORT)
host: 0.0.0.0                 # Bind address (env: MCP_GATEWAY_HOST)
logLevel: info                # debug | info | warn | error

auth:
  strategy: api-key           # none | api-key | jwt
  apiKeys:
    - "your-secret-key"

rateLimit:
  limit: 100                  # Max requests per window
  windowSeconds: 60           # Window duration
  perKey: true                # Per-key or global

monitor:
  requestLog: true            # Log all requests
  prometheus: true            # Enable Prometheus /metrics
  retentionHours: 24          # Metrics retention

corsOrigins:
  - "https://your-app.com"

servers:
  - id: my-server             # Unique identifier
    name: My Server           # Display name
    transport: stdio          # stdio | sse | websocket
    command: npx
    args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"]
    env:
      MY_VAR: "${ENV_VAR}"    # Environment variable substitution
    tags: [files, local]
    enabled: true
    timeout: 30000            # ms
    maxConcurrency: 10
```

## Docker

```bash
# Pull and run
docker run -p 4000:4000 \
  -v $(pwd)/mcp-gateway.yml:/app/mcp-gateway.yml \
  -e GITHUB_TOKEN=ghp_... \
  ghcr.io/harrisonCN/mcp-gateway:latest

# Or with Docker Compose
cd examples/docker
docker compose up
```

## Embed as a Library

```typescript
import { Gateway, loadConfig } from 'mcp-gateway';

const config = await loadConfig('./mcp-gateway.yml');
const gateway = new Gateway(config);

await gateway.start();
// Gateway is now running at http://localhost:4000

// Graceful shutdown
process.on('SIGTERM', () => gateway.stop());
```

## What's New in v0.2.0

| Feature | Description |
|---------|-------------|
| **SSE Transport** | Connect to MCP servers via Server-Sent Events |
| **WebSocket Transport** | Full-duplex WS transport with keep-alive pings |
| **Config Hot Reload** | Edit `mcp-gateway.yml` without restarting |
| **Request Tracing** | `X-Request-Id` on every request & response |
| **CORS Middleware** | Configurable cross-origin support |
| **Web Dashboard** | Live monitoring UI at `/dashboard` |
| **4 Bug Fixes** | Concurrency, id collision, handle leaks, timeouts |

## Roadmap

| Feature | Status |
|---------|--------|
| stdio transport | ✅ Done |
| SSE transport | ✅ Done (v0.2.0) |
| WebSocket transport | ✅ Done (v0.2.0) |
| Config hot reload | ✅ Done (v0.2.0) |
| Web dashboard UI | ✅ Done (v0.2.0) |
| Redis-backed rate limiting | 📋 Planned |
| OAuth2 / OIDC auth | 📋 Planned |
| Tool-level access control (RBAC) | 📋 Planned |
| Request replay & debugging | 📋 Planned |
| Multi-tenant mode | 📋 Planned |
| OpenTelemetry tracing | 📋 Planned |

## Contributing

Contributions are welcome! See [CONTRIBUTING.md](docs/CONTRIBUTING.md).

```bash
git clone https://github.com/HarrisonCN/mcp-gateway.git
cd mcp-gateway
npm install
npm run dev -- start -c examples/basic/mcp-gateway.yml
```

## License

MIT © 2026 [HarrisonCN](https://github.com/HarrisonCN)

---

<div align="center">
  <sub>
    Built for the agentic era · If this helps you, please ⭐ star the repo
  </sub>
</div>
