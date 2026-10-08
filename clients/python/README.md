# mcp-gateway-client (Python)

Typed, dependency-free (stdlib only) Python client for [mcp-gateway](https://github.com/HarrisonCN/mcp-gateway). Python ≥ 3.9.

```bash
pip install "git+https://github.com/HarrisonCN/mcp-gateway#subdirectory=clients/python"
```

```python
from mcp_gateway_client import GatewayClient, GatewayError

gw = GatewayClient("http://localhost:4000", api_key="mgw_...")
print(gw.health()["status"])
for t in gw.list_tools():
    print(t["server"], t["name"])
try:
    res = gw.call_tool("read_file", {"path": "/etc/hosts"}, server="fs")
except GatewayError as e:
    if e.is_policy_error:
        print("blocked:", e)
```

LLM tool schemas: `gw.tool_schemas("openai" | "openai-responses" | "anthropic")`, then
`gw.call_llm_tool(schemas, name, arguments)`. Approvals: `approvals()`, `approve(id)`, `deny(id)`.

Tests: `PYTHONPATH=src python -m unittest discover -s tests`.
