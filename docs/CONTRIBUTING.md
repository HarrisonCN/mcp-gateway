# Contributing to mcp-gateway

Thank you for your interest in contributing! This document explains how to get started.

## Development Setup

```bash
git clone https://github.com/HarrisonCN/mcp-gateway.git
cd mcp-gateway
npm install

# Run in development mode (hot reload)
npm run dev -- start -c examples/basic/mcp-gateway.yml

# Type checking
npm run typecheck

# Run tests
npm test
```

## Project Structure

```
src/
├── cli.ts              # CLI entry point
├── index.ts            # Public library API
├── gateway/
│   ├── index.ts        # Gateway bootstrap & HTTP server
│   └── api.ts          # Express route handlers
├── registry/
│   └── index.ts        # Server registry & lifecycle
├── proxy/
│   └── index.ts        # MCP stdio/SSE/WS proxy
├── auth/
│   ├── middleware.ts   # Auth middleware (API key, JWT)
│   └── ratelimit.ts    # Rate limiting middleware
├── monitor/
│   └── index.ts        # Metrics collection & Prometheus export
├── config/
│   └── loader.ts       # YAML/JSON config loading & validation
└── utils/
    ├── types.ts        # Shared TypeScript types
    └── logger.ts       # Structured logger
```

## Adding a New Transport

Currently, only `stdio` transport is fully implemented. To add `sse` or `websocket`:

1. Add the connection logic in `src/proxy/index.ts`
2. Handle the new transport type in the `connect()` method
3. Add tests in `test/proxy.test.ts` (see `test/fixtures/fake-mcp-server.mjs`)

## Pull Request Guidelines

1. Fork the repository and create a feature branch
2. Write tests for new functionality
3. Ensure `npm run typecheck` and `npm test` pass
4. Keep PRs focused — one feature or fix per PR
5. Write a clear PR description explaining the motivation

## Reporting Issues

Use [GitHub Issues](https://github.com/HarrisonCN/mcp-gateway/issues). Include:

- mcp-gateway version
- Node.js version
- Config file (redact secrets)
- Steps to reproduce
- Expected vs actual behavior

## Code Style

- TypeScript strict mode — no `any` unless absolutely necessary
- Async/await over raw Promises
- Descriptive variable names
- JSDoc for all public APIs
