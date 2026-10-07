package io.github.harrisoncn.mcpgateway

import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.decodeFromJsonElement
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.put
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import java.io.Closeable
import java.util.concurrent.atomic.AtomicLong

/** A JSON-RPC error answered by the MCP endpoint. */
public class McpException(message: String, public val code: Int, public val data: JsonElement? = null) :
    RuntimeException(message)

/**
 * Minimal MCP Streamable HTTP session on the gateway's `/mcp` endpoint
 * (request/response; no notification stream). Create with [GatewayClient.mcp].
 * Blocking, thread-safe, [Closeable] (sends `DELETE`).
 */
public class McpSession internal constructor(
    private val client: GatewayClient,
    private val path: String,
) : Closeable {
    private val seq = AtomicLong(0)

    @Volatile
    public var sessionId: String? = null
        private set

    @Volatile
    public var info: McpInitializeResult? = null
        private set

    internal fun connect() {
        val params = buildJsonObject {
            put("protocolVersion", PROTOCOL_VERSION)
            put("capabilities", JsonObject(emptyMap()))
            put("clientInfo", buildJsonObject {
                put("name", "mcp-gateway-client-kotlin")
                put("version", "0.1.0")
            })
        }
        val (result, response) = rpc("initialize", params)
        sessionId = response
        info = client.json.decodeFromJsonElement<McpInitializeResult>(result)
        notify("notifications/initialized")
    }

    /** Every tool (follows `nextCursor`). */
    public fun listTools(): List<McpTool> {
        val tools = mutableListOf<McpTool>()
        var cursor: String? = null
        repeat(1000) {
            val params = cursor?.let { c -> buildJsonObject { put("cursor", c) } }
            val page = client.json.decodeFromJsonElement<McpToolsPage>(request("tools/list", params))
            tools += page.tools
            cursor = page.nextCursor
            if (cursor == null) return tools
        }
        return tools
    }

    /** `tools/call`; a tool-level failure comes back as a result with `isError = true`. */
    public fun callTool(name: String, arguments: JsonObject = JsonObject(emptyMap())): CallToolResult {
        val params = buildJsonObject {
            put("name", name)
            put("arguments", arguments)
        }
        return client.json.decodeFromJsonElement(request("tools/call", params))
    }

    public fun ping() {
        request("ping", null)
    }

    /** Send any JSON-RPC request and return its `result`. */
    public fun request(method: String, params: JsonObject?): JsonElement {
        check(sessionId != null) { "MCP session is closed" }
        return rpc(method, params).first
    }

    /** End the session (`DELETE`). */
    override fun close() {
        val sid = sessionId ?: return
        val req = client.requestBuilder(client.url(path)).header("Mcp-Session-Id", sid).delete().build()
        runCatching { client.execute(req).close() }
        sessionId = null
    }

    private fun notify(method: String) {
        val body = buildJsonObject {
            put("jsonrpc", "2.0")
            put("method", method)
        }
        post(body.toString()).close()
    }

    private fun rpc(method: String, params: JsonObject?): Pair<JsonElement, String?> {
        val id = seq.incrementAndGet()
        val body = buildJsonObject {
            put("jsonrpc", "2.0")
            put("id", id)
            put("method", method)
            if (params != null) put("params", params)
        }
        post(body.toString()).use { res ->
            val text = res.body?.string().orEmpty()
            val reply = parseReply(text, res.header("Content-Type").orEmpty(), id)
            reply.error?.let { throw McpException(it.message, it.code, it.data) }
            return (reply.result ?: JsonObject(emptyMap())) to res.header("Mcp-Session-Id")
        }
    }

    private fun post(body: String): Response {
        val b = client.requestBuilder(client.url(path))
            .header("Accept", "application/json, text/event-stream")
            .post(body.toRequestBody(GatewayClient.JSON_MEDIA))
        sessionId?.let { b.header("Mcp-Session-Id", it) }
        info?.let { b.header("MCP-Protocol-Version", it.protocolVersion) }
        val res = client.execute(b.build())
        if (!res.isSuccessful) {
            val text = res.body?.string().orEmpty()
            res.close()
            if (res.code == 404) sessionId = null
            throw client.errorFrom(res.code, text, res.header("Retry-After"))
        }
        return res
    }

    private fun parseReply(text: String, contentType: String, id: Long): JsonRpcResponse {
        val messages: List<JsonElement> = if (contentType.contains("text/event-stream")) {
            text.split(Regex("\r?\n\r?\n")).mapNotNull { block ->
                val data = block.lines().filter { it.startsWith("data:") }.joinToString("\n") { it.removePrefix("data:").trimStart() }
                if (data.isEmpty()) null else client.json.parseToJsonElement(data)
            }
        } else {
            val el = client.json.parseToJsonElement(text)
            if (el is kotlinx.serialization.json.JsonArray) el.toList() else listOf(el)
        }
        val match = messages.firstOrNull { m ->
            val o = m.jsonObject
            o["method"] == null && (o["id"] as? JsonPrimitive)?.content == id.toString()
        } ?: throw GatewayException("No JSON-RPC response in reply", 0, text)
        return client.json.decodeFromJsonElement(match)
    }

    public companion object {
        public const val PROTOCOL_VERSION: String = "2025-06-18"
    }
}
