# Plugins

Plugins add behaviour to the gateway without forking it. A plugin is an ES module whose default export is a plugin
object, or a factory that receives a context and returns one.

```yaml
plugins:
  - module: ./plugins/tenant-header.mjs   # relative to the config file, or a package name
    options: { header: x-tenant }
  - module: '@acme/mcp-gateway-audit'
    enabled: false
```

```js
// plugins/tenant-header.mjs
export default (ctx) => ({
  name: 'tenant-header',
  apiVersion: 1,
  onRequest(req, res, next) {                       // Express middleware
    if (!req.headers[ctx.options.header]) return res.status(400).json({ error: 'missing tenant' });
    next();
  },
  onToolCall(call) {                                // before policy rules
    if (call.name === 'delete_repo') return { deny: 'not through the gateway' };
    if (call.name === 'search') return { arguments: { ...call.arguments, limit: 20 } };
    // return { respond: { content: [...] } } to answer without contacting the server
  },
  onResponse(call, result) {                        // after the output filter
    ctx.logger.info(`${call.serverId}/${call.name} → ${result.success}`);
    return result;                                  // or a replacement ProxyResponse
  },
  close() {},                                       // stop, or unloaded by a config reload
});
```

## Hook order

```
HTTP request ─▶ request id ▶ security headers ▶ IP allowlist ▶ Host check ▶ onRequest ▶ CORS ▶ auth / rate limit ▶ route
upstream call ─▶ onToolCall ▶ policy rules / approval ▶ upstream server ▶ output filter ▶ onResponse ▶ metrics, log, trace
```

- Hooks run in configuration order (plugins passed in code via `new Gateway(config, { plugins })` run first).
- `onToolCall` / `onResponse` run for every upstream call from REST and `/mcp`: tools, `resources/read` and
  `prompts/get` (`call.kind` is `tool`, `resource` or `prompt`). `call.state` is a per-call `Map` shared by both hooks.
- The first `deny` or `respond` wins; later plugins and the policy are skipped.
- **Fail closed**: a hook that throws refuses the call with JSON-RPC `-32006` (REST `403`, `code: -32006`,
  `policy.plugin`). Refusals are recorded in the request log like policy refusals.
- A plugin that cannot be loaded stops the gateway from starting. On hot reload (file change or `SIGHUP`) the
  `plugins:` block is re-read; when it changed, the new set is loaded and the old instances are closed. If loading fails
  the current plugins are kept and the error is logged.

## Context

| Field | |
|---|---|
| `ctx.options` | the entry's `options` |
| `ctx.logger` | the gateway logger |
| `ctx.gatewayVersion` | e.g. `2.0.0` |
| `ctx.apiVersion` | plugin API implemented by the gateway (`1`) |

A plugin declaring a higher `apiVersion` than the gateway implements is refused at load.

TypeScript types: `import type { GatewayPlugin, PluginFactory } from '@winstonsayno/mcp-gateway'`.
