"""Streaming tool calls (``POST /api/v1/tools/stream``) and MCP sessions (``/mcp``), stdlib only (5.7)."""
from __future__ import annotations

import json
import urllib.error
import urllib.request
from typing import Any, Dict, Iterator, List, Mapping, Optional

from .client import GatewayClient, GatewayError, _message

Json = Dict[str, Any]
PROTOCOL_VERSION = "2025-11-25"


def parse_sse(lines: Iterator[str]) -> Iterator[Json]:
    """Parse ``text/event-stream`` lines into ``{"event": str, "data": Any}`` dicts (JSON data decoded)."""
    event, data = "message", []
    for raw in lines:
        line = raw.rstrip("\r\n")
        if line == "":
            if data:
                text = "\n".join(data)
                try:
                    payload: Any = json.loads(text)
                except ValueError:
                    payload = text
                yield {"event": event, "data": payload}
            event, data = "message", []
        elif line.startswith(":"):
            continue
        elif line.startswith("event:"):
            event = line[6:].strip()
        elif line.startswith("data:"):
            data.append(line[5:].lstrip())
    if data:
        text = "\n".join(data)
        try:
            yield {"event": event, "data": json.loads(text)}
        except ValueError:
            yield {"event": event, "data": text}


def stream_tool(client: GatewayClient, tool: str, arguments: Optional[Mapping[str, Any]] = None, server: Optional[str] = None) -> Iterator[Json]:
    """Call a tool and yield its ``progress`` / ``partial`` / ``result`` / ``error`` / ``end`` events as they arrive."""
    body: Json = {"tool": tool, "arguments": dict(arguments or {})}
    if server:
        body["server"] = server
    headers = {"Accept": "text/event-stream", "Content-Type": "application/json", **client.auth_headers()}
    req = urllib.request.Request(client.base_url + "/api/v1/tools/stream", data=json.dumps(body).encode(), headers=headers, method="POST")
    try:
        res = urllib.request.urlopen(req, timeout=client.timeout or None)
    except urllib.error.HTTPError as err:
        text = err.read().decode()
        try:
            parsed: Any = json.loads(text)
        except ValueError:
            parsed = text
        raise GatewayError(_message(parsed, err.code), err.code, parsed) from err
    except (urllib.error.URLError, OSError) as err:
        raise GatewayError("Network error: %s" % getattr(err, "reason", err), 0) from err
    with res:
        for ev in parse_sse(line.decode("utf-8") for line in res):
            yield ev
            if ev["event"] == "end":
                return


class McpError(Exception):
    """JSON-RPC error from ``/mcp`` (``code`` is the JSON-RPC error code)."""

    def __init__(self, message: str, code: int, data: Any = None):
        super().__init__(message)
        self.code = code
        self.data = data


class McpSession:
    """A Streamable HTTP MCP session with the gateway's ``/mcp`` endpoint.

    >>> with McpSession(client) as s:
    ...     tools = s.list_tools()
    ...     result = s.call_tool("echo", {"hello": "world"})
    """

    def __init__(self, client: GatewayClient, path: str = "/mcp", protocol_version: str = PROTOCOL_VERSION, client_name: str = "mcp-gateway-client-python"):
        self.client = client
        self.url = client.base_url + path
        self.requested_version = protocol_version
        self.client_name = client_name
        self.session_id: Optional[str] = None
        self.protocol_version: Optional[str] = None
        self.server_info: Json = {}
        self.capabilities: Json = {}
        self._id = 0

    def __enter__(self) -> "McpSession":
        self.initialize()
        return self

    def __exit__(self, *exc: Any) -> None:
        self.close()

    def _post(self, msg: Json) -> Any:
        headers = {"Content-Type": "application/json", "Accept": "application/json, text/event-stream", **self.client.auth_headers()}
        if self.session_id:
            headers["Mcp-Session-Id"] = self.session_id
        if self.protocol_version:
            headers["MCP-Protocol-Version"] = self.protocol_version
        req = urllib.request.Request(self.url, data=json.dumps(msg).encode(), headers=headers, method="POST")
        try:
            with urllib.request.urlopen(req, timeout=self.client.timeout or None) as res:
                sid = res.headers.get("mcp-session-id")
                if sid:
                    self.session_id = sid
                ctype = res.headers.get("content-type") or ""
                raw = res.read().decode()
        except urllib.error.HTTPError as err:
            text = err.read().decode()
            try:
                parsed: Any = json.loads(text)
            except ValueError:
                parsed = text
            if isinstance(parsed, dict) and isinstance(parsed.get("error"), dict):
                e = parsed["error"]
                raise McpError(str(e.get("message")), int(e.get("code", 0)), e.get("data")) from err
            raise GatewayError(_message(parsed, err.code), err.code, parsed) from err
        except (urllib.error.URLError, OSError) as err:
            raise GatewayError("Network error: %s" % getattr(err, "reason", err), 0) from err
        if not raw:
            return None
        if "text/event-stream" in ctype:
            events = [ev["data"] for ev in parse_sse(iter(raw.splitlines(True))) if isinstance(ev["data"], dict) and "id" in ev["data"]]
            return events[-1] if events else None
        return json.loads(raw)

    def request(self, method: str, params: Optional[Json] = None) -> Any:
        self._id += 1
        reply = self._post({"jsonrpc": "2.0", "id": self._id, "method": method, **({"params": params} if params is not None else {})})
        if not isinstance(reply, dict):
            raise McpError("empty reply", -32603)
        if "error" in reply:
            e = reply["error"]
            raise McpError(str(e.get("message")), int(e.get("code", 0)), e.get("data"))
        return reply.get("result")

    def notify(self, method: str, params: Optional[Json] = None) -> None:
        self._post({"jsonrpc": "2.0", "method": method, **({"params": params} if params is not None else {})})

    def initialize(self) -> Json:
        result = self.request("initialize", {"protocolVersion": self.requested_version, "capabilities": {}, "clientInfo": {"name": self.client_name, "version": "5.7.0"}})
        self.protocol_version = result.get("protocolVersion")
        self.server_info = result.get("serverInfo") or {}
        self.capabilities = result.get("capabilities") or {}
        self.notify("notifications/initialized")
        return result

    def ping(self) -> None:
        self.request("ping")

    def list_tools(self) -> List[Json]:
        """All tools, following ``nextCursor`` pagination."""
        tools: List[Json] = []
        cursor: Optional[str] = None
        while True:
            page = self.request("tools/list", {"cursor": cursor} if cursor else {})
            tools.extend(page.get("tools") or [])
            cursor = page.get("nextCursor")
            if not cursor:
                return tools

    def call_tool(self, name: str, arguments: Optional[Mapping[str, Any]] = None) -> Json:
        return self.request("tools/call", {"name": name, "arguments": dict(arguments or {})})

    def close(self) -> None:
        """End the session (``DELETE /mcp``); errors are ignored."""
        if not self.session_id:
            return
        headers = {"Mcp-Session-Id": self.session_id, **self.client.auth_headers()}
        try:
            urllib.request.urlopen(urllib.request.Request(self.url, headers=headers, method="DELETE"), timeout=self.client.timeout or None).close()
        except Exception:  # noqa: BLE001
            pass
        self.session_id = None
