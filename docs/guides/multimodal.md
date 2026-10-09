# Multimodal tools (9.1)

Tools increasingly return screenshots, recordings and generated audio. MCP carries them as base64 inside the
JSON-RPC result (`image`, `audio`, or an embedded `resource` with a `blob`). The `multimodal` section puts a policy
around that content and keeps huge payloads out of the JSON stream.

```yaml
version: 10
features:
  multimodal:
    allowedTypes: ["image/*", "audio/mpeg", "audio/wav"] # MIME globs; default image/* and audio/*
    maxItemBytes: 10485760 # decoded bytes per item
    maxTotalBytes: 33554432 # decoded bytes per tool result
    onViolation: refuse # or strip
    offloadAboveBytes: 262144 # hold larger items and return a link
    blobTtlSeconds: 600
    servers: ["*"]
```

## Policy

Every binary item in a successful tool result is checked against `allowedTypes`, `maxItemBytes` and the running
`maxTotalBytes`. With `onViolation: refuse` (default) the whole call fails with JSON-RPC **-32022**
(`ERR_MEDIA_REFUSED`) and the reason; with `strip` the item is replaced by a short text note and the rest of the
result is kept. Text content is never touched.

## Offloading and streaming

Allowed items above `offloadAboveBytes` are decoded once, held in memory for `blobTtlSeconds` (at most `maxBlobs`,
oldest dropped first) and replaced by:

```json
{ "type": "resource_link", "uri": "/api/v1/features/multimodal/blobs/<id>", "mimeType": "image/png", "size": 1843200 }
```

Any authenticated client fetches the link with its usual key; the gateway streams it in 64 KiB chunks with
`Content-Type`, `Content-Length` and `Range` / `206 Partial Content` support (media players can seek).

## Admin API

- `GET /api/v1/admin/multimodal` — policy, counters (`items`, `bytes`, `refused`, `stripped`, `offloaded`) and blobs.
- `DELETE /api/v1/admin/multimodal/blobs` — drop every held blob.
