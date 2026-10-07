package io.github.harrisoncn.mcpgateway

import kotlinx.serialization.KSerializer
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.serializer
import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import java.io.IOException
import java.util.concurrent.TimeUnit

/**
 * Error for non-2xx gateway responses. [status] is 0 for network failures.
 * [retryAfterSeconds] is set for 429 / 503 responses carrying `Retry-After`.
 */
public class GatewayException(
    message: String,
    public val status: Int,
    public val body: String? = null,
    public val retryAfterSeconds: Long? = null,
    cause: Throwable? = null,
) : IOException(message, cause)

/**
 * Typed client for the mcp-gateway REST API (`/api/v1`).
 *
 * All calls are blocking — on Android call them from a background thread
 * (e.g. `withContext(Dispatchers.IO) { client.listTools() }`). The client is
 * thread-safe; share one instance.
 *
 * @param baseUrl gateway URL without `/api/v1`, e.g. `http://10.0.2.2:4000`
 * @param apiKey API key or JWT, sent as `Authorization: Bearer …`
 * @param tokenProvider called per request when [apiKey] is null (e.g. a refreshing JWT)
 * @param httpClient bring your own OkHttp client (interceptors, TLS, timeouts)
 */
public class GatewayClient(
    baseUrl: String,
    private val apiKey: String? = null,
    private val tokenProvider: (() -> String?)? = null,
    httpClient: OkHttpClient? = null,
    private val headers: Map<String, String> = emptyMap(),
) {
    public val baseUrl: HttpUrl = baseUrl.trimEnd('/').toHttpUrl()

    internal val http: OkHttpClient = httpClient ?: OkHttpClient.Builder()
        .connectTimeout(10, TimeUnit.SECONDS)
        .readTimeout(120, TimeUnit.SECONDS)
        .callTimeout(0, TimeUnit.SECONDS)
        .build()

    internal val json: Json = Json {
        ignoreUnknownKeys = true
        explicitNulls = false
        encodeDefaults = false
    }

    // ─── Health ──────────────────────────────────────────────────────────────

    /** `GET /api/v1/health` (a 207 "degraded" answer is returned, not thrown). */
    public fun health(): HealthResponse = get("api/v1/health", ok = setOf(207))

    /** `GET /api/v1/health/ready`; returns the body for both 200 and 503. */
    public fun ready(min: Int? = null): ReadinessResponse =
        get("api/v1/health/ready", query = mapOf("min" to min?.toString()), ok = setOf(503))

    // ─── Servers ─────────────────────────────────────────────────────────────

    /** `GET /api/v1/servers` — servers visible to this key. */
    public fun servers(): List<ServerSummary> = get<ServersEnvelope>("api/v1/servers").servers

    /** `GET /api/v1/servers/{id}`. */
    public fun server(id: String): ServerDetails = get("api/v1/servers/${encode(id)}")

    /** `POST /api/v1/servers/{id}/reconnect`. */
    public fun reconnect(id: String): ReconnectResponse =
        send("POST", "api/v1/servers/${encode(id)}/reconnect", body = "{}", ok = setOf(502))

    // ─── Tools ───────────────────────────────────────────────────────────────

    /** `GET /api/v1/tools`, optionally for one server or tag. */
    public fun listTools(server: String? = null, tag: String? = null): List<Tool> =
        get<ToolsEnvelope>("api/v1/tools", query = mapOf("server" to server, "tag" to tag)).tools

    /** `GET /api/v1/tools?format=` — tool schemas for an LLM API plus the name → target mapping. */
    public fun toolSchemas(format: ToolSchemaFormat, server: String? = null, tag: String? = null): ToolSchemas =
        get("api/v1/tools", query = mapOf("format" to format.wire, "server" to server, "tag" to tag))

    /** `POST /api/v1/tools/call`. Pass [server] when the tool name exists on several servers. */
    public fun callTool(tool: String, arguments: JsonObject = JsonObject(emptyMap()), server: String? = null): CallToolResponse {
        val body = json.encodeToString(CallToolBody.serializer(), CallToolBody(tool, arguments, server))
        return send("POST", "api/v1/tools/call", body = body)
    }

    /** Execute an LLM tool call produced from [toolSchemas] (arguments as the model's JSON string). */
    public fun callLlmTool(schemas: ToolSchemas, name: String, argumentsJson: String?): CallToolResponse {
        val target = schemas.mapping[name] ?: throw GatewayException("Unknown LLM tool name \"$name\"", 0)
        val args = if (argumentsJson.isNullOrBlank()) JsonObject(emptyMap()) else json.parseToJsonElement(argumentsJson).jsonObject
        return callTool(target.tool, args, target.server)
    }

    // ─── Requests ────────────────────────────────────────────────────────────

    /** `GET /api/v1/requests` — recent calls, newest first. */
    public fun requests(limit: Int = 50): List<RequestRecord> =
        get<RequestsEnvelope>("api/v1/requests", query = mapOf("limit" to limit.toString())).requests

    /** Open an MCP session on the gateway's `/mcp` endpoint. */
    public fun mcp(path: String = "mcp"): McpSession = McpSession(this, path.trimStart('/')).also { it.connect() }

    // ─── Plumbing ────────────────────────────────────────────────────────────

    internal fun url(path: String, query: Map<String, String?> = emptyMap()): HttpUrl {
        val b = baseUrl.newBuilder()
        path.split('/').filter { it.isNotEmpty() }.forEach { b.addEncodedPathSegment(it) }
        query.forEach { (k, v) -> if (v != null) b.addQueryParameter(k, v) }
        return b.build()
    }

    internal fun requestBuilder(url: HttpUrl): Request.Builder {
        val b = Request.Builder().url(url)
        headers.forEach { (k, v) -> b.header(k, v) }
        val bearer = apiKey ?: tokenProvider?.invoke()
        if (bearer != null) b.header("Authorization", "Bearer $bearer")
        return b
    }

    internal fun execute(request: Request): Response = try {
        http.newCall(request).execute()
    } catch (e: IOException) {
        throw GatewayException("Network error: ${e.message}", 0, cause = e)
    }

    private inline fun <reified T> get(path: String, query: Map<String, String?> = emptyMap(), ok: Set<Int> = emptySet()): T =
        decode(serializer(), "GET", url(path, query), null, ok)

    private inline fun <reified T> send(method: String, path: String, body: String, ok: Set<Int> = emptySet()): T =
        decode(serializer(), method, url(path), body, ok)

    private fun <T> decode(ser: KSerializer<T>, method: String, url: HttpUrl, body: String?, ok: Set<Int>): T {
        val rb = requestBuilder(url).header("Accept", "application/json")
        rb.method(method, body?.toRequestBody(JSON_MEDIA))
        execute(rb.build()).use { res ->
            val text = res.body?.string().orEmpty()
            if (!res.isSuccessful && res.code !in ok) throw errorFrom(res.code, text, res.header("Retry-After"))
            return json.decodeFromString(ser, text)
        }
    }

    internal fun errorFrom(status: Int, text: String, retryAfter: String?): GatewayException {
        val message = runCatching {
            val obj = json.parseToJsonElement(text).jsonObject
            (obj["message"] as? JsonPrimitive)?.content
                ?: (obj["error"] as? JsonObject)?.get("message")?.let { (it as? JsonPrimitive)?.content }
                ?: (obj["error"] as? JsonPrimitive)?.content
        }.getOrNull() ?: "HTTP $status"
        return GatewayException(message, status, text, retryAfter?.toLongOrNull())
    }

    private fun encode(segment: String): String =
        HttpUrl.Builder().scheme("http").host("x").addPathSegment(segment).build().encodedPathSegments[0]

    internal companion object {
        val JSON_MEDIA = "application/json".toMediaType()
    }
}
