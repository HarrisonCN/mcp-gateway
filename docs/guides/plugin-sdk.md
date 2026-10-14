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
    runtime: worker       # explicit: 14.x defaults to inline, 15.0 to worker
    options: { max: 50 }
    timeoutMs: 200        # per onToolCall / onResponse call; a timeout fails the call closed (-32006)
```

## Start from the template: `plugin init` and `plugin doctor` (15.2)

```bash
mcp-gateway plugin init pii-guard -d ./plugins       # pii-guard.mjs, pii-guard.config.yaml, pii-guard.test.mjs
node --test ./plugins/pii-guard.test.mjs              # unit-test the hook logic without a gateway
mcp-gateway plugin doctor -c gateway.yaml             # load every module plugin like the gateway does and check it
```

`plugin init <name>` (`--runtime worker|process`, default `worker`; `--force` to overwrite) writes:

- `<name>.mjs` — a plugin API v5 module that imports nothing but `node:` built-ins (so one `plugin sign` signature
  covers the whole plugin), with an options check (`configSchema`) and an `onToolCall` hook;
- `<name>.config.yaml` — the `plugins[]` entry for it: `runtime: worker`, `failure: closed`, explicit `limits`
  (`timeoutMs`, `memoryMb`, `maxConcurrent`) and narrow `permissions` (`args: read`, `response: read`,
  `hooks: [onToolCall]`, `network: false`, `env: []`);
- `<name>.test.mjs` — `node --test` unit tests.

`plugin doctor` (`-c <config>`, `--json`) loads each module plugin of the config through the same path as the gateway
(signature check, runtime, options validation) and reports one line per check — `pass`, `warn` or `fail`:

| Check | Fails when | Warns when |
|---|---|---|
| `config` | the config file is invalid | — |
| `load` | the plugin does not load (import error, invalid options, refused signature) | — |
| `runtime` | — | `runtime: inline` (shared heap; no network / env / fs permissions) |
| `api` | `apiVersion` outside the supported range | no `apiVersion` |
| `hooks` | — | `permissions.hooks` missing, or it names hooks the plugin lacks / omits hooks it implements |
| `network` | — | `permissions.network` undeclared (unrestricted egress) or `['*']` |
| `limits` | — | `limits.timeoutMs` / `memoryMb` not set |
| `secrets` | `permissions.secrets` names a secret not granted in `plugins[].secrets` | — |
| `signature` | `features.pluginTrust` requires a signature that is missing or invalid | the plugin is unsigned and signatures are not required |

It exits `1` when any check fails. The doctor runs the plugin's code (in the configured runtime), so run it on
plugins you are about to deploy, not on unknown files.

## Test, verify and ship (15.2.0-canary.1)

**Testing harness — `@winstonsayno/mcp-gateway/testing`.** A new package export (additive) for plugin tests, usable
from `node:test`, vitest, jest or mocha. `startPluginHarness(entry, { baseDir, trust })` loads one `plugins[]` entry
exactly like the gateway — signature check against `pluginTrust`, `worker` / `process` runtime, permissions, limits,
failure mode — and returns a harness:

| Method | What it does |
|---|---|
| `callTool(name, args?, over?)` | runs the `onToolCall` hooks → `{ action: 'continue', arguments }`, `{ action: 'deny', reason }`, `{ action: 'respond', result }` or `{ action: 'refused', error }` (a failing hook with `failure: closed`) |
| `respond(call, response)` | runs `onResponse` / `onError`, returns what the client would get |
| `status()` | the gateway's view: circuit, failures, restarts, alive (as `GET /api/v1/plugins`) |
| `update({ entry?, trust? })` | a hot reload: re-reads and re-verifies the module; on failure it throws and the running plugin keeps serving |
| `unload()` | removes the plugin (as removing its entry does); its runtime is closed |
| `crash()` | kills the isolated runtime as an OOM kill would; the next call starts a fresh one |
| `close()` | stops everything (the harness keeps the event loop alive until then) |

Also exported: `toolCall()` / `toolResponse()` (hook inputs), `createTestSigningKey()` / `signPluginFile()` (a
throwaway key, `<file>.sig` and the matching `pluginTrust`), `verifyArtifact` / `verifyReproducible`, and the
[compatibility matrix](plugin-compatibility.md) (`pluginApiSupport`, `isPluginApiSupported`).

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startPluginHarness } from '@winstonsayno/mcp-gateway/testing';

test('blocks rm', async () => {
  const h = await startPluginHarness({ module: './my-plugin.mjs', runtime: 'worker' }, { baseDir: import.meta.dirname });
  try {
    assert.equal((await h.callTool('rm')).action, 'deny');
  } finally {
    await h.close();
  }
});
```

**Reproducible signature check.** `mcp-gateway plugin verify <file> -p <pub> --key-id <id> --rebuilt <rebuild>`
(repeatable) verifies the signature and then checks that each independent rebuild from the same source has exactly the
signed sha256 — so the signature provably covers the source you built, not only the bytes the vendor published. Exit
`0` only when every rebuild matches; a differing rebuild is named with its digest. Without `--rebuilt` the command
behaves as before. Library: `verifyReproducible(bytes, sig, rebuilds, keys)`.

**A third-party plugin, end to end.** [`examples/plugins/tool-quota`](../../examples/plugins/tool-quota/README.md) is a
signed per-client tool quota running in a worker, with its operator config and a `node --test` file. Its README walks
through install, update, revoke and crash recovery — including that a reload which only drops the vendor key is
refused (the plugin keeps running until its entry is removed in the same reload) and that in-memory state starts over
after a crash.

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
