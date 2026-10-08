# Plugin API v5 (7.9; required in 8.0)

Plugin API v5 gives JavaScript and WebAssembly plugins **one contract**, defined as a WIT world:
[`wit/mcp-gateway-plugin.wit`](../../wit/mcp-gateway-plugin.wit) (`package mcp-gateway:plugin@5.0.0`, shipped in the
npm package).

## Outcomes

Hooks return JSON-shaped outcomes with an `action`:

| Hook | Outcome |
|------|---------|
| `onToolCall` / `on-tool-call` | nothing or `{ action: "continue" }` · `{ action: "rewrite", arguments }` · `{ action: "deny", reason }` · `{ action: "respond", result }` |
| `onResponse` / `on-response` | nothing or `{ action: "continue" }` · `{ action: "replace", result }` (successful results only) |

## JavaScript plugins

```js
export default {
  name: 'no-prod-deletes',
  apiVersion: 5,
  onToolCall(call, ctx) {
    if (call.name.startsWith('delete') && call.arguments.env === 'prod') return { action: 'deny', reason: 'no deletes in prod' };
    return { action: 'continue' };
  },
};
```

Everything from v4 stays (`ctx.state`, `ctx.secrets`, `ctx.tenant`, `onError`, `onConfigChange`); the v4 return
shapes (`{ deny }`, `{ arguments }`, `{ respond }`, a replacement result) are still accepted in 7.x.

## WebAssembly component plugins

```yaml
plugins:
  - component: ./policy.wasm     # plugin API v5 (canonical ABI); `wasm:` (3.3 core ABI) was removed in 8.0
    isolation: tenant            # tenant (default) | client | shared
    limits: { timeoutMs: 100, memoryMb: 16, maxInstances: 64 }
```

Build the plugin for the `plugin` world with any component toolchain (`cargo component`, `wit-bindgen` for Rust /
C / Go, `componentize-py`, `jco componentize`). The gateway runs the component's **core module** with the
canonical ABI — the module `wit-bindgen` produces before `wasm-tools component new`, or `wasm-tools component unbundle`
output:

| Export / import | |
|---|---|
| `memory`, `cabi_realloc` | canonical ABI allocation |
| `mcp-gateway:plugin/hooks@5.0.0#on-tool-call` / `#on-response` | `(ptr, len) -> retptr`; `option<string>` at `retptr` (discriminant byte; pointer and length as u32 at +4 / +8) |
| `cabi_post_<export>` (optional) | called after the gateway has read the result |
| import `mcp-gateway:plugin/host@5.0.0` `log` | the only host function |

Sandboxing is unchanged from 3.3: one worker per isolation key, no WASI, per-call timeout and memory cap, fail closed
(-32006). A full component binary (layer 1) is refused with a hint to load its core module.
