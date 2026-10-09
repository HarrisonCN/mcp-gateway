# Ecosystem marketplace GA (9.8)

The [plugin marketplace](plugins.md) (5.4) distributed signed artifacts and the [tool registry](tool-registry.md)
(9.4) signed tool manifests. 9.8 adds what a public ecosystem needs on top: a moderated catalogue, ratings and
reviews, and verified publishers.

```yaml
version: 9
ecosystem:
  file: ./data/ecosystem.json
  autoApproveVerified: false
  publishers:
    - id: acme
      name: ACME Corp
      domain: acme.example
      keyIds: [acme-2026]
```

## Listings and review

Any authenticated client submits a listing:

```http
POST /api/v1/features/ecosystem/submissions
{ "name": "pii-guard", "version": "2.0.0", "kind": "plugin", "publisher": "acme",
  "description": "Redacts PII in tool results", "url": "https://plugins.acme.example/pii-guard-2.0.0.mjs",
  "sha256": "…", "keyId": "acme-2026", "tags": ["security", "privacy"] }
```

It lands in the review queue (`GET /api/v1/admin/ecosystem`) as `pending`. Operators approve it
(`POST /api/v1/admin/ecosystem/listings/acme.pii-guard@2.0.0/approve`) or reject it with a reason
(`…/reject { "reason": "…" }`). Listing ids are `<publisher>.<name>@<version>`; a version is submitted once.
Installing still goes through the signed [marketplace](plugins.md) / [registry](tool-registry.md) flows — the
catalogue entry carries `url`, `sha256` and `keyId` for that.

## Catalogue, ratings and reviews

`GET /api/v1/features/ecosystem/catalog?q=pii&kind=plugin&tag=security` lists approved listings, verified publishers
and higher ratings first. Each client rates a listing once — `POST …/listings/:id/ratings { "stars": 4, "comment": "…" }`
(again to change it). `GET …/listings/:id` shows the visible reviews. Operators hide abusive ones with
`POST /api/v1/admin/ecosystem/reviews/:listing/:client/hide` (they no longer count in the average).

## Verified publishers

`POST /api/v1/admin/ecosystem/publishers/acme/verify` fetches `https://acme.example/.well-known/mcp-gateway-publisher.json`
(no redirects) and requires it to name the publisher and list every configured key id:

```json
{ "publisher": "acme", "keyIds": ["acme-2026"] }
```

Verified publishers get a badge in the catalogue; with `autoApproveVerified: true` their submissions skip the queue.
