# OpenTelemetry GenAI semantic conventions (6.3)

The gateway describes every tool call with the OpenTelemetry
[GenAI semantic conventions](https://opentelemetry.io/docs/specs/semconv/gen-ai/), so agent traffic shows up in any
GenAI-aware backend (Grafana, Datadog, Honeycomb, Langfuse, Arize Phoenix …).

```yaml
genaiTelemetry:
  systems: { llm: openai, claude: anthropic }   # server id → gen_ai.provider.name (calls become `chat` operations)
  modelArg: model                                # argument that carries the model name
  captureContent: false                          # true: gen_ai.input.messages / output.messages (JSON, 4 KB max)
  otlpEndpoint: http://otel-collector:4318       # optional OTLP/HTTP JSON push of spans + metrics
  exportIntervalMs: 10000
```

## Spans

| Attribute | Value |
|-----------|-------|
| `gen_ai.operation.name` | `execute_tool`, or `chat` for servers listed in `systems` |
| `gen_ai.tool.name` / `gen_ai.tool.call.id` / `gen_ai.tool.type` | tool, a fresh call id, `function` |
| `gen_ai.provider.name`, `gen_ai.request.model`, `gen_ai.response.model` | LLM servers |
| `gen_ai.usage.input_tokens` / `output_tokens` | from `usage` (OpenAI or Anthropic names), `_meta.usage` or `structuredContent.usage` |
| `error.type` | the JSON-RPC error code on failure |
| `mcp.server.id`, `mcp.client.id` | gateway-specific |

Span names follow the conventions: `execute_tool <tool>` and `chat <model>`.

## Metrics

- `gen_ai.client.operation.duration` (seconds) and `gen_ai.client.token.usage` (`{token}`, with `gen_ai.token.type`
  `input` / `output`) — cumulative histograms with the recommended bucket boundaries.

## API

- `GET /api/v1/admin/genai-otel` — settings and metric summaries.
- `GET /api/v1/admin/genai-otel/spans?limit=50` — recent spans.
- `GET /api/v1/admin/genai-otel/otlp` — metrics as an OTLP/JSON payload (pull, e.g. for a collector `httpcheck`).

With `otlpEndpoint`, new spans are pushed to `/v1/traces` and metrics to `/v1/metrics` every `exportIntervalMs` and
once more on shutdown. The general tracing (`tracing:`) is unchanged and can run alongside.
