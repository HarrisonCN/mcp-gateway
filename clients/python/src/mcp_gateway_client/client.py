"""Synchronous client for the mcp-gateway REST API (``/api/v1``), stdlib only."""
from __future__ import annotations

import json
import urllib.error
import urllib.parse
import urllib.request
from typing import Any, Callable, Dict, List, Mapping, Optional, Union

Json = Dict[str, Any]
TokenSource = Union[str, Callable[[], Optional[str]], None]

POLICY_CODES = (-32003, -32004, -32005, -32006)


class GatewayError(Exception):
    """Non-2xx response (``status`` = HTTP status) or network / timeout failure (``status`` = 0)."""

    def __init__(self, message: str, status: int, body: Any = None, retry_after: Optional[float] = None):
        super().__init__(message)
        self.status = status
        self.body = body
        self.retry_after = retry_after

    @property
    def code(self) -> Optional[int]:
        if isinstance(self.body, dict) and isinstance(self.body.get("code"), int):
            return self.body["code"]
        return None

    @property
    def is_policy_error(self) -> bool:
        return self.code in POLICY_CODES


class GatewayClient:
    """Typed client for mcp-gateway. ``base_url`` is the gateway root (no ``/api/v1``)."""

    def __init__(
        self,
        base_url: str,
        api_key: Optional[str] = None,
        token: TokenSource = None,
        headers: Optional[Mapping[str, str]] = None,
        timeout: float = 60.0,
    ) -> None:
        if not base_url:
            raise ValueError("base_url is required")
        self.base_url = base_url.rstrip("/")
        self.api_key = api_key
        self.token = token
        self.headers = dict(headers or {})
        self.timeout = timeout

    # ── health ──────────────────────────────────────────────────────────────
    def health(self) -> Json:
        """``GET /health`` (207 "degraded" is not an error)."""
        return self._request("GET", "/api/v1/health", ok=(207,))

    def ready(self, min: Optional[int] = None) -> Json:
        """``GET /health/ready``; adds ``ready: bool`` (200 and 503 both resolve)."""
        body = self._request("GET", "/api/v1/health/ready" + _query({"min": min}), ok=(503,))
        body["ready"] = body.get("status") == "ready"
        return body

    def metrics(self, window_ms: Optional[int] = None) -> Json:
        return self._request("GET", "/api/v1/metrics" + _query({"format": "json", "window": window_ms}))

    # ── servers ─────────────────────────────────────────────────────────────
    def servers(self) -> List[Json]:
        return self._request("GET", "/api/v1/servers")["servers"]

    def server(self, server_id: str) -> Json:
        return self._request("GET", "/api/v1/servers/" + _seg(server_id))

    def reconnect(self, server_id: str) -> Json:
        return self._request("POST", "/api/v1/servers/" + _seg(server_id) + "/reconnect", ok=(502,))

    # ── tools ───────────────────────────────────────────────────────────────
    def list_tools(self, server: Optional[str] = None, tag: Optional[str] = None) -> List[Json]:
        return self._request("GET", "/api/v1/tools" + _query({"server": server, "tag": tag}))["tools"]

    def tool_schemas(self, format: str, server: Optional[str] = None, tag: Optional[str] = None) -> Json:
        """Tool schemas for an LLM API: ``openai``, ``openai-responses`` or ``anthropic``."""
        return self._request("GET", "/api/v1/tools" + _query({"server": server, "tag": tag, "format": format}))

    def call_tool(self, tool: str, arguments: Optional[Mapping[str, Any]] = None, server: Optional[str] = None) -> Json:
        """``POST /tools/call`` → ``{result, server, tool, durationMs}``."""
        body: Json = {"tool": tool, "arguments": dict(arguments or {})}
        if server:
            body["server"] = server
        return self._request("POST", "/api/v1/tools/call", body)

    def call_llm_tool(self, schemas: Mapping[str, Any], name: str, arguments: Union[str, Mapping[str, Any], None] = None) -> Json:
        """Execute a tool call an LLM produced from :meth:`tool_schemas` (resolves ``mapping``)."""
        target = (schemas.get("mapping") or {}).get(name)
        if not target:
            raise GatewayError('Unknown LLM tool name "%s"' % name, 0)
        args = json.loads(arguments) if isinstance(arguments, str) and arguments else (arguments or {})
        return self.call_tool(target["tool"], args, server=target.get("server"))

    # ── history / resources / prompts / approvals ───────────────────────────
    def requests(self, limit: int = 50) -> List[Json]:
        return self._request("GET", "/api/v1/requests" + _query({"limit": limit}))["requests"]

    def list_resources(self, server: Optional[str] = None) -> List[Json]:
        return self._request("GET", "/api/v1/resources" + _query({"server": server}))["resources"]

    def read_resource(self, uri: str, server: Optional[str] = None) -> Json:
        body: Json = {"uri": uri}
        if server:
            body["server"] = server
        return self._request("POST", "/api/v1/resources/read", body)

    def list_prompts(self, server: Optional[str] = None) -> List[Json]:
        return self._request("GET", "/api/v1/prompts" + _query({"server": server}))["prompts"]

    def get_prompt(self, name: str, arguments: Optional[Mapping[str, str]] = None, server: Optional[str] = None) -> Json:
        body: Json = {"name": name, "arguments": dict(arguments or {})}
        if server:
            body["server"] = server
        return self._request("POST", "/api/v1/prompts/get", body)

    def approvals(self) -> Json:
        return self._request("GET", "/api/v1/approvals")

    def approve(self, approval_id: str, reason: Optional[str] = None) -> Json:
        return self._request("POST", "/api/v1/approvals/%s/approve" % _seg(approval_id), {"reason": reason} if reason else {})

    def deny(self, approval_id: str, reason: Optional[str] = None) -> Json:
        return self._request("POST", "/api/v1/approvals/%s/deny" % _seg(approval_id), {"reason": reason} if reason else {})

    # ── transport ───────────────────────────────────────────────────────────
    def auth_headers(self) -> Dict[str, str]:
        h = dict(self.headers)
        bearer = self.api_key or (self.token() if callable(self.token) else self.token)
        if bearer:
            h["Authorization"] = "Bearer " + bearer
        return h

    def _request(self, method: str, path: str, body: Any = None, ok: tuple = ()) -> Any:
        headers = {"Accept": "application/json", **self.auth_headers()}
        data = None
        if body is not None:
            data = json.dumps(body).encode()
            headers["Content-Type"] = "application/json"
        req = urllib.request.Request(self.base_url + path, data=data, headers=headers, method=method)
        try:
            with urllib.request.urlopen(req, timeout=self.timeout or None) as res:
                status, text, retry = res.status, res.read().decode(), res.headers.get("retry-after")
        except urllib.error.HTTPError as err:
            status, text, retry = err.code, err.read().decode(), err.headers.get("retry-after")
        except (urllib.error.URLError, OSError) as err:
            reason = getattr(err, "reason", err)
            raise GatewayError("Network error: %s" % reason, 0) from err
        try:
            parsed = json.loads(text) if text else None
        except ValueError:
            parsed = text
        if 200 <= status < 300 or status in ok:
            return parsed
        raise GatewayError(_message(parsed, status), status, parsed, float(retry) if retry else None)


def _message(parsed: Any, status: int) -> str:
    if isinstance(parsed, dict):
        if isinstance(parsed.get("message"), str):
            return parsed["message"]
        err = parsed.get("error")
        if isinstance(err, dict) and isinstance(err.get("message"), str):
            return err["message"]
        if isinstance(err, str):
            return err
    return "HTTP %d" % status


def _seg(s: str) -> str:
    return urllib.parse.quote(s, safe="")


def _query(params: Mapping[str, Any]) -> str:
    items = [(k, str(v)) for k, v in params.items() if v is not None and v != ""]
    return "?" + urllib.parse.urlencode(items) if items else ""
