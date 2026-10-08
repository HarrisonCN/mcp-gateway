"""mcp-gateway-client — typed, dependency-free Python client for mcp-gateway."""
from .client import GatewayClient, GatewayError

__all__ = ["GatewayClient", "GatewayError", "__version__"]
__version__ = "4.7.0"
