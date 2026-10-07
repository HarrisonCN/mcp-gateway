package io.github.harrisoncn.mcpgateway

import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import kotlin.test.AfterTest
import kotlin.test.BeforeTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

class GatewayClientTest {
    private lateinit var server: MockWebServer
    private lateinit var client: GatewayClient

    @BeforeTest
    fun setUp() {
        server = MockWebServer()
        server.start()
        client = GatewayClient(server.url("/").toString(), apiKey = "k")
    }

    @AfterTest
    fun tearDown() {
        server.shutdown()
    }

    private fun json(code: Int, body: String, vararg headers: Pair<String, String>) {
        val r = MockResponse().setResponseCode(code).setHeader("Content-Type", "application/json").setBody(body)
        headers.forEach { (k, v) -> r.setHeader(k, v) }
        server.enqueue(r)
    }

    @Test
    fun healthAndReadiness() {
        json(207, """{"status":"degraded","version":"0.7.0","uptime":1.5,"servers":{"total":2,"online":1,"offline":1,"totalTools":3}}""")
        val h = client.health()
        assertEquals("degraded", h.status)
        assertEquals(1, h.servers.offline)
        val req = server.takeRequest()
        assertEquals("/api/v1/health", req.path)
        assertEquals("Bearer k", req.getHeader("Authorization"))

        json(503, """{"status":"not_ready","servers":{"ready":0,"total":1,"required":1}}""")
        val r = client.ready(min = 1)
        assertFalse(r.ready)
        assertEquals("/api/v1/health/ready?min=1", server.takeRequest().path)
    }

    @Test
    fun serversAndTools() {
        json(200, """{"servers":[{"id":"a","name":"A","transport":"stdio","toolCount":1,"health":{"serverId":"a","status":"online","latencyMs":3}}],"total":1}""")
        assertEquals("online", client.servers().single().health?.status)

        json(200, """{"id":"a b","name":"A","transport":"stdio","tools":[{"name":"echo","serverId":"a b","serverName":"A","inputSchema":{"type":"object"}}]}""")
        assertEquals("echo", client.server("a b").tools.single().name)
        assertEquals("/api/v1/servers/a%20b", server.takeRequest().let { server.takeRequest() }.path)

        json(200, """{"tools":[{"name":"echo","serverId":"a","serverName":"A","extra":"ignored"}],"total":1}""")
        assertEquals(1, client.listTools(server = "a").size)
        assertEquals("/api/v1/tools?server=a", server.takeRequest().path)
    }

    @Test
    fun callToolAndLlmMapping() {
        json(200, """{"result":{"content":[{"type":"text","text":"hi"}]},"server":"a","tool":"echo","durationMs":4}""")
        val r = client.callTool("echo", buildJsonObject { put("msg", "hi") }, server = "a")
        assertEquals("hi", r.result.text)
        val sent = server.takeRequest()
        assertEquals("POST", sent.method)
        assertEquals("""{"tool":"echo","arguments":{"msg":"hi"},"server":"a"}""", sent.body.readUtf8())

        json(200, """{"format":"openai","tools":[{"type":"function","function":{"name":"a__echo"}}],"mapping":{"a__echo":{"server":"a","tool":"echo"}},"total":1}""")
        val schemas = client.toolSchemas(ToolSchemaFormat.OPENAI)
        assertEquals("/api/v1/tools?format=openai", server.takeRequest().path)
        json(200, """{"result":{"content":[]},"server":"a","tool":"echo","durationMs":1}""")
        client.callLlmTool(schemas, "a__echo", """{"x":1}""")
        assertEquals("""{"tool":"echo","arguments":{"x":1},"server":"a"}""", server.takeRequest().body.readUtf8())
        assertFailsWith<GatewayException> { client.callLlmTool(schemas, "nope", null) }
    }

    @Test
    fun errors() {
        json(429, """{"error":"Too Many Requests","message":"Rate limit exceeded","retryAfter":7}""", "Retry-After" to "7")
        val e = assertFailsWith<GatewayException> { client.callTool("echo") }
        assertEquals(429, e.status)
        assertEquals(7L, e.retryAfterSeconds)
        assertEquals("Rate limit exceeded", e.message)

        json(404, """{"error":{"code":"NOT_FOUND","message":"Route GET /x not found"}}""")
        assertEquals("Route GET /x not found", assertFailsWith<GatewayException> { client.servers() }.message)

        val down = GatewayClient("http://127.0.0.1:1")
        assertEquals(0, assertFailsWith<GatewayException> { down.health() }.status)
    }

    @Test
    fun tokenProviderAndHeaders() {
        val c = GatewayClient(server.url("/").toString(), tokenProvider = { "jwt-1" }, headers = mapOf("X-App" to "aura"))
        json(200, """{"requests":[]}""")
        assertTrue(c.requests(5).isEmpty())
        val req = server.takeRequest()
        assertEquals("Bearer jwt-1", req.getHeader("Authorization"))
        assertEquals("aura", req.getHeader("X-App"))
        assertEquals("/api/v1/requests?limit=5", req.path)
    }

    @Test
    fun mcpSession() {
        json(200, """{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"2025-06-18","capabilities":{"tools":{}},"serverInfo":{"name":"mcp-gateway","version":"x"}}}""", "Mcp-Session-Id" to "sid")
        server.enqueue(MockResponse().setResponseCode(202))
        json(200, """{"jsonrpc":"2.0","id":2,"result":{"tools":[{"name":"t1","inputSchema":{}}],"nextCursor":"c"}}""")
        json(200, """{"jsonrpc":"2.0","id":3,"result":{"tools":[{"name":"t2","inputSchema":{}}]}}""")
        server.enqueue(
            MockResponse().setResponseCode(200).setHeader("Content-Type", "text/event-stream")
                .setBody("event: message\ndata: {\"jsonrpc\":\"2.0\",\"id\":4,\"result\":{\"content\":[{\"type\":\"text\",\"text\":\"ok\"}]}}\n\n"),
        )
        json(200, """{"jsonrpc":"2.0","id":5,"error":{"code":-32602,"message":"Unknown tool: x"}}""")
        server.enqueue(MockResponse().setResponseCode(204))

        val s = client.mcp()
        assertEquals("sid", s.sessionId)
        assertEquals("mcp-gateway", s.info?.serverInfo?.name)
        assertEquals(listOf("t1", "t2"), s.listTools().map { it.name })
        assertEquals("ok", s.callTool("t1").text)
        val err = assertFailsWith<McpException> { s.callTool("x") }
        assertEquals(-32602, err.code)
        s.close()
        assertNull(s.sessionId)

        val init = server.takeRequest()
        assertEquals("/mcp", init.path)
        assertTrue(init.body.readUtf8().contains("\"initialize\""))
        val initialized = server.takeRequest()
        assertEquals("sid", initialized.getHeader("Mcp-Session-Id"))
        val list = server.takeRequest()
        assertEquals("2025-06-18", list.getHeader("MCP-Protocol-Version"))
        repeat(3) { server.takeRequest() }
        assertEquals("DELETE", server.takeRequest().method)
    }

    @Test
    fun approvalsAndPolicyErrors() {
        json(200, """{"pending":[{"id":"ap1","status":"pending","serverId":"a","tool":"echo"}],"recent":[]}""")
        assertEquals("ap1", client.approvals().pending.single().id)
        assertEquals("/api/v1/approvals", server.takeRequest().path)

        json(200, """{"id":"ap1","status":"approved","reason":"ok"}""")
        assertEquals("approved", client.approve("ap1", "ok").status)
        val sent = server.takeRequest()
        assertEquals("/api/v1/approvals/ap1/approve", sent.path)
        assertEquals("""{"reason":"ok"}""", sent.body.readUtf8())

        json(403, """{"error":"Forbidden","message":"outside sandbox","code":-32003}""")
        val e = assertFailsWith<GatewayException> { client.callTool("rm") }
        assertEquals(-32003, e.code)
        assertTrue(e.isPolicyError)
        assertNull(GatewayException("x", 500).code)
    }
}
