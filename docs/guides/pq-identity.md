# Post-quantum identity: ML-DSA hybrid signatures (10.8, EXPERIMENTAL)

10.8 adds Ed25519 + **ML-DSA** (FIPS 204) **hybrid** signatures for the gateway's identity, its tool manifest, its
audit log and plugin artifacts. A hybrid signature verifies only if *both* signatures verify, so it holds as long as
either algorithm does — the usual transition strategy until post-quantum algorithms have more deployment history.

It is **experimental**: `validate`, startup and `GET /api/v1/security` say so.

## Implementation

- ML-DSA-44 / 65 / 87. On a runtime whose `node:crypto` implements ML-DSA (Node 24.7+ with OpenSSL 3.5) the gateway
  uses it, after a start-up self-test that cross-verifies against the reference implementation. Otherwise (Node 22)
  it uses [`@noble/post-quantum`](https://github.com/paulmillr/noble-post-quantum) 0.7.1 (pure JavaScript, pinned;
  widely used but **not independently audited** — its README says so). `mcp-gateway pq info` and
  `GET /api/v1/admin/pq-identity` show which backend is active. Both produce standard FIPS 204 signatures.
- Keys are JSON: `{ "kty": "ML-DSA", "alg": "ml-dsa-65", "pub": <base64>, "seed": <base64> }` (the 32-byte seed is the
  private key). A hybrid key file holds `{ "ed25519": <PKCS#8 PEM>, "mldsa": { … } }`.

```bash
mcp-gateway pq keygen -o keys/gateway          # keys/gateway.hybrid.json (secret, 0600) + keys/gateway.pub.json
mcp-gateway pq info
```

## Gateway identity, tool manifest, audit log

```yaml
features:
  pqIdentity:
    keyFile: keys/gateway.hybrid.json   # relative to the config file
    keyId: gw-2026
    gatewayId: gateway.example.com
    validityDays: 90
    toolManifest: true
    auditLog: { dir: .mcp-gateway/pq-audit, checkpointEvery: 100, checkpointSeconds: 300 }
```

| Method | Path | |
|---|---|---|
| `GET` | `/api/v1/features/pq-identity/identity` | Signed identity document: subject, key id, both public keys, validity |
| `GET` | `/api/v1/features/pq-identity/tool-manifest` | Signed list of the tools *this key* may see (server, name, description, SHA-256 of the input schema) |
| `GET` | `/api/v1/admin/pq-identity` | Backend, public key, identity, audit chain head |
| `GET` | `/api/v1/admin/pq-identity/audit?limit=` | Audit records (newest first) |
| `POST` | `/api/v1/admin/pq-identity/audit/checkpoint` | Sign the chain head now |
| `POST` | `/api/v1/admin/pq-identity/audit/verify` | `{ records? }` — recompute the chain and check every checkpoint (default: in-memory records) |
| `POST` | `/api/v1/admin/pq-identity/verify` | `{ domain: identity \| manifest \| audit, document }` — verify a signed document |

Signed documents are `{ payload, keyId, signature: { alg: "ed25519+ml-dsa-65", ed25519, mldsa } }` over
`<domain>\n<canonical JSON of payload>` (sorted keys); the domain string (`mcp-gateway-identity:v1`,
`mcp-gateway-tool-manifest:v1`, `mcp-gateway-audit:v1`) prevents a signature for one purpose being replayed for
another.

**Audit chain.** Every tool call — including refused ones — is appended as `{ seq, at, client, server, tool,
outcome, code?, argsSha256, prev, hash }`, `hash = sha256(prev ‖ canonical(entry))`. Every `checkpointEvery` entries,
at least every `checkpointSeconds` with new entries, and at shutdown, a checkpoint signs `seq:hash`. Verification
reports modified entries, gaps, forged checkpoints, how far the chain is covered by a valid signature
(`verifiedThrough`) and the unsigned tail. Arguments are stored only as a hash.

## Plugin artifacts

```yaml
features:
  pluginTrust:
    requireSigned: true
    requirePostQuantum: true          # refuse classical-only signatures and keys
    keys:
      - id: acme-2026
        publicKey: "-----BEGIN PUBLIC KEY-----\n…"          # Ed25519
        mldsa: { kty: ML-DSA, alg: ml-dsa-65, pub: "…" }    # from keys/acme.pub.json → "mldsa"
```

```bash
mcp-gateway plugin sign plugin.mjs -k acme.key --key-id acme-2026 --pq-key keys/acme.hybrid.json
```

A key with an `mldsa` part accepts only hybrid signatures (both parts must verify).

## Not provided (why it is experimental)

- **No X.509 hybrid certificates.** The identity document is signed JSON; TLS stacks cannot use it. Post-quantum TLS
  key exchange is a separate feature ([pq-tls](pq-tls.md)).
- No key rotation / revocation protocol, no HSM / KMS-held keys (the key file is on disk).
- The audit chain is per process; with several replicas each keeps its own chain.
- `@noble/post-quantum` (the Node 22 backend) has not been independently audited.
