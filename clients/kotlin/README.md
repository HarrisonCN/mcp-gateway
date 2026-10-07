# mcp-gateway Kotlin client

JVM / Android client for [mcp-gateway](https://github.com/HarrisonCN/mcp-gateway), built on
[OkHttp](https://square.github.io/okhttp/) and [kotlinx.serialization](https://github.com/Kotlin/kotlinx.serialization).
Java 11 bytecode, Kotlin 1.9, no reflection — works on Android (API 21+) and any JVM 11+.

> Maven coordinates: `io.github.harrisoncn:mcp-gateway-client:1.7.0` (published to Maven Central by
> `.github/workflows/clients-publish.yml` once the repository's Central Portal and signing secrets are configured).
> Until it is on Central, use it as an included build / module, or copy `src/main/kotlin`.

```kotlin
dependencies { implementation("io.github.harrisoncn:mcp-gateway-client:1.7.0") }
```

Approvals (gateway ≥ 1.6): `client.approvals()`, `client.approve(id, reason)`, `client.deny(id, reason)`;
policy refusals throw `GatewayException` with `code` (`-32003` / `-32004` / `-32005`) and `isPolicyError`.

```kotlin
// settings.gradle.kts of your app
includeBuild("path/to/mcp-gateway/clients/kotlin")
// app/build.gradle.kts
dependencies { implementation("io.github.harrisoncn:mcp-gateway-client:0.1.0") }
```

## Usage

```kotlin
val gw = GatewayClient("http://10.0.2.2:4000", apiKey = BuildConfig.GATEWAY_KEY)

// Calls are blocking: use a background thread / Dispatchers.IO on Android.
val tools = withContext(Dispatchers.IO) { gw.listTools() }
val r = withContext(Dispatchers.IO) {
    gw.callTool("echo", buildJsonObject { put("msg", "hi") }, server = "local")
}
println(r.result.text)
```

### With an LLM (e.g. an in-app assistant)

```kotlin
val schemas = gw.toolSchemas(ToolSchemaFormat.OPENAI)      // or OPENAI_RESPONSES / ANTHROPIC
// send schemas.tools as the provider's "tools" parameter; for each tool call the model returns:
val out = gw.callLlmTool(schemas, call.function.name, call.function.arguments)
```

### MCP over `/mcp`

```kotlin
gw.mcp().use { session ->                // initialize … DELETE on close
    val tools = session.listTools()      // follows pagination
    val result = session.callTool("github__create_issue", buildJsonObject { put("title", "Hi") })
}
```

## API

| Method | Endpoint |
|---|---|
| `health()` / `ready(min)` | `GET /api/v1/health`, `GET /api/v1/health/ready` |
| `servers()` / `server(id)` / `reconnect(id)` | `/api/v1/servers…` |
| `listTools(server, tag)` | `GET /api/v1/tools` |
| `toolSchemas(format, server, tag)` | `GET /api/v1/tools?format=…` |
| `callTool(tool, arguments, server)` | `POST /api/v1/tools/call` |
| `callLlmTool(schemas, name, argumentsJson)` | mapping lookup + `callTool` |
| `requests(limit)` | `GET /api/v1/requests` |
| `mcp(path = "mcp")` | opens an `McpSession` (`listTools`, `callTool`, `ping`, `request`, `close`) |

Constructor: `GatewayClient(baseUrl, apiKey = null, tokenProvider = null, httpClient = null, headers = emptyMap())`.
Errors: `GatewayException(status, body, retryAfterSeconds)` (status 0 = network error); MCP JSON-RPC errors throw `McpException(code)`.

## Development

```bash
cd clients/kotlin
./gradlew test      # MockWebServer tests
./gradlew build     # jar + sources jar
```
