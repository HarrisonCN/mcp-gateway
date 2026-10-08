import json
import os
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from mcp_gateway_client import GatewayClient, GatewayError

# local fake server: bypass any HTTP(S)_PROXY from the environment
os.environ["NO_PROXY"] = os.environ["no_proxy"] = "127.0.0.1,localhost"
SEEN = []


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *a):  # silence
        pass

    def _send(self, status, body, headers=None):
        data = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        for k, v in (headers or {}).items():
            self.send_header(k, v)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        SEEN.append(("GET", self.path, self.headers.get("Authorization"), None))
        if self.path == "/api/v1/health":
            return self._send(207, {"status": "degraded", "version": "4.7.0"})
        if self.path.startswith("/api/v1/health/ready"):
            return self._send(503, {"status": "not_ready"})
        if self.path.startswith("/api/v1/tools?") and "format=openai" in self.path:
            return self._send(200, {"tools": [], "mapping": {"fs__read": {"server": "fs", "tool": "read"}}})
        if self.path.startswith("/api/v1/tools"):
            return self._send(200, {"tools": [{"name": "read", "server": "fs"}]})
        if self.path == "/api/v1/servers":
            return self._send(200, {"servers": [{"id": "fs"}]})
        if self.path == "/api/v1/limited":
            return self._send(429, {"error": {"message": "slow down"}}, {"Retry-After": "3"})
        return self._send(404, {"error": "not found"})

    def do_POST(self):
        n = int(self.headers.get("Content-Length") or 0)
        body = json.loads(self.rfile.read(n) or b"null")
        SEEN.append(("POST", self.path, self.headers.get("Authorization"), body))
        if self.path == "/api/v1/tools/call":
            if body["tool"] == "danger":
                return self._send(403, {"code": -32003, "message": "denied by policy"})
            return self._send(200, {"result": {"content": [{"type": "text", "text": "ok"}]}, "server": body.get("server", "fs"), "tool": body["tool"], "durationMs": 3})
        return self._send(404, {"error": "not found"})


class ClientTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.srv = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        threading.Thread(target=cls.srv.serve_forever, daemon=True).start()
        cls.url = "http://127.0.0.1:%d/" % cls.srv.server_address[1]

    @classmethod
    def tearDownClass(cls):
        cls.srv.shutdown()

    def setUp(self):
        SEEN.clear()
        self.c = GatewayClient(self.url, api_key="k1")

    def test_requires_base_url(self):
        with self.assertRaises(ValueError):
            GatewayClient("")

    def test_health_degraded_is_ok_and_auth_header(self):
        self.assertEqual(self.c.health()["status"], "degraded")
        self.assertEqual(SEEN[0][2], "Bearer k1")

    def test_ready_503(self):
        self.assertFalse(self.c.ready(min=1)["ready"])
        self.assertIn("min=1", SEEN[0][1])

    def test_token_callable(self):
        c = GatewayClient(self.url, token=lambda: "jwt")
        c.servers()
        self.assertEqual(SEEN[0][2], "Bearer jwt")

    def test_list_tools_and_call(self):
        self.assertEqual(self.c.list_tools(server="fs")[0]["name"], "read")
        self.assertIn("server=fs", SEEN[0][1])
        res = self.c.call_tool("read", {"path": "/x"}, server="fs")
        self.assertEqual(res["tool"], "read")
        self.assertEqual(SEEN[1][3], {"tool": "read", "arguments": {"path": "/x"}, "server": "fs"})

    def test_llm_tool(self):
        schemas = self.c.tool_schemas("openai")
        res = self.c.call_llm_tool(schemas, "fs__read", '{"path":"/a"}')
        self.assertEqual(res["server"], "fs")
        with self.assertRaises(GatewayError):
            self.c.call_llm_tool(schemas, "nope")

    def test_policy_error(self):
        with self.assertRaises(GatewayError) as cm:
            self.c.call_tool("danger")
        self.assertEqual(cm.exception.status, 403)
        self.assertTrue(cm.exception.is_policy_error)
        self.assertEqual(str(cm.exception), "denied by policy")

    def test_retry_after(self):
        with self.assertRaises(GatewayError) as cm:
            self.c._request("GET", "/api/v1/limited")
        self.assertEqual(cm.exception.retry_after, 3.0)
        self.assertEqual(str(cm.exception), "slow down")

    def test_network_error(self):
        c = GatewayClient("http://127.0.0.1:1", timeout=2)
        with self.assertRaises(GatewayError) as cm:
            c.health()
        self.assertEqual(cm.exception.status, 0)


if __name__ == "__main__":
    unittest.main()
