# MCPGateway (Swift)

Typed, dependency-free Swift client for [mcp-gateway](https://github.com/HarrisonCN/mcp-gateway) —
async/await, Swift ≥ 5.7, macOS 12 / iOS 15+ and Linux.

```swift
// Package.swift — SwiftPM can't depend on a sub-directory package directly; vendor clients/swift
// (or add it as a local package) until it is split into its own repository.
.package(path: "../mcp-gateway/clients/swift")
```

```swift
import MCPGateway

let gw = GatewayClient(baseURL: "http://localhost:4000", apiKey: "mgw_...")
let tools = try await gw.listTools()
do {
    let res = try await gw.callTool("read_file", arguments: ["path": "/etc/hosts"], server: "fs")
    print(res.result)
} catch let e as GatewayError where e.isPolicyError {
    print("blocked:", e.message)
}
```

Also: `health()`, `ready()`, `toolSchemas(format:)` + `callLLMTool`, `approve` / `deny`.
Pass `transport:` to use your own HTTP stack. Tests: `swift test`.
