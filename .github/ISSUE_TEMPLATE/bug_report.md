---
name: Bug Report
about: Report a bug in mcp-gateway
title: '[Bug] '
labels: bug
assignees: ''
---

## Describe the Bug

A clear and concise description of what the bug is.

## Steps to Reproduce

1. Config file (redact secrets):
```yaml
# paste your mcp-gateway.yml here
```

2. Command run:
```bash
mcp-gateway start
```

3. Request made:
```bash
curl ...
```

4. Error observed:
```
paste error output here
```

## Expected Behavior

What you expected to happen.

## Environment

- mcp-gateway version: `mcp-gateway --version`
- Node.js version: `node --version`
- OS: (e.g., macOS 14, Ubuntu 22.04, Windows 11)
- MCP servers in use: (e.g., `@modelcontextprotocol/server-filesystem`) and their transports
- Interface: REST `/api/v1` · MCP `/mcp` (which client?) · JS / Kotlin client
- Deployment: npm · Docker (`ghcr.io/harrisoncn/mcp-gateway:<tag>`) · Kubernetes
