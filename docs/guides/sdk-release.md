# SDK release checklist (5.7)

All SDKs live in `clients/` and are built and tested by `.github/workflows/sdks.yml` (Python, Go, Swift) and
`clients-publish.yml` (JS, Kotlin). Publishing to external registries needs credentials the project does not store;
everything up to the upload is automated and reproducible.

| SDK | Version lives in | Build / test | Publish (manual, with credentials) |
|-----|------------------|--------------|-------------------------------------|
| Python `mcp-gateway-client` | `clients/python/pyproject.toml` + `__init__.__version__` | `PYTHONPATH=src python -m unittest discover -s tests`; `python -m build` | `twine upload dist/*` (PyPI token) |
| Go `github.com/HarrisonCN/mcp-gateway/clients/go` | `Version` in `client.go` | `go vet ./... && go test ./...` | push tag `clients/go/vX.Y.Z` (Go modules need the sub-directory prefix) |
| Swift `MCPGateway` | `Package.swift` | `swift build && swift test` | tag `swift-vX.Y.Z`; submit the repo to the Swift Package Index once |
| JS `@winstonsayno/mcp-gateway-client` | `clients/js/package.json` | `npm test` | `npm publish` (only when the client changes) |
| Kotlin | `clients/kotlin/build.gradle.kts` | `gradle build` | Maven Central secrets in `clients-publish.yml` |

## Feature parity (5.7)

| | REST calls | Streaming (`/tools/stream`) | MCP session (`/mcp`) |
|---|---|---|---|
| JS | ✓ | ✓ | ✓ |
| Python | ✓ | ✓ `stream_tool()` | ✓ `McpSession` |
| Go | ✓ | ✓ `StreamTool()` | ✓ `Client.MCP()` |
| Kotlin | ✓ | — | — |
| Swift | ✓ | — | — |

The Python SDK is also exercised against a live gateway in the main test suite (`test/sdk-python.test.ts`).
