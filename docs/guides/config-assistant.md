# Natural-language config assistant (8.7)

Say what you want changed; the assistant turns it into a config patch, **validates it and shows the diff** (dry
run), and applies it only when you confirm.

```yaml
features:
  configAssistant:
    llm:
      # optional
      baseUrl: https://api.openai.com/v1 # any OpenAI-compatible chat-completions endpoint (also local models)
      model: gpt-4o-mini
      apiKey: ${OPENAI_API_KEY}
```

```bash
curl -X POST $GW/api/v1/admin/config-assistant/plan -H "authorization: Bearer $OP" -H 'content-type: application/json' \
  -d '{"text":"Rate limit to 60 per minute. Require approval for payments/*. Cache search/query for 5 minutes."}'
# → { valid, planId, steps: [...], changes: [...], unparsed: [] }
curl -X POST $GW/api/v1/admin/config-assistant/apply -H "authorization: Bearer $OP" -d '{"planId":"…"}'
```

## Built-in phrasebook (no LLM)

| Say | Config |
|-----|--------|
| `rate limit to 50 per minute` | `rateLimit: { limit: 50, windowSeconds: 60 }` |
| `block github/delete_* for key:intern` · `allow …` · `require approval for payments/*` | a `policy.rules` entry, first in order |
| `cache search/query for 5 minutes` | `cache.rules` entry, `cache.enabled: true` |
| `add server docs at https://docs.example.com/mcp` · `remove server docs` | `servers` |
| `enable audit` · `disable audit` | `audit.enabled` |
| `set log level to debug` | `logLevel` |

One instruction per sentence or line. Anything the phrasebook does not understand is listed in `unparsed`, or — with
`llm` configured — sent to the model, which answers with a JSON merge patch. Secret-looking values (`key`, `token`,
`secret`, `password`) are replaced with `<redacted>` before the config leaves the gateway.

Every plan goes through the same validation and diff as `PUT /api/v1/admin/config?dryRun=true`; `apply` refuses a plan
when the running config changed after it was made (plan again). Plans expire after 10 minutes.
