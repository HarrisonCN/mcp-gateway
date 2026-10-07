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

## Step 7: Open the Dashboard

Visit `http://localhost:4000/dashboard`. If you enabled auth, paste your API key in the header field.

## Next Steps

- [Remote servers, reconnect and hot reload](./remote-servers.md)
- [Configuration reference](../../README.md#configuration-reference) — auth, rate limiting, CORS
- [Monitor with Prometheus](../../examples/docker/prometheus.yml)
- [Deploy with Docker](../../examples/docker/docker-compose.yml)
