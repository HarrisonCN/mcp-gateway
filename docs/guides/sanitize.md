# Prompt-injection defence and output sanitisation (7.3)

Tool results are untrusted input for the model: a web page, an issue comment or a file can carry instructions
("ignore previous instructions…"), hidden Unicode, or a markdown image that leaks data the moment a client renders it.
`sanitize` cleans every tool result before it leaves the gateway, and can refuse suspicious arguments and results.

```yaml
sanitize:
  servers: ["*"]                     # upstreams it applies to (globs)
  exempt: ["internal/*"]             # server/tool globs left untouched
  invisible: true                    # zero-width, bidi overrides, Unicode tag characters
  ansi: true                         # terminal escape sequences
  html: true                         # <script>/<style>/<iframe>/<object>/<embed> blocks, HTML comments
  images: strip                      # markdown images to hosts not in allowedImageHosts → "[image removed]"
  allowedImageHosts: ["*.githubusercontent.com"]
  maxChars: 200000                   # optional: truncate long text
  injection: { action: mark, threshold: 0.6 }   # off | flag | mark | block
  spotlight: true                    # wrap text in <<tool-output server/tool>> … <</tool-output>>
  inbound: off                       # block: refuse calls whose arguments score ≥ threshold
```

| `injection.action` | Effect when the cleaned result scores ≥ `threshold` (6.6 injection signals) |
|---|---|
| `off` | nothing |
| `flag` (default) | report in `_meta["mcp-gateway/sanitize"].injection` |
| `mark` | also prefix each text item with a warning to treat it as data |
| `block` | refuse the result: JSON-RPC error **-32017** (`data.direction: "results"`, `score`, `signals`) |

Whenever something was removed or flagged, the result carries `_meta["mcp-gateway/sanitize"]` with counts
(`invisible`, `ansi`, `html`, `images`, `truncated`). `inbound: block` refuses calls with injected **arguments**
(-32017, `data.direction: "arguments"`) — combine with [anomaly detection](anomaly.md) to quarantine the client.

## Admin API

| | |
|-|-|
| `GET /api/v1/admin/sanitize` | settings and counters (results, cleaned, removed items, flagged, blocked, inbound blocked) |
| `POST /api/v1/admin/sanitize/preview` | `{ value, server?, tool? }` → cleaned value, report, `blocked` — try a policy without a call |
