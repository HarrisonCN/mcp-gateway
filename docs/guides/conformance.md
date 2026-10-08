# MCP conformance suite (5.1)

`mcp-gateway conformance <url>` runs black-box checks against any Streamable HTTP MCP endpoint — the gateway's own
`/mcp`, or an upstream server you are about to put behind it:

```bash
npx @winstonsayno/mcp-gateway conformance http://127.0.0.1:8080/mcp -H "Authorization: Bearer $KEY"
npx @winstonsayno/mcp-gateway conformance https://mcp.example.com/mcp --only initialize,tools-list --json
```

Exit code 1 when any check fails. Checks:

| id | What it verifies |
|----|------------------|
| `initialize` | `initialize` at the newest revision returns `protocolVersion`, `serverInfo`, `capabilities` |
| `version-negotiation` | every revision the gateway speaks is accepted; an unknown one is answered with a supported revision |
| `parse-error` / `invalid-request` | malformed JSON → `-32700`; non-JSON-RPC body → `-32600` |
| `ping` / `method-not-found` | `ping` → `{}`; unknown method → `-32601` |
| `notification-202` | notifications are acknowledged with HTTP 202 |
| `tools-list` / `unknown-tool` | tools carry `name` + `inputSchema`; an unknown tool is an error |
| `bad-protocol-header` | an unsupported `MCP-Protocol-Version` header → 400 |
| `unknown-session` | an unknown `Mcp-Session-Id` → 404 |

## Self-test over the admin API

Operators can run the suite against the running gateway: `POST /api/v1/admin/conformance/run` (body
`{ "only": ["initialize"] }` optional; the caller's `Authorization` / `X-Api-Key` is forwarded). `GET
/api/v1/admin/conformance/checks` lists the checks.

## Feature modules

5.1 also introduces **feature modules**: self-contained admin capabilities mounted under `/api/v1/admin/<id>`.
`GET /api/v1/admin/features` lists the modules this gateway runs (id, version introduced, summary, path). Library
users can add their own with `registerFeature({ id, since, summary, mount(router, ctx) })` before starting a gateway.
