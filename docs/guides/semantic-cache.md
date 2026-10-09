# Semantic cache (7.4)

The [tool cache](../configuration.md#tool-result-caching) (2.2) answers repeated calls with *identical* arguments.
The semantic cache answers calls whose **text arguments mean the same thing** — useful for search, documentation
lookup or FAQ tools that agents call with slightly different wording.

```yaml
features:
  semanticCache:
    tools: ["search/*", "docs/lookup"] # opt-in: server/tool globs
    threshold: 0.9 # cosine similarity needed for a hit
    ttlSeconds: 3600
    maxEntries: 5000 # oldest entries are evicted first
    scope: tenant # tenant (default) | client | global
    embedding:
      provider: local # local | openai
```

How a call is matched:

1. Arguments are split into **text** (every string, with its path: `q: weather in Paris`) and **everything else**
   (numbers, booleans, `null`, structure). Everything else must match exactly — `{ days: 3 }` never answers `{ days: 7 }`.
2. The text is embedded and compared with earlier successful calls of the same tool in the same **scope** (tenant,
   client or global). The best match at or above `threshold` within its TTL answers the call without the upstream.
3. Hits carry `_meta["mcp-gateway/semantic-cache"]` (`similarity`, `cachedAt`); errors are never cached; an embedding
   failure is a miss.

## Embeddings

| Provider | |
|---|---|
| `local` (default) | Hashed words, word pairs and character trigrams — offline and deterministic. Catches reordering, case, punctuation and small edits; conservative on real paraphrases. |
| `openai` | Any OpenAI-compatible `POST <url>/embeddings` (OpenAI, Azure OpenAI, Ollama, vLLM…): `url`, `model` (default `text-embedding-3-small`), `apiKeyEnv` (name of the env var with the key). Embeddings are memoised. |

Tune `threshold` with `POST /api/v1/admin/semantic-cache/similarity` before enabling a tool.

## Admin API

| | |
|-|-|
| `GET /api/v1/admin/semantic-cache` | settings, entries, hits / misses / stores / evictions / errors |
| `POST /api/v1/admin/semantic-cache/similarity` | `{ a, b }` → `similarity`, `match` |
| `DELETE /api/v1/admin/semantic-cache[?tool=server/tool]` | purge |

Feature modules can answer calls themselves: a call hook's `before` may now return `{ respond }` (7.4).
