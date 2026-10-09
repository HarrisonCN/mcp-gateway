# Post-quantum TLS (9.7)

"Harvest now, decrypt later": traffic recorded today can be decrypted once large quantum computers exist. Hybrid
post-quantum key exchange protects it now. 9.7 makes the gateway's upstream HTTPS connections offer
**X25519MLKEM768** (X25519 combined with ML-KEM-768, FIPS 203 — the hybrid used by browsers and major CDNs).

```yaml
version: 10
features:
  postQuantumTls:
    mode: prefer # prefer | require | off
    groups: [X25519MLKEM768]
    classicalGroups: [X25519, P-256]
    servers: ["*"] # HTTPS upstreams (server id globs)
    certificatePolicy:
      allowedKeyTypes: [ec, ed25519, ed448, rsa, rsa-pss, ml-dsa]
      minRsaBits: 3072
      maxValidityDays: 398
      rejectSha1: true
```

## Requirements

ML-KEM needs OpenSSL 3.5+. Node.js 22.20+ and 24 bundle it; `GET /api/v1/admin/pq-tls` shows `supported` and the
`openssl` version. The Docker image follows the current Node 22 release — check `supported` after upgrading. With an older OpenSSL, `prefer` logs a warning and
uses classical key exchange; `require` makes upstream HTTPS connections fail instead of silently downgrading.

## Modes

- `prefer` — offer `groups` first, then `classicalGroups`; servers without PQ support still connect.
- `require` — offer only `groups`; servers without PQ support fail the handshake (no downgrade).
- `off` — OpenSSL defaults.

The setting applies to streamable-HTTP and SSE upstreams, including those using [mTLS](../configuration.md). The gateway's own
listener is plain HTTP behind your TLS terminator — enable `X25519MLKEM768` there (e.g. nginx with OpenSSL 3.5:
`ssl_ecdh_curve X25519MLKEM768:X25519;`).

## Probes and certificate policy

`POST /api/v1/admin/pq-tls/probe` (`{ "server": "search" }` for one) connects to every matching HTTPS upstream twice:
with the PQ groups only (`pq: true` when the server negotiates them) and classically (protocol, group, certificate).
The certificate is checked against `certificatePolicy` — key type (ML-DSA certificates are accepted when the policy
allows `ml-dsa`), RSA size, validity period, SHA-1 signatures and expiry. In `require` mode a server without PQ
support is reported as a violation. `GET /api/v1/admin/pq-tls` shows the last probe per upstream.
