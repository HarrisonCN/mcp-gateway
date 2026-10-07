package io.github.harrisoncn.mcpgateway

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject

/** A tool exposed by the gateway (`GET /api/v1/tools`). */
@Serializable
public data class Tool(
    val name: String,
    val title: String? = null,
    val description: String? = null,
    val inputSchema: JsonObject? = null,
    val outputSchema: JsonObject? = null,
    val annotations: JsonObject? = null,
    val serverId: String,
    val serverName: String,
)

@Serializable
public data class ReconnectState(
    val state: String,
    val attempt: Int = 0,
    val reconnects: Int = 0,
    val nextAttemptAt: String? = null,
    val lastError: String? = null,
)

@Serializable
public data class ServerHealth(
    val serverId: String,
    /** `online` | `degraded` | `reconnecting` | `offline` | `unknown` */
    val status: String,
    val lastChecked: String? = null,
    val latencyMs: Double? = null,
    val errorMessage: String? = null,
    val toolCount: Int? = null,
    val connectedSince: String? = null,
    val reconnect: ReconnectState? = null,
)

@Serializable
public data class SessionInfo(
    val transport: String,
    val protocolVersion: String? = null,
    val connectedAt: String? = null,
)

/** An entry of `GET /api/v1/servers`. */
@Serializable
public data class ServerSummary(
    val id: String,
    val name: String,
    val description: String? = null,
    val transport: String,
    val tags: List<String> = emptyList(),
    val enabled: Boolean = true,
    val health: ServerHealth? = null,
    val session: SessionInfo? = null,
    val toolCount: Int = 0,
)

/** `GET /api/v1/servers/:id`. */
@Serializable
public data class ServerDetails(
    val id: String,
    val name: String,
    val description: String? = null,
    val transport: String,
    val tags: List<String> = emptyList(),
    val health: ServerHealth? = null,
    val session: SessionInfo? = null,
    val tools: List<Tool> = emptyList(),
)

@Serializable
public data class HealthSummary(
    val total: Int = 0,
    val online: Int = 0,
    val offline: Int = 0,
    val degraded: Int = 0,
    val reconnecting: Int = 0,
    val unknown: Int = 0,
    val totalTools: Int = 0,
)

/** `GET /api/v1/health`. */
@Serializable
public data class HealthResponse(
    /** `ok` | `degraded` */
    val status: String,
    val version: String,
    val uptime: Double,
    val servers: HealthSummary,
)

@Serializable
public data class ReadinessServers(val ready: Int, val total: Int, val required: Int)

/** `GET /api/v1/health/ready`. */
@Serializable
public data class ReadinessResponse(
    /** `ready` | `not_ready` | `shutting_down` */
    val status: String,
    val servers: ReadinessServers,
) {
    val ready: Boolean get() = status == "ready"
}

/** MCP `CallToolResult`, as returned by the upstream server. */
@Serializable
public data class CallToolResult(
    val content: List<JsonObject> = emptyList(),
    val structuredContent: JsonElement? = null,
    val isError: Boolean = false,
) {
    /** Concatenated `text` of all text content blocks. */
    val text: String
        get() = content.mapNotNull { block ->
            if ((block["type"] as? kotlinx.serialization.json.JsonPrimitive)?.content == "text") {
                (block["text"] as? kotlinx.serialization.json.JsonPrimitive)?.content
            } else {
                null
            }
        }.joinToString("\n")
}

/** `POST /api/v1/tools/call`. */
@Serializable
public data class CallToolResponse(
    val result: CallToolResult,
    val server: String,
    val tool: String,
    val durationMs: Long,
)

@Serializable
public data class RequestRecord(
    val id: String,
    val timestamp: String,
    val serverId: String,
    val toolName: String,
    val durationMs: Long,
    val success: Boolean,
    val errorMessage: String? = null,
    val clientId: String? = null,
    val via: String? = null,
)

@Serializable
public data class ToolTarget(val server: String, val tool: String)

/** `GET /api/v1/tools?format=openai|openai-responses|anthropic`. */
@Serializable
public data class ToolSchemas(
    val format: String,
    /** Pass as the provider's `tools` parameter. */
    val tools: List<JsonObject>,
    /** LLM tool name → gateway server / tool. */
    val mapping: Map<String, ToolTarget>,
    val total: Int,
)

/** LLM function-calling formats supported by [GatewayClient.toolSchemas]. */
public enum class ToolSchemaFormat(public val wire: String) {
    OPENAI("openai"),
    OPENAI_RESPONSES("openai-responses"),
    ANTHROPIC("anthropic"),
}

@Serializable
internal data class ServersEnvelope(val servers: List<ServerSummary>)

@Serializable
internal data class ToolsEnvelope(val tools: List<Tool>)

@Serializable
internal data class RequestsEnvelope(val requests: List<RequestRecord>)

@Serializable
internal data class CallToolBody(
    val tool: String,
    val arguments: JsonObject,
    val server: String? = null,
)

@Serializable
public data class ReconnectResponse(val server: String, val connected: Boolean)

/** MCP tool as listed by `/mcp` `tools/list`. */
@Serializable
public data class McpTool(
    val name: String,
    val title: String? = null,
    val description: String? = null,
    val inputSchema: JsonObject = JsonObject(emptyMap()),
    val annotations: JsonObject? = null,
)

@Serializable
internal data class McpToolsPage(val tools: List<McpTool> = emptyList(), val nextCursor: String? = null)

@Serializable
public data class McpServerInfo(val name: String, val version: String, val title: String? = null)

@Serializable
public data class McpInitializeResult(
    val protocolVersion: String,
    val capabilities: JsonObject = JsonObject(emptyMap()),
    val serverInfo: McpServerInfo,
    val instructions: String? = null,
)

@Serializable
internal data class JsonRpcError(val code: Int, val message: String, val data: JsonElement? = null)

@Serializable
internal data class JsonRpcResponse(
    val jsonrpc: String = "2.0",
    val id: JsonElement? = null,
    val result: JsonElement? = null,
    val error: JsonRpcError? = null,
    @SerialName("method") val method: String? = null,
)

/** A tool call held by a policy rule with `effect: approve` (`GET /api/v1/approvals`, gateway ≥ 1.6). */
@Serializable
public data class ApprovalRequest(
    val id: String,
    val status: String,
    val clientId: String? = null,
    val serverId: String? = null,
    val tool: String? = null,
    val arguments: JsonElement? = null,
    val rule: String? = null,
    val message: String? = null,
    val via: String? = null,
    val createdAt: String? = null,
    val expiresAt: String? = null,
    val decidedAt: String? = null,
    val decidedBy: String? = null,
    val reason: String? = null,
)

/** `GET /api/v1/approvals`. */
@Serializable
public data class Approvals(val pending: List<ApprovalRequest> = emptyList(), val recent: List<ApprovalRequest> = emptyList())

@Serializable
internal data class ReasonBody(val reason: String? = null)
