# Migrating to 12.0

12.0 is a breaking **security** release. The config schema stays **v11** — no `migrate` run is needed — but runtime
defaults change.

## Breaking

1. **stdio servers no longer inherit the gateway's environment.** Only `PATH`, `HOME`, locale (`LANG`, `LC_*`),
   `TZ`, `TMPDIR`, `TERM` (and the Windows system variables) are passed. Add what a server needs:
   - explicit values: `servers[].env: { API_TOKEN: ${MY_TOKEN} }`
   - copy from the gateway's environment: `servers[].envPassthrough: [NAME, PREFIX_*]`
   - for every stdio server: `security.stdioEnvPassthrough: [HTTPS_PROXY, NODE_EXTRA_CA_CERTS]`

   Details and the new `isolation` options (uid/gid, working directory, bubblewrap / firejail / container sandbox,
   network off): [Isolating stdio MCP servers](../security/stdio-isolation.md).
2. **Multimodal defaults are lower:** `maxItemBytes` 10 MiB → **4 MiB**, `maxTotalBytes` 32 MiB → **16 MiB** (held
   blobs keep the 11.2 budgets: 256 MiB global, 64 MiB per tenant). Set them explicitly to keep the old limits.
3. **Feature-module and plugin SDK** (from 11.1, now final): `ctx.invoke(server, tool, args, principal, clientId?)`;
   plugin routes `ctx.invoke(server, tool, args, req | clientId)`. Every call is authorized by the gateway's central
   authorizer.
4. **Hot reload is transactional:** when applying a new config fails midway (catalog, plugins, mTLS, …) the previous
   config is restored and the reload call / `POST /admin/config` fails, instead of leaving a half-applied config.
   Servers already reconnected keep running.
5. `GET /api/v1/admin/kernel` reports `line: 12.x`. 10.x stays LTS (fixes until 2027-10-31, security until 2028-10-31).

## Also new

- `bench/kernel.mjs` — cold start, memory and evaluated feature modules of the built gateway; CI compares against
  `bench/baseline.json`. Load, memory-pressure and reload-rollback tests run in CI.
