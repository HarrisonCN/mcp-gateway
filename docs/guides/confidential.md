# Confidential computing / TEE (9.3)

Some tools touch data that must never be visible to the host it runs on — payroll, health records, signing keys.
Run those MCP servers inside a trusted execution environment (AMD SEV-SNP, Intel TDX, AWS Nitro Enclaves, Intel SGX)
and let the gateway send them calls **only after remote attestation** has proven what is running and where.

```yaml
version: 11
features:
  confidential:
    nonceTtlSeconds: 120
    servers:
      - match: "payroll-*" # server id glob
        platforms: [sev-snp, tdx]
        measurements: ["5f1c9a0e…"] # allowed launch measurements, lower-case hex
        trustedKeys:
          # keys of the attestation service / verifier you trust
          - |
            -----BEGIN PUBLIC KEY-----
            …
            -----END PUBLIC KEY-----
        validitySeconds: 3600
        allowDebug: false
```

## Flow

1. The workload's sidecar asks for a nonce: `POST /api/v1/admin/confidential/payroll-eu/nonce` → `{ nonce }`.
2. It gets a hardware report binding the nonce and has its attestation service (e.g. your verifier for SNP/TDX quotes,
   or the Nitro attestation document check) sign the verified claims.
3. It posts the evidence: `POST /api/v1/admin/confidential/payroll-eu/attest`

```json
{ "report": { "platform": "sev-snp", "measurement": "5f1c9a0e…", "nonce": "…", "issuedAt": "2026-10-08T12:00:00Z", "debug": false },
  "signature": "<base64 signature over the canonical JSON (sorted keys) of report>" }
```

The gateway verifies the signature (Ed25519, ECDSA or RSA with SHA-256), platform, measurement, the single-use nonce,
`issuedAt` and debug mode. A valid attestation unlocks calls for `validitySeconds`; re-attest before it expires.
Until then — and after `DELETE /api/v1/admin/confidential/:server` — every call to the server fails with JSON-RPC
**-32024** (`ERR_ATTESTATION_REQUIRED`).

`GET /api/v1/admin/confidential` lists protected servers with their attestation state and the last rejection reason.
