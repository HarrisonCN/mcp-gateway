# Kernel plugin SDK (10.5)

Write a gateway extension the way the built-in feature modules are written: **call hooks**, a **validated config**
and **HTTP routes** in one plugin object. It builds on plugin API v5 (`docs/guides/plugins-v5.md`) — everything here
is additive, existing plugins load unchanged.

```js
// plugins/notes.mjs
import { definePlugin } from '@winstonsayno/mcp-gateway';
import { z } from 'zod';

export default definePlugin({
  name: 'notes',
  // Validates plugins[].options at load; a failure refuses the plugin (startup / hot reload fails).
  configSchema: z.object({ max: z.number().int().positive().default(100) }).strict(),
  routes: {
    // GET/POST /api/v1/admin/plugins/notes/...  — operators only
    admin: (router, ctx) => {
      router.get('/', (_req, res) => res.json({ options: ctx.options, tools: ctx.tools().length }));
      router.post('/echo', async (req, res) => res.json(await ctx.invoke('local', 'echo', req.body, ctx.clientOf(req))));
    },
    // /api/v1/features/plugins/notes/...  — any authenticated client
    client: (router, ctx) => {
      router.post('/', (req, res) => {
        const n = (ctx.state.get("count") ?? 0) + 1;
        if (n > ctx.options.max) return res.status(429).json({ error: 'full' });
        ctx.state.set('count', n);
        res.status(201).json({ count: n, by: ctx.clientOf(req) });
      });
    },
  },
  onToolCall: (call) => (call.name === 'rm' ? { action: 'deny', reason: 'rm is disabled' } : { action: 'continue' }),
});
```

```yaml
plugins:
  - module: ./plugins/notes.mjs
    options: { max: 50 }
    timeoutMs: 200        # per onToolCall / onResponse call; a timeout fails the call closed (-32006)
```

## What a plugin gets

| | |
|---|---|
| `configSchema` | A zod schema (anything with `safeParse`) or `(options) => string[]` (error messages). The parsed value becomes `ctx.options` in routes. |
| `routes.admin(router, ctx)` | Express router mounted at `/api/v1/admin/plugins/<name>` behind auth + the operator check (same as built-in admin modules). |
| `routes.client(router, ctx)` | Mounted at `/api/v1/features/plugins/<name>` for any authenticated client. **You** decide what a client may do — `ctx.invoke` does not apply the caller's key scopes. |
| `ctx.tools()` | Tools the gateway serves (`serverId`, `name`, `description`). |
| `ctx.invoke(server, tool, args, clientId?)` | Call a tool through the full pipeline (policy, policy engine, DLP, cache, quotas, audit). |
| `ctx.state` | The plugin's key-value store, shared with its hooks (API v4+). |
| `ctx.clientOf(req)` | Client id of the request (`key:<name>`, `jwt:<sub>`, …). |
| `plugins[].timeoutMs` | Time limit per hook call for module plugins (WASM components keep `limits.timeoutMs`). |

Routes are rebuilt whenever the plugin set changes (hot reload of `plugins`); requests to a plugin without routes
get `404`. A body larger than 1 MB is rejected.

## Isolation and trust

- JS module plugins run in the gateway process: they are trusted code. Sign them and set
  `pluginTrust.requireSigned: true` (`mcp-gateway plugin keygen / sign / verify`) so only reviewed files load.
- For untrusted extensions use WASM component plugins (`component:`), which run in a sandbox per tenant / client with
  memory and time limits — they implement hooks only, not routes.
- Hooks fail closed: an exception or a `timeoutMs` overrun refuses the call with `-32006`.

`GET /api/v1/plugins` lists loaded plugins and their hooks. Tested in `test/plugin-sdk-10-5.test.ts`.
