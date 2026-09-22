# Getting Started with mcp-gateway

This guide walks you through setting up mcp-gateway from scratch in under 5 minutes.

## Prerequisites

- Node.js 20 or later
- At least one MCP server you want to manage (e.g., `@modelcontextprotocol/server-filesystem`)

## Step 1: Install

```bash
npm install -g mcp-gateway
```

Verify the installation:

```bash
mcp-gateway --version
# 0.1.0
```

## Step 2: Generate a Config File

```bash
mcp-gateway init
```

This creates `mcp-gateway.yml` in the current directory with two example servers pre-configured.

## Step 3: Edit Your Config

Open `mcp-gateway.yml` and customize it:

```yaml
port: 4000

servers:
  - id: filesystem
    name: Filesystem
    transport: stdio
    command: npx
    args: ["-y", "@modelcontextprotocol/server-filesystem", "/your/project"]
    tags: [files]
```

## Step 4: Start the Gateway

```bash
mcp-gateway start
```

You should see:

```
2026-03-24T00:00:00.000Z [INFO ] Registered MCP server: filesystem (Filesystem)
2026-03-24T00:00:00.000Z [INFO ] ✓ Filesystem — 8 tools available
2026-03-24T00:00:00.000Z [INFO ] mcp-gateway listening on http://0.0.0.0:4000
```

## Step 5: Discover Available Tools

```bash
curl http://localhost:4000/api/v1/tools | jq '.tools[].name'
```

## Step 6: Call a Tool

```bash
curl -X POST http://localhost:4000/api/v1/tools/call \
  -H "Content-Type: application/json" \
  -d '{
    "tool": "list_directory",
    "arguments": { "path": "/your/project" }
  }'
```

## Step 7: Build a Baseline Before Tuning

Collect a simple baseline with current traffic shape before changing config:

```bash
# 1) capture a 60s metrics window snapshot
curl "http://localhost:4000/api/v1/metrics?window=60000" | jq

# 2) run your load profile (example placeholder)
#    keep request mix/payloads stable between runs

# 3) capture metrics again and compare
curl "http://localhost:4000/api/v1/metrics?window=60000" | jq
```

When tuning, prioritize:

- `p95LatencyMs` / `p99LatencyMs` and `successRate`
- `errorsByServer` spikes for unstable upstream MCP servers
- `requestsPerMinute` changes after timeout/concurrency updates

## Next Steps

- [Add authentication](./authentication.md)
- [Set up rate limiting](./rate-limiting.md)
- [Monitor with Prometheus](./monitoring.md)
- [Deploy with Docker](./docker.md)
