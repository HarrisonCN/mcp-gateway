# tool-quota — a third-party plugin, end to end

An example of a plugin written and signed by a vendor and run by an operator in an isolated runtime
(15.2.0-canary.1, plugin API v5). It limits how many calls each client may make to each tool per time window.

| File | What it is |
|---|---|
| `tool-quota.mjs` | the plugin — self-contained (no imports), so one signature covers it |
| `gateway.yaml` | the operator's `pluginTrust` + `plugins[]` entry (worker runtime, read-only permissions, limits) |
| `tool-quota.test.mjs` | a `node --test` file using `@winstonsayno/mcp-gateway/testing` |

## Lifecycle

1. **Install.** The vendor signs: `mcp-gateway plugin keygen -o vendor`, then
   `mcp-gateway plugin sign tool-quota.mjs -k vendor.key --key-id vendor-2026`. The operator adds `vendor.pub` to
   `pluginTrust.keys`, keeps `requireSigned: true` and checks the entry with `mcp-gateway plugin doctor -c gateway.yaml`.
   Anyone can check that the published file is what the source builds to:
   `mcp-gateway plugin verify tool-quota.mjs -p vendor.pub --key-id vendor-2026 --rebuilt <your build of tool-quota.mjs>`.
2. **Update.** Replace `tool-quota.mjs` and its `.sig` together, then reload the config. A file whose signature does
   not match is refused and the running version keeps serving; a good update closes the old runtime and the new code
   serves the next call.
3. **Revoke.** Remove the vendor key from `pluginTrust.keys` **and** the plugin's `plugins[]` entry in the same
   reload: the plugin is unloaded and its runtime closed. A reload that only drops the key is refused
   (`untrusted key "vendor-2026"`), and the plugin keeps running until its entry is removed too — a reload never
   leaves the running plugins out of step with the config. After a restart a revoked plugin is refused at startup.
4. **Crash recovery.** If the runtime dies (OOM kill, crash, `process.exit()`), the call in flight fails closed and the
   next call starts a fresh runtime (`restarts` in `GET /api/v1/plugins`; exponential backoff on repeated crashes).
   The quota counters live in the runtime's memory, so they start over after a crash, an update or a reload.

The repository test `test/plugin-sdk-15-2-1.test.ts` runs all four steps in the `worker` and the `process` runtime.
