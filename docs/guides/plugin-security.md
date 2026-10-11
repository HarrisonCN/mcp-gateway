# Plugin security runtime (14.3)

Since 14.3 a JS module plugin can run **outside the gateway process's JavaScript heap**, with declared
permissions, resource limits, a failure policy and a circuit breaker. A plugin that crashes, calls
`process.exit()`, loops forever or exhausts its memory only ends its own runtime — the gateway keeps serving, and
the next call starts a fresh runtime.

```yaml
plugins:
  - module: ./plugins/pii-guard.mjs
    runtime: worker            # inline (default) | worker | process   — alias: isolation: worker
    failure: closed            # closed (default) | open | { onToolCall: closed, onResponse: open }
    limits:
      timeoutMs: 500           # per hook call (default 5000); a timed-out call recycles the runtime
      memoryMb: 64             # heap cap (default 128)
      maxConcurrent: 16        # hook calls in flight (default 16); more fail as "busy"
      maxFailures: 5           # consecutive failures that open the circuit (default 5)
      cooldownMs: 30000        # open circuit → one trial call after this long (default 30000)
    permissions:
      args: read               # argument rewrites are dropped (default write)
      response: write          # onResponse replacements allowed (default write)
      secrets: [SLACK_TOKEN]   # names from `secrets:` the plugin may resolve (default: all granted)
      servers: ['prod-*']      # server id globs whose calls the hooks see (default: all)
      tools: ['write_*']       # tool / prompt / resource name globs (default: all)
      hooks: [onToolCall]      # hooks that may run (default: all the plugin defines)
      network: ['hooks.slack.com:443', '*.internal.example']   # false = no outbound connections; default unrestricted
      env: [NODE_ENV]          # environment variables the plugin sees (isolated default: none)
      fs: { read: [/etc/pii-rules], write: [] }                # see "File system" below
    secrets:
      SLACK_TOKEN: secret://env/SLACK_TOKEN
```

`runtime: worker` is **opt-in in 14.x**. Plugins without `runtime` keep running inline, exactly as before; the
gateway logs a one-time note. **15.0 makes `worker` the default for module plugins** — set `runtime: inline`
explicitly for plugins that must stay in process (HTTP hooks, see below).

## Runtimes

| | `inline` | `worker` | `process` |
|---|---|---|---|
| Where | gateway process, gateway heap | `worker_threads` Worker | child Node.js process |
| Crash / `process.exit()` / uncaught async error | takes the gateway down | ends the worker | ends the child |
| Endless loop | blocks the gateway | terminated after `limits.timeoutMs` | killed after `limits.timeoutMs` |
| Memory | shares the gateway heap | `resourceLimits.maxOldGenerationSizeMb` | `--max-old-space-size` |
| `permissions.env` | — | own `process.env` (declared names only) | own environment (declared names only) |
| `permissions.network` | — | enforced in the runtime (best effort, see below) | same |
| `permissions.fs` | — | best-effort guard on `node:fs` | **Node permission model** (`--permission`) |
| child processes, nested workers, addons, `process.binding` | allowed | refused | refused (permission model + guard) |
| `onRequest`, `routes` | yes | refused at load (HTTP objects cannot leave the process) | refused at load |
| Per-call overhead | none | one structured-clone round trip | one IPC round trip |

WASM component plugins (`component:`) keep their own sandbox (`isolation: tenant | client | shared`,
`limits.timeoutMs / memoryMb / maxInstances`); `runtime`, `failure` and `permissions` apply to module plugins.

### What crosses the boundary

Hook calls are structured-clone messages: the call (`serverId`, `name`, `kind`, `method`, `arguments`, `clientId`,
`tenant`, `via`, and the cloneable entries of `call.state`), the result for `onResponse`, the error for `onError`.
Outcomes come back the same way; an in-place change of `call.arguments` counts as a rewrite. `ctx.secrets.get()`
is a request to the gateway, which checks the grant and `permissions.secrets`. `ctx.logger` lines are forwarded to
the gateway log, prefixed with the plugin name. `ctx.state` lives inside the runtime — it is **lost when the runtime
is recycled** (crash, timeout, OOM); keep durable state elsewhere.

### Recycling and backoff

A crash, an exit, an out-of-memory kill or a timed-out call ends the runtime; every call still running on it fails
(failure policy applies). The next call starts a fresh runtime: immediately after the first crash, then with
exponential backoff (100 ms, 200 ms … up to 30 s) while crashes keep repeating; one successful call resets it.

## Failure policy and circuit breaker

A hook **fails** when it throws, crashes, times out, exceeds its memory, or returns something that cannot leave the
runtime. `failure: closed` (default, as before 14.3) refuses the call with `-32006`; `failure: open` logs the failure
and lets the call proceed without this plugin. Set it per hook: `failure: { onToolCall: closed, onResponse: open }`.
`onError` / `onConfigChange` are observe-only and never fail a call.

After `limits.maxFailures` consecutive failures the **circuit opens**: for `cooldownMs` the plugin is not called at
all — `closed` plugins refuse the call ("circuit open"), `open` plugins are skipped. Then the circuit is
**half-open**: one trial call; success closes it, failure reopens it. "Busy" refusals (`maxConcurrent`) apply the
failure policy but do not count as failures. Inline plugins get a breaker only when `limits.maxFailures` is set.

`GET /api/v1/plugins` (operators) shows per plugin: `runtime`, `circuit` (`closed` / `open` / `half-open`),
`failures`, `failure`, `lastError`, `failOpenPasses`, `refusals`, and for isolated plugins `alive`, `inFlight`,
`restarts`, `lastCrash`, plus the declared `permissions`.

## Permissions

- **`args: read` / `response: read`** — a rewrite / replacement is dropped and logged (the call proceeds with the
  original). Enforced for every module plugin, inline included.
- **`secrets`** — narrows the names granted in `secrets:`; reading another name throws in the plugin.
- **`servers` / `tools` / `hooks`** — the plugin only sees matching calls / runs listed hooks. Enforced for every
  module plugin.
- **`network`** — in an isolated runtime, every TCP connection (`net`, `tls`, `http(s)`, `fetch`) is checked
  against the list before it is made (`host`, `host:port`, `*.domain`; IP literals as written; `'*'` = all); UDP
  and Unix sockets are refused unless the list is `['*']`. `false` refuses every connection. The check runs on the
  host name the plugin asks for, before DNS. **This is a best-effort guard for JavaScript code, not an OS sandbox**:
  run untrusted code as a WASM component, or add an OS-level egress policy (network namespace, Kubernetes
  NetworkPolicy) around the gateway.
- **`env`** — the runtime starts with only these variables (default: none — isolated plugins do not see the
  gateway's environment, which usually holds credentials).
- **`fs`** — `runtime: process` runs the child under the **Node.js permission model**: it may read the plugin's own
  directory and `fs.read` paths, write only `fs.write` paths; everything else fails with `ERR_ACCESS_DENIED`.
  `runtime: worker` applies a best-effort guard on `node:fs` when `fs` is declared (unrestricted when it is not).
- `permissions.network / env / fs` need `runtime: worker` or `process` (config validation refuses them inline).

## Signed plugins (verify-then-load)

With `pluginTrust` (5.4), the gateway reads the plugin file **once**, verifies the Ed25519 (optionally hybrid
ML-DSA) signature over those bytes, and loads **exactly those bytes** — as a `data:` module, in every runtime, and for
WASM components the verified buffer. If the file on disk no longer matches the verified bytes when the plugin is
loaded, the plugin is refused ("changed after signature verification"). Because the signature covers one file, a
signed module plugin must be a **self-contained bundle** (it may import `node:` built-ins only; bundle dependencies
with esbuild / rollup before signing). Before 14.3 the gateway re-read the file after verifying it and followed its
relative imports unverified — MGW-2026-016.

```bash
npx esbuild src/plugin.ts --bundle --platform=node --format=esm --outfile=dist/plugin.mjs
mcp-gateway plugin sign dist/plugin.mjs --key acme.pem --key-id acme-2026
```

## Choosing a runtime

- Third-party or fast-moving plugins: `runtime: worker` with `failure` set deliberately and the narrowest
  `permissions`. Use `process` when you need file-system confinement or a separate OS process (separate PID, separate
  heap, killable with a signal).
- HTTP plugins (`onRequest`, `routes`): `inline` only.
- Untrusted code: WASM components — the only runtime without ambient Node.js APIs.

See also: [Plugins](plugins.md), [Plugin SDK](plugin-sdk.md), [configuration](../configuration.md#plugin-security-runtime-143).
