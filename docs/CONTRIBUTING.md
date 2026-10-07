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
│   ├── index.ts        # Gateway bootstrap, HTTP server, hot reload
│   ├── api.ts          # Express route handlers (hot-swappable auth / rate limit)
│   └── supervisor.ts   # Connect + automatic reconnect with backoff
├── registry/
│   └── index.ts        # Server registry & health state
├── proxy/
│   └── index.ts        # Transport-independent MCP session layer
├── transport/
│   ├── channel.ts      # UpstreamChannel interface
│   ├── stdio.ts        # child process, newline-delimited JSON-RPC
│   ├── streamable-http.ts  # MCP Streamable HTTP (2025-03-26+)
│   ├── sse.ts          # MCP HTTP+SSE (2024-11-05)
│   ├── websocket.ts    # WebSocket ("mcp" subprotocol)
│   └── sse-parser.ts   # incremental text/event-stream parser
├── auth/
│   ├── middleware.ts   # Auth middleware (API key, JWT)
│   └── ratelimit.ts    # Rate limiting middleware
├── monitor/
│   └── index.ts        # Metrics collection & Prometheus export
├── config/
│   ├── loader.ts       # YAML/JSON config loading & validation
│   └── watcher.ts      # config file watcher (hot reload)
└── utils/
    ├── types.ts        # Shared TypeScript types
    └── logger.ts       # Structured logger
```

## Adding a New Transport

Transports are small *channels* that only move JSON-RPC messages; the MCP
handshake, request correlation, timeouts/cancellation, `maxConcurrency` and
reconnects are shared and need no changes.

1. Implement `UpstreamChannel` (`src/transport/channel.ts`) in `src/transport/<name>.ts`:
   `start()`, `send()`, `close()`, and call `onmessage` / `onclose` (only for
   *unexpected* loss — the supervisor reconnects on it).
2. Add the transport name to `ServerTransport` (`src/utils/types.ts`), the config
   schema (`src/config/loader.ts`) and `defaultChannelFactory` (`src/proxy/index.ts`).
3. Add tests in `test/transports.test.ts`. Where possible test against the
   official SDK server (see `test/fixtures/remote-servers.ts`); stdio tests use
   `test/fixtures/fake-mcp-server.mjs`.

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
