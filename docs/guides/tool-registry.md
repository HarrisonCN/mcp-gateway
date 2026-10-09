# Global tool registry (9.4)

A registry of MCP tool packages that works across organisations: publishers sign manifests, every gateway can host
and search a registry, mirror others, and pin the versions it deploys.

```yaml
version: 9
toolRegistry:
  file: ./data/registry.json
  requireSignature: true
  trustedPublishers:
    acme: |
      -----BEGIN PUBLIC KEY-----
      …
      -----END PUBLIC KEY-----
  mirrors:
    - url: https://registry.partner.example/api/v1/features/tool-registry/index.json
      apiKey: ${PARTNER_REGISTRY_KEY}
      everySeconds: 3600
  pins:
    acme/search: "~1.2.0"
```

## Manifests

```json
{ "publisher": "acme", "name": "search", "version": "1.2.5", "description": "Web search",
  "tools": [{ "name": "web_search", "inputSchema": { "type": "object" } }],
  "server": { "transport": "streamable-http", "url": "https://search.acme.example/mcp" } }
```

Sign the canonical JSON of the manifest (keys sorted, no whitespace) with the publisher key and publish
`{ manifest, signature }` to `POST /api/v1/admin/tool-registry/publish`. Unsigned or unverifiable manifests are refused
while `requireSignature` is on. A version can be published once; the same content again is a no-op, different
content is refused (versions are immutable).

## Discover, resolve, mirror

- `GET /api/v1/admin/tool-registry?q=search` — latest stable version of each matching tool package.
- `GET /api/v1/admin/tool-registry/acme/search` — all versions; `…/resolve?range=^1.2.0` — highest match (ranges:
  `*`, exact, `1.2.x`, `^`, `~`, `>=`; without `range` the configured pin applies; pre-releases only match explicitly).
- Every gateway serves `GET /api/v1/features/tool-registry/index.json`; `mirrors` pull those indexes and re-verify each
  signature with *your* `trustedPublishers`, so a compromised mirror cannot inject packages.
