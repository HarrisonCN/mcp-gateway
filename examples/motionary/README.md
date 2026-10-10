# Example: mcp-gateway → Motionary MCP server

The gateway proxies the [Motionary](https://www.npmjs.com/package/motionary) MCP server (`motionary-mcp`, stdio,
read-only component catalog) so AI clients get one authenticated, scoped, rate-limited and audited endpoint for it.

```
AI clients ──Streamable HTTP──▶ mcp-gateway (/mcp) ──stdio──▶ motionary-mcp
```

The two projects stay separate: Motionary is **not** a dependency of `@winstonsayno/mcp-gateway`. Install it only
where you run this example:

```bash
cd examples/motionary
npm i --no-save motionary@13.0.2          # pinned version this example is tested with
export MCP_GATEWAY_API_KEYS=$(openssl rand -hex 24)
npx mcp-gateway start -c mcp-gateway.yml
```

Then point any MCP client at `http://127.0.0.1:4000/mcp` with `Authorization: Bearer $MCP_GATEWAY_API_KEYS`. The tools
show up unprefixed (`list_components`, `search_components`, `get_component`, `get_example`, `scaffold_snippet`,
`suggest_motion`, `validate_snippet`, `check_compat` in Motionary 13.0.2) together with the `motionary://` resources.

## End-to-end test

`test/motionary-e2e.test.ts` runs only when `MGW_MOTIONARY_BIN` points at an installed `motionary-mcp.mjs`. CI job
**"MCP compat matrix"** installs `motionary@13.0.2` into a scratch directory (never into `package.json`) and runs it.

The test is deliberately tolerant so a newer Motionary (13.7 "AI tools 2.0") can extend it without changes here:

- it requires only a core set of tools (`list_components`, `search_components`, `get_component`) and accepts more;
- `MOTIONARY_EXPECT_TOOLS` (comma-separated) adds tools the test must also see;
- `MOTIONARY_VERSION` selects the npm version the CI job installs (default `13.0.2`).
