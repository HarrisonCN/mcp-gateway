# MCP client compatibility matrix

Since 13.6.0 the gateway's MCP interoperability is tested on every pull request and every push to `main` by the CI
job **MCP compat matrix** (`test/compat-matrix-13-6-0.test.ts`, `test/motionary-e2e.test.ts`). The job uploads
`compat-matrix.json` with one pass / fail entry per client, revision and check.

## What the gateway speaks

| Side | Transports | MCP revisions |
| --- | --- | --- |
| Downstream (clients → gateway `/mcp`) | Streamable HTTP (`POST` / `GET` stream / `DELETE`) | `2025-11-25`, `2025-06-18`, `2025-03-26`, `2024-11-05` (restrict with `mcp.protocolVersions`) |
| Upstream (gateway → your servers) | stdio, Streamable HTTP, legacy HTTP+SSE, WebSocket | whatever the server answers in `initialize` |

Up to 16.0 the `2026-07-28` revision (stateless per-request envelope, `server/discover`) is not served: clients that
probe with `server/discover` (the official Python SDK `mcp` 2.x in its default `mode="auto"`) get JSON-RPC `-32601`
and fall back to the `initialize` handshake on `2025-11-25`. **From 16.1.0-canary.0** (npm `canary`) `/mcp` is
dual-era and serves `2026-07-28` statelessly as well — see [MCP 2026-07-28](#mcp-2026-07-28-1610-canary0).

## MCP 2026-07-28 (16.1.0-canary.0)

Spec: [2026-07-28](https://modelcontextprotocol.io/specification/2026-07-28) ([key changes](https://modelcontextprotocol.io/specification/2026-07-28/changelog)).
`/mcp` serves both eras on the same path: an `initialize` request opens a session on a handshake revision exactly as
before; a request without `Mcp-Session-Id` that carries `params._meta["io.modelcontextprotocol/protocolVersion"]` is
served statelessly.

| | 16.1.0-canary.0 |
| --- | --- |
| `server/discover` | `supportedVersions` = `2026-07-28` + the handshake revisions, `capabilities` (tools, resources, prompts, completions; `listChanged` / `subscribe` from 16.1.0-canary.1), `_meta` serverInfo, `instructions`, `ttlMs` / `cacheScope`; also answers a bare probe without `_meta` |
| Stateless methods | `tools/list`, `tools/call`, `resources/list`, `resources/templates/list`, `resources/read`, `prompts/list`, `prompts/get`, `completion/complete` — same authentication, scopes, policy, rate limits, audit and lineage as a session |
| Results | `resultType: "complete"`, `_meta["io.modelcontextprotocol/serverInfo"]`; list / read results carry `ttlMs` (30 s) and `cacheScope: "private"` (lists depend on the caller's scope) |
| Header validation | `MCP-Protocol-Version` (= `_meta` version), `Mcp-Method` (= `method`), `Mcp-Name` (= `params.name` / `params.uri`, Base64 sentinel `=?base64?…?=` decoded) required → otherwise `400` + `-32020` HeaderMismatch |
| Versions | a version the endpoint does not serve statelessly → `400` + `-32022` with `data.supported` / `data.requested` |
| Removed in 2026-07-28 | `ping`, `logging/setLevel`, `resources/subscribe` / `unsubscribe`, `initialize` with modern `_meta`, any unknown method → `404` + `-32601`; an upstream's own `-32601` stays HTTP 200 |
| Errors | resource not found is `-32602` (was `-32002`) |
| `subscriptions/listen` (16.1.0-canary.1) | a long-lived SSE response: `notifications/subscriptions/acknowledged` first (the agreed filter — URIs outside the caller's scope or on servers without resource subscriptions are left out), then `notifications/{tools,prompts,resources}/list_changed` and `notifications/resources/updated` for what the caller opted in to, each with `_meta["io.modelcontextprotocol/subscriptionId"]` = the listen request id; closing the stream ends it; a gateway shutdown (or a removed key) ends it with a `resultType: "complete"` response; at most `mcp.maxSessions` open listeners; `server/discover` advertises `listChanged` / `subscribe` |
| Not yet | Multi Round-Trip Requests (`input_required` — upstream sampling / elicitation / roots are unavailable to stateless callers), the tasks extension, per-request `logLevel`, `x-mcp-header` parameters, speaking 2026-07-28 to upstream servers |

`mcp.protocolVersions` controls it: without the key everything is served; a list without `2026-07-28` turns the
stateless core off (modern requests get `-32022`, a bare `server/discover` keeps the old `-32601` so dual-era clients
use `initialize`); a list naming only `2026-07-28` makes `/mcp` modern-only (`initialize` → `400` + `-32022`).

Tested: `test/mcp-modern-16-1-0.test.ts`, `test/mcp-subscriptions-16-1-1.test.ts` (raw HTTP) and the CI compat job's
Python SDK (`mcp` 2.3.0), whose `mode="auto"` now stays on `2026-07-28`, calls a tool statelessly and opens
`subscriptions/listen` (16.1.0-canary.1).

## Tested clients

| Client | Revisions | Checks |
| --- | --- | --- |
| Official TypeScript SDK (`@modelcontextprotocol/sdk` 1.32.x) | each of the four revisions above (offered at `initialize`) | initialize / negotiation, ping, tools on stdio + Streamable HTTP + SSE upstreams, `notifications/progress`, cancellation (`notifications/cancelled` reaches the upstream), client timeout (session stays usable), `notifications/tools/list_changed` on the GET stream, session re-attach by `Mcp-Session-Id`, `DELETE` ends the session |
| Official Python SDK (`mcp` 2.3.0, pinned in CI) | negotiated by the SDK (`2025-11-25`); `mode="auto"` probe fallback | initialize, tools on all three upstream transports, progress callback, `server/discover` fallback |
| Raw HTTP | — | unknown newer revision → newest supported; `MCP-Protocol-Version` header must match the negotiated revision; header may be omitted (2025-03-26 clients) |

## Version negotiation rules

- The client's requested revision is used when the gateway speaks it (and `mcp.protocolVersions` allows it);
  otherwise the gateway answers with its newest allowed revision and the client decides whether to continue.
- An `initialize` without `protocolVersion` is accepted and gets the newest revision (lenient, unchanged since 4.1).
- After `initialize`, a request whose `MCP-Protocol-Version` header names a different revision than the session
  negotiated is refused with HTTP 400 (13.6.0; results are shaped for the negotiated revision). Requests without the
  header are accepted.

## Notifications, cancellation, resume

- Upstream Streamable HTTP servers: the gateway opens their standalone `GET` stream after `notifications/initialized`
  (13.6.0), so `tools/list_changed`, `resources/updated` and log messages they send without a related request reach
  downstream clients. A server that answers `405` simply has no such stream; a dropped stream is re-opened with
  `Last-Event-ID` (up to 5 attempts, reset after each event).
- Downstream `GET` streams keep a per-session event buffer (`mcp.eventBufferSize`, default 256) for `Last-Event-ID`
  replay.
- `notifications/cancelled` from a client aborts the upstream call; a client-side timeout leaves the session usable.

## Running it locally

```bash
python3 -m venv /tmp/mcpvenv && /tmp/mcpvenv/bin/pip install "mcp==2.3.0"
MGW_PY_MCP=/tmp/mcpvenv/bin/python MGW_COMPAT_REPORT=compat-matrix.json npx vitest run test/compat-matrix-13-6-0.test.ts
```

Without `MGW_PY_MCP` the Python rows are skipped locally (the CI job fails if they are missing).

## Motionary E2E (joint milestone)

`examples/motionary` runs the gateway in front of the Motionary MCP server (`motionary-mcp`, stdio). Motionary is
installed from npm only inside that example / the CI job (`motionary@13.0.2`, pinned), never as a gateway dependency.
See [examples/motionary/README.md](../../examples/motionary/README.md).
