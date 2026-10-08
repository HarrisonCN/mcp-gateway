"""mcp-gateway-client — typed, dependency-free Python client for mcp-gateway."""
from .client import GatewayClient, GatewayError
from .mcp import McpError, McpSession, parse_sse, stream_tool

__all__ = ["GatewayClient", "GatewayError", "McpError", "McpSession", "parse_sse", "stream_tool", "__version__"]
__version__ = "5.7.0"
