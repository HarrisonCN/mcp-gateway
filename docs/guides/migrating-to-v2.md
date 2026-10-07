# Migrating from 1.x to 2.0

2.0 is a small breaking release: most 1.x configurations run unchanged.

## Breaking changes

| Change | What to do |
|---|---|
| **Node.js 22 or newer** (`engines.node >=22`). Node 20 is no longer tested or supported. | Upgrade the runtime. The Docker image already uses `node:22-alpine`. |
| **`SIGHUP` reloads the configuration** instead of terminating the process (Node's default). | If a supervisor sends `SIGHUP` to stop the gateway, send `SIGTERM` instead. |
| **Plugin refusals use the policy error path**: `-32006` is added to the codes the REST API maps to `403`. | Clients that switch on `code` should treat `-32006` like `-32003`. The JS / Kotlin clients' `isPolicyError` covers it from 2.0. |
| **`ConfigWatcher` stays inert after `stop()`** — `reloadNow()` is a no-op once stopped. | Only relevant when embedding the watcher. |
| `plugins` and `configDir` are new top-level config keys (`configDir` is set by `loadConfig`). | Do not use `plugins` for anything else in your config files. |

## New

- [Plugins](plugins.md): `onRequest` middleware, `onToolCall` before policy, `onResponse` after the output filter.
- Hot reload on `SIGHUP`, also with `--no-watch` (`kill -HUP <pid>`, `docker kill -s HUP <container>`).
- `plugins:` hot reload; `Gateway.getPlugins()`.

## Checklist

1. `node --version` ≥ 22.
2. `npx mcp-gateway validate -c mcp-gateway.yml`.
3. Replace any `SIGHUP`-to-stop usage with `SIGTERM`.
4. Update clients to ≥ 2.0 if you rely on `isPolicyError`.
