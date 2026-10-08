# mcp-gateway Go client

Typed, dependency-free Go client for [mcp-gateway](https://github.com/HarrisonCN/mcp-gateway). Go ≥ 1.21.

```bash
go get github.com/HarrisonCN/mcp-gateway/clients/go
```

```go
import mcpgateway "github.com/HarrisonCN/mcp-gateway/clients/go"

gw := mcpgateway.New("http://localhost:4000", "mgw_...")
tools, _ := gw.ListTools(ctx, "", "")
res, err := gw.CallTool(ctx, "read_file", map[string]any{"path": "/etc/hosts"}, "fs")
var ge *mcpgateway.Error
if errors.As(err, &ge) && ge.IsPolicyError() { /* blocked by policy */ }
```

Also: `Health`, `Ready`, `Servers`, `ToolSchemas` + `CallLLMTool` (OpenAI / Anthropic tool calling), `Approve`, `Deny`.
Tests: `go test ./...`.

## Streaming and MCP sessions (5.7)

```go
err := client.StreamTool(ctx, "long_job", map[string]any{"n": 3}, "worker", func(ev mcpgateway.Event) error {
	fmt.Println(ev.Name, string(ev.Data)) // progress, partial, result, error, end
	return nil
})

s, err := client.MCP(ctx, "/mcp") // initialize + notifications/initialized
defer s.Close(ctx)
tools, err := s.ListTools(ctx)          // follows nextCursor
res, err := s.CallTool(ctx, "echo", map[string]any{"hello": "world"})
```

JSON-RPC errors are `*mcpgateway.RPCError`; HTTP / network failures `*mcpgateway.Error`.
