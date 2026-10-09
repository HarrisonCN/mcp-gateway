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
  apiVersion: 5,
  onRequest(req, res, next, hook) {                 // Express middleware; hook = { plugin, logger, … }
    if (!req.headers[ctx.options.header]) return res.status(400).json({ error: 'missing tenant' });
    next();
  },
  onToolCall(call, hook) {                          // before policy rules
    if (call.name === 'delete_repo') return { deny: 'not through the gateway' };
    if (call.name === 'search') return { arguments: { ...call.arguments, limit: 20 } };
    // return { respond: { content: [...] } } to answer without contacting the server
  },
  onResponse(call, result, hook) {                  // after the output filter
    ctx.logger.info(`${call.serverId}/${call.name} → ${result.success}`);
    return result;                                  // or a replacement ProxyResponse
  },
  onError(call, error, hook) {                      // API v2: observe failed calls (never changes them)
    hook.logger.warn(`${call.name} failed: ${error.message}`);
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
| `ctx.gatewayVersion` | e.g. `3.0.0` |
| `ctx.apiVersion` | plugin API implemented by the gateway (`5` since 7.9) |

## Plugin API v4 (4.9)

- (Plugin API v4 was removed in 8.0 — declare `apiVersion: 5`; see [plugin API v5](plugins-v5.md).) v4 added everything in v3, plus `ctx.state`: a per-plugin key-value store that lives as long as the
  plugin instance (cleared when a reload unloads it), so counters, small caches and rate windows need no module globals.

```js
export default {
  name: 'per-client-budget',
  apiVersion: 5,
  onToolCall(call, ctx) {
    const key = `calls:${call.clientId}`;
    const n = (ctx.state.get(key) ?? 0) + 1;
    ctx.state.set(key, n, 60_000);          // ttlMs: forget after a minute
    if (n > 100) return { deny: 'more than 100 calls a minute' };
  },
};
```

`ctx.state`: `get(key)`, `set(key, value, ttlMs?)`, `has`, `delete`, `size()`, `clear()`; at most 10 000 keys (oldest
evicted). 5.0 refuses v2 and deprecates v3 (it still loads, with a warning, until 6.0).

## Plugin API v3 (4.0)

- Declare `apiVersion: 3`. The hook context gains:
  - `ctx.secrets.get(name)` / `ctx.secrets.names()` — secrets granted to the plugin in config. Only the names listed
    under the plugin's `secrets:` are readable; values come from the gateway's secret providers (Vault, KMS, env, file)
    and never appear in the config:
    ```yaml
    plugins:
      - module: ./plugins/notify.mjs
        secrets:
          SLACK_TOKEN: secret://vault/mcp/slack#token
    ```
  - `ctx.tenant` — `{ id, name?, role? }` of the caller's tenant on call hooks (`onToolCall`, `onResponse`, `onError`)
    when `tenants:` are configured.
- New `onConfigChange(change, ctx)` — runs after every applied hot reload with `{ applied: string[], servers: string[], at }`
  (errors are logged, never fail the reload).
- Plugin API v1 (no `apiVersion`) is **refused** since 4.0 and plugin API v2 since 5.0 — both only need
  `apiVersion: 4` (later versions add fields, change nothing). v3 is deprecated in 5.0 and removed in 6.0.
- Embedders granting secrets to plugins passed in code: `grantSecrets(plugin, { NAME: 'secret://…' })`.

## Plugin API v2 (3.0, deprecated in 4.0)

- Declare `apiVersion: 2`. Every hook receives a hook context as its **last** argument:
  `{ plugin, logger, gatewayVersion, apiVersion }`.
- New `onError(call, error, hook)`: runs for every failed call after `onResponse`; observe-only — exceptions are logged
  and never fail the call.
- Plugins without `apiVersion` (v1) were deprecated in 3.x and are refused since 4.0.
- A plugin declaring a higher `apiVersion` than the gateway implements is refused at load.

TypeScript types: `import type { GatewayPlugin, PluginFactory } from '@winstonsayno/mcp-gateway'`.

## WASM plugins (3.3)

Write the plugin in Rust, Go (TinyGo), AssemblyScript, C or Zig, compile it to a `.wasm` module, and list it with
`component:` instead of `module:` (8.0: plugin API v5 components only — see [plugin API v5](plugins-v5.md); the
3.3 core ABI below remains available to embedders in code). The gateway runs it sandboxed and isolated per tenant.

```yaml
plugins:
  - component: ./pii-guard.wasm
    isolation: tenant          # tenant (default) | client | shared
    limits: { timeoutMs: 100, memoryMb: 16, maxInstances: 64 }
```

### ABI

All payloads are UTF-8 JSON in the module's exported `memory`.

| Export | Signature | |
|---|---|---|
| `memory` | memory | required |
| `alloc` | `(len: i32) -> i32` | required — buffer the host writes the input into |
| `on_tool_call` | `(ptr: i32, len: i32) -> i64` | optional |
| `on_response` | `(ptr: i32, len: i32) -> i64` | optional (at least one hook) |

Return `0` for "no change", otherwise `(ptr << 32) | len` of the output JSON.

- `on_tool_call` input: `{ server, tool, kind, method, arguments, clientId, tenant, via }`; output `{}`,
  `{ "arguments": {…} }`, `{ "deny": "reason" }` or `{ "respond": <result> }`.
- `on_response` input adds `success`, `result`, `error`; output `{}` or `{ "result": <replacement> }` (only applied to
  successful calls).
- The only import is `env.log(ptr: i32, len: i32)` (gateway log, `info`). Modules importing anything else (WASI
  included) are refused at load.

### Isolation and limits

- `isolation: tenant` gives every tenant (first workspace of the client) its own worker and module instance — no
  shared linear memory or globals. `client` isolates per API key / JWT subject; `shared` runs one instance.
- A hook that traps, runs past `timeoutMs`, grows memory past `memoryMb`, or returns invalid JSON fails the call
  closed (`-32006`); the sandbox is killed and recreated on the next call.
- `GET /api/v1/plugins` (operators) lists every plugin with its hooks and, for WASM plugins, the live sandboxes.

Minimal Rust sketch:

```rust
#[no_mangle] pub extern "C" fn alloc(len: i32) -> i32 { let mut v = Vec::<u8>::with_capacity(len as usize); let p = v.as_mut_ptr(); std::mem::forget(v); p as i32 }
#[no_mangle] pub extern "C" fn on_tool_call(ptr: i32, len: i32) -> i64 {
    let input = unsafe { std::slice::from_raw_parts(ptr as *const u8, len as usize) };
    let out: &'static [u8] = if input.windows(8).any(|w| w == b"password") { br#"{"deny":"no secrets"}"# } else { b"{}" };
    ((out.as_ptr() as i64) << 32) | out.len() as i64
}
```


## Signed plugins and the marketplace (5.4)

### Signing

```bash
mcp-gateway plugin keygen -o acme            # acme.key (secret) + acme.pub
mcp-gateway plugin sign ./plugins/guard.mjs -k acme.key --key-id acme-2026   # writes guard.mjs.sig
mcp-gateway plugin verify ./plugins/guard.mjs -p acme.pub --key-id acme-2026
```

A `.sig` file is JSON `{ keyId, sha256, signature }`: an Ed25519 signature over
`mcp-gateway-plugin:v1:<sha256 of the file>`. It sits next to the plugin (or set `plugins[].signature`).

### Trust policy

```yaml
features:
  pluginTrust:
    requireSigned: true # refuse unsigned plugins and package-name modules
    keys:
      - id: acme-2026
        publicKey: |
          -----BEGIN PUBLIC KEY-----
          MCowBQYDK2VwAyEA…
          -----END PUBLIC KEY-----
```

With `keys` set, every plugin that ships a `.sig` must verify (a mismatched hash, unknown key or bad signature
stops the gateway from loading it). With `requireSigned`, unsigned plugins are refused too. Applies to JS and WASM
plugins; hot reloads.

### Marketplace

```yaml
features:
  marketplace:
    dir: ./plugins # relative to the config file
    indexes: [https://plugins.example.com/index.json]
```

An index is `{ "plugins": [{ name, version, description?, url, sha256, signature, keyId, kind? }] }`.
`GET /api/v1/admin/marketplace` lists entries (`trusted`: signed by one of your keys).
`POST /api/v1/admin/marketplace/install` `{ "name": "guard", "version"?: "1.2.0" }` downloads the artifact, checks
size, sha256 and signature, writes `plugins/guard-1.2.0.mjs` + `.sig`, and returns the `plugins:` entry to add.
Installing never changes the running config by itself, and refuses to run without `pluginTrust.keys`.
