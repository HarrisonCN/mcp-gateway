# Offline desktop gateway (7.6)

Run mcp-gateway on your own machine, in front of the MCP servers your desktop AI client uses: one endpoint, one key,
policies / approvals / DLP / audit applied locally — and a clean failure mode on a plane or a train.

## Set up in one command

```bash
npx @winstonsayno/mcp-gateway desktop --from claude      # or cursor | windsurf | vscode, or --import <file>
npx @winstonsayno/mcp-gateway start -c mcp-gateway.yml
```

`desktop` imports the client's MCP servers (`mcpServers` in Claude Desktop / Cursor / Windsurf, `servers` in VS Code;
`command` → `stdio`, `url` → `streamable-http` or `sse`; disabled entries skipped) and writes a profile
(file mode `0600`):

```yaml
version: 9
host: 127.0.0.1              # loopback only
port: 4000
auth: { strategy: api-key, apiKeys: [mgw_…] }   # generated
controlPlane: { dashboard: true }
offline: { mode: auto }
servers: [ … imported … ]
```

It prints the snippet to put back into the client so it talks to the gateway only:

```json
{ "mcpServers": { "gateway": { "url": "http://127.0.0.1:4000/mcp", "headers": { "Authorization": "Bearer mgw_…" } } } }
```

## Offline mode

```yaml
offline:
  mode: auto                 # auto: probe the network | online | offline
  probeUrl: https://1.1.1.1/
  probeIntervalMs: 15000
  probeTimeoutMs: 3000
  allowRemote: ["nas-*"]     # remote servers still tried offline (LAN)
```

While offline, calls to **remote** upstreams (`streamable-http`, `sse`, `websocket`) are refused at once with
JSON-RPC error **-32018** instead of hanging until their timeout. Local `stdio` servers — and every local control
(policy, approvals, DLP, sanitisation, quotas, audit) — keep working.

| | |
|-|-|
| `GET /api/v1/admin/offline` | `offline`, `mode`, last probe, refused calls, local / remote servers |
| `POST /api/v1/admin/offline` | `{ mode: "auto" \| "online" \| "offline" }` — switch by hand |
| `POST /api/v1/admin/offline/import` | `{ config: <desktop client JSON> }` → `servers` (preview, nothing applied) |
