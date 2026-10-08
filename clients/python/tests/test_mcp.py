import json
import os
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from mcp_gateway_client import GatewayClient, GatewayError, McpError, McpSession, parse_sse, stream_tool

os.environ["NO_PROXY"] = os.environ["no_proxy"] = "127.0.0.1,localhost"
LOG = []


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *a):
        pass

    def _json(self, status, body, headers=None):
        data = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        for k, v in (headers or {}).items():
            self.send_header(k, v)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_DELETE(self):
        LOG.append(("DELETE", self.headers.get("Mcp-Session-Id")))
        self.send_response(204)
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_POST(self):
        n = int(self.headers.get("Content-Length") or 0)
        body = json.loads(self.rfile.read(n) or b"null")
        if self.path == "/api/v1/tools/stream":
            if body["tool"] == "missing":
                return self._json(404, {"error": "Not Found", "message": "Unknown tool"})
            chunks = [
                ": ping\n\n",
                'event: progress\ndata: {"progress": 1, "total": 2}\n\n',
                'event: result\ndata: {"result": {"content": [{"type": "text", "text": "done"}]}}\n\n',
                "event: end\ndata: {}\n\n",
            ]
            data = "".join(chunks).encode()
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
            return
        if self.path == "/mcp":
            LOG.append(("POST", body.get("method"), self.headers.get("Mcp-Session-Id"), self.headers.get("MCP-Protocol-Version")))
            m = body.get("method")
            if "id" not in body:
                self.send_response(202)
                self.send_header("Content-Length", "0")
                self.end_headers()
                return
            if m == "initialize":
                return self._json(200, {"jsonrpc": "2.0", "id": body["id"], "result": {"protocolVersion": "2025-11-25", "serverInfo": {"name": "fake"}, "capabilities": {"tools": {}}}}, {"Mcp-Session-Id": "s-1"})
            if m == "tools/list":
                cur = (body.get("params") or {}).get("cursor")
                page = {"tools": [{"name": "b"}]} if cur else {"tools": [{"name": "a"}], "nextCursor": "2"}
                return self._json(200, {"jsonrpc": "2.0", "id": body["id"], "result": page})
            if m == "tools/call":
                text = 'event: message\ndata: {"jsonrpc":"2.0","id":%d,"result":{"content":[{"type":"text","text":"sse"}]}}\n\n' % body["id"]
                data = text.encode()
                self.send_response(200)
                self.send_header("Content-Type", "text/event-stream")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)
                return
            if m == "ping":
                return self._json(200, {"jsonrpc": "2.0", "id": body["id"], "result": {}})
            if m == "bad/http":
                return self._json(400, {"jsonrpc": "2.0", "id": None, "error": {"code": -32600, "message": "Invalid Request"}})
            return self._json(200, {"jsonrpc": "2.0", "id": body["id"], "error": {"code": -32601, "message": "Method not found"}})
        return self._json(404, {"error": "nope"})


class McpTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.srv = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        threading.Thread(target=cls.srv.serve_forever, daemon=True).start()
        cls.url = "http://127.0.0.1:%d" % cls.srv.server_address[1]

    @classmethod
    def tearDownClass(cls):
        cls.srv.shutdown()

    def setUp(self):
        LOG.clear()
        self.c = GatewayClient(self.url, api_key="k")

    def test_parse_sse(self):
        evs = list(parse_sse(iter(["event: a\n", "data: {\"x\":1}\n", "\n", "data: plain\n", "data: two\n"])))
        self.assertEqual(evs, [{"event": "a", "data": {"x": 1}}, {"event": "message", "data": "plain\ntwo"}])

    def test_stream_tool(self):
        evs = list(stream_tool(self.c, "slow", {"n": 1}, server="s"))
        self.assertEqual([e["event"] for e in evs], ["progress", "result", "end"])
        self.assertEqual(evs[1]["data"]["result"]["content"][0]["text"], "done")
        with self.assertRaises(GatewayError) as cm:
            list(stream_tool(self.c, "missing"))
        self.assertEqual(cm.exception.status, 404)

    def test_session(self):
        with McpSession(self.c) as s:
            self.assertEqual(s.protocol_version, "2025-11-25")
            self.assertEqual(s.server_info["name"], "fake")
            self.assertEqual([t["name"] for t in s.list_tools()], ["a", "b"])
            self.assertEqual(s.call_tool("echo", {"x": 1})["content"][0]["text"], "sse")
            s.ping()
            with self.assertRaises(McpError) as cm:
                s.request("nope")
            self.assertEqual(cm.exception.code, -32601)
            with self.assertRaises(McpError):
                s.request("bad/http")
        self.assertIn(("DELETE", "s-1"), LOG)
        self.assertEqual(LOG[1][:3], ("POST", "notifications/initialized", "s-1"))
        self.assertEqual(LOG[2][3], "2025-11-25")

    def test_network_error(self):
        c = GatewayClient("http://127.0.0.1:1")
        with self.assertRaises(GatewayError):
            McpSession(c).initialize()
        with self.assertRaises(GatewayError):
            list(stream_tool(c, "x"))


if __name__ == "__main__":
    unittest.main()
