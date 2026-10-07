# mcp-gateway Dashboard

A lightweight, zero-dependency web dashboard for monitoring your mcp-gateway instance in real time.

## Features

- Live server status (online / degraded / reconnecting / offline) with next retry and reconnect count
- Tool inventory across all registered servers
- Request log with method, tool name, duration, and HTTP status
- Aggregate metrics: total requests, error rate, average / p95 latency, uptime
- Works with auth enabled: paste an API key or JWT in the header (kept in `sessionStorage`, or `localStorage` with “remember”), sent as `Authorization: Bearer …`
- Auto-refreshes every 10 seconds; manual refresh button available

## Access

When the gateway is running, the dashboard is served at:

```
http://localhost:4000/dashboard
```

It reads data exclusively from the gateway's own REST API (`/api/v1/*`), so no additional backend is needed.
The page itself is a static shell without data; disable it with `dashboard: { enabled: false }`.

## Screenshot

The dashboard uses a GitHub-dark colour scheme and is fully responsive down to mobile widths.
