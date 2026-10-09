# Edge WASM runtime 2.0 (9.2)

Since 3.3 the gateway runs WebAssembly **plugins** (policy hooks). 9.2 runs WebAssembly **tools**: small, pure
functions (lookups, formatting, validation, scoring) that answer on the gateway itself — ideal on edge nodes of the
[edge fleet](edge.md), next to the agent, with no upstream round trip.

```yaml
version: 10
features:
  edgeRuntime:
    idleSeconds: 300
    tools:
      - name: geo-lookup
        wasm: ./tools/geo.wasm
        sha256: 9f2c41d0… # optional pin (hex); a different file is refused
        export: run # default
        description: Country for an IP address
        inputSchema: {type: object, properties: {ip: {type: string}}}
        limits: {timeoutMs: 50, memoryMb: 8, maxConcurrent: 4}
        warm: 2
```

## ABI

The core ABI of [WASM plugins](plugins.md): the module exports `memory`, `alloc(len) -> ptr` and the tool export
`(ptr, len) -> i64`. The host writes the JSON arguments, the export returns `(ptr << 32) | len` of its JSON output
(`0` = empty result). An object with a `content` array is returned as the MCP tool result; any other JSON value is
wrapped as a text item. Only `env.log(ptr, len)` is imported — no WASI, no host access.

## Pool and quotas

Each tool keeps `warm` started instances (module compiled once, instance and worker ready), so calls on the hot path
have no cold start; bursts start extra instances up to `limits.maxConcurrent` and those above `warm` stop after
`idleSeconds` idle. Instances keep their linear memory between calls. A call that exceeds `timeoutMs` or `memoryMb`,
traps or returns bad JSON fails with JSON-RPC **-32023** (`ERR_EDGE_RUNTIME`) and its instance is replaced; a full
`maxConcurrent` quota answers `429`.

## API

- `GET /api/v1/features/edge-runtime/tools` · `POST /api/v1/features/edge-runtime/tools/:name/call` `{ "arguments": {…} }`
  — any authenticated client.
- `GET /api/v1/admin/edge-runtime` — pin status (`sha256`, `pinned`, `loaded`, `error`), pool, calls, errors, cold
  starts, p50 / max latency. `POST /api/v1/admin/edge-runtime/reload` re-reads and re-pins every module.
