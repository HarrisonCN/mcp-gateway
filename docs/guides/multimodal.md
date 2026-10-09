# Multimodal tools (9.1)

Tools increasingly return screenshots, recordings and generated audio. MCP carries them as base64 inside the
JSON-RPC result (`image`, `audio`, or an embedded `resource` with a `blob`). The `multimodal` section puts a policy
around that content and keeps huge payloads out of the JSON stream.

```yaml
version: 11
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

## Ownership, signed links and budgets (11.2)

Every offloaded blob is bound to the client (principal) whose call produced it, that client's tenant and the
`server/tool`. `GET /api/v1/features/multimodal/blobs/<id>` is allowed only for the same client or a member of the
owning tenant, **and** only while the reader may still call that tool (checked by the gateway's central authorizer).
Everyone else — including operators and holders of a leaked URL — gets `404`, the same answer as for an unknown id.
Ids are 192-bit random.

```yaml
features:
  multimodal:
    offloadAboveBytes: 262144
    maxStoredBytes: 268435456        # global budget of held blobs (default 256 MiB)
    maxTenantStoredBytes: 67108864   # per tenant, or per client outside tenants (default 64 MiB)
    storage: { type: filesystem, dir: /var/lib/mcp-gateway/blobs }   # default { type: memory }
    signedLinks: { key: ${BLOB_LINK_KEY}, ttlSeconds: 300 }
```

- **Budgets**: when a new blob does not fit, expired blobs go first, then the least-recently-read blobs of the same
  tenant (tenant budget) and of everyone (global budget, `maxBlobs`). An item larger than a budget is refused
  (`-32022`) or stripped per `onViolation`. Counters: `evicted`, `overBudget`, `deniedReads`, `heldBytes` (admin view
  and Prometheus `mcp_gateway_multimodal_*`).
- **Filesystem storage** writes `<id>.bin` + `<id>.json` (mode 0600) to `dir`; instances that share the directory
  (a shared volume) serve each other's blobs, with the same ownership check. An S3-compatible backend is not built in;
  mount the bucket (e.g. s3fs / gcsfuse) as the directory.
- **Signed links**: links carry `?exp=…&sig=…` — an HMAC over the blob id, the owner and the expiry. A read needs a
  valid, unexpired signature in addition to the ownership check.

## Admin API

- `GET /api/v1/admin/multimodal` — policy, counters (`items`, `bytes`, `refused`, `stripped`, `offloaded`) and blobs.
- `DELETE /api/v1/admin/multimodal/blobs` — drop every held blob.
