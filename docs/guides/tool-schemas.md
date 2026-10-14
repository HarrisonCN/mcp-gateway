# Tool schema governance (15.3.0-canary.0)

AI clients increasingly rely on a tool's declared schemas: they build arguments from its `inputSchema` and parse its
`structuredContent` by its `outputSchema` (MCP 2025-06-18). Two things can go wrong between the gateway and an
upstream MCP server: the server returns structured output that does not match what it declared, or it silently changes
the schemas a client (or a reviewed policy) was built against. `policy.toolSchemas` covers both. It is opt-in; without
it nothing changes.

```yaml
policy:
  toolSchemas:
    validateOutput: enforce    # off (default) | audit | enforce
    tools: ["motionary/*"]     # server/tool globs; default: every tool that declares an outputSchema
    pins:
      motionary/render: "3f9a6c0d2b8e4f1a7c5d9e0b1a2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e"
    onDrift: block             # block (default) | audit
```

## Output validation

After the upstream answers (and after `policy.outputFilter`), a successful result of a tool that declares an
`outputSchema` is checked:

| Result | `audit` | `enforce` |
|---|---|---|
| `structuredContent` matches the `outputSchema` | passes | passes |
| `structuredContent` does not match | passes, counted, logged (`audit: … does not match its outputSchema`) | refused: `-32005` "Tool output blocked: structuredContent does not match the tool's outputSchema" with `data.decision: output-schema` and the first errors (JSON Pointer + message) — REST `502`, an error on `/mcp`; nothing of the invalid result is returned |
| no `structuredContent` | same as a mismatch (the spec requires it when an `outputSchema` is declared) | same as a mismatch |
| `isError: true`, or no `outputSchema` | not checked | not checked |

The validator is built in (no dependency) and covers the JSON Schema vocabulary tool schemas use: `type` (with
`integer` and type lists), `enum`, `const`, `properties`, `required`, `additionalProperties`, `patternProperties`,
`propertyNames`, `min/maxProperties`, `items`, `prefixItems`, `min/maxItems`, `uniqueItems`, `contains`, numeric
bounds and `multipleOf`, `min/maxLength` (code points), `pattern`, `allOf` / `anyOf` / `oneOf` / `not`,
`if` / `then` / `else`, boolean schemas and local `$ref` (`#/$defs/…`, `#/definitions/…`). `format` and other
annotations never fail a value. A remote `$ref` makes the result invalid rather than silently valid.

## Schema pins

A pin is the sha256 of the canonical JSON of the tool's `{ inputSchema, outputSchema }` (object keys sorted; names,
titles and descriptions are not part of it). Read the current digests from the gateway and pin the ones you reviewed:

```bash
curl -s -H "Authorization: Bearer $OPERATOR_KEY" http://localhost:3000/api/v1/admin/ops/tool-schemas \
  | jq -r '.tools[] | "\(.server)/\(.tool): \(.sha256)"'
```

When the server later lists a different schema for a pinned tool (or stops listing it), calls to that tool are refused
**before** they reach the server — `403` / `-32003`, `data.decision: schema-drift`, with the pinned and current digest —
until you review the change and update the pin. With `onDrift: audit` the call proceeds and is counted and logged.
Other tools of the server are not affected.

`GET /api/v1/admin/ops/tool-schemas` (operators and console viewers) lists every tool with `sha256`, whether it has an
`inputSchema` / `outputSchema`, `pinned`, `drift`, and counters since start (`violations`, `driftCalls`,
`driftRefusals`); `missing` names pins for tools no server lists.

## What this is not (yet)

- Pins are checked per call against the tool list the gateway holds; a server that changes its schema without sending
  `notifications/tools/list_changed` is noticed only when the gateway lists its tools again (reconnect, or a later
  `list_changed`).
- MCP 3.0 tool schema negotiation (Motionary 16 / motionary-mcp 3.0) is planned for 16.1; the interop check today
  (`test/motionary-schemas-15-3-1.test.ts`, CI job "MCP compat matrix") runs Motionary 14.8's MCP 2.x tools under
  `validateOutput: enforce` with every tool pinned.

## Related AI generation governance (15.3.0-canary.1)

- **Per-tenant generation budgets** — `costs.budgets[]` with `perTenant: true`, `tools: ["*/generate_*"]` and
  `measure: calls` (see [Costs and budgets](../configuration.md#costs-and-budgets-43)).
- **Approval ↔ lineage** — an approval request carries the held call's `correlationId` and, once the call finished, its
  `requestId`; the call's lineage carries `approval` ([Call lineage](operations-console.md#call-lineage-151)).
- **Tool output is data** — `test/generation-governance-15-3-1.test.ts` keeps a prompt-injection regression corpus:
  injection phrasings in text, `structuredContent` and resource text are caught by the built-in detectors, and nothing
  a tool returns (including `_meta` that claims approval, scopes or a tenant) changes what the caller may do. With
  `policy.outputFilter` on, `_meta["mcp-gateway/flags"]` is always this gateway's own verdict: an upstream's value is
  dropped when there is no finding and replaced when there is one.
