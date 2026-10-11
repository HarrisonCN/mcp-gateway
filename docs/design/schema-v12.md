# Config schema v12 — design (13.9.0 draft, runtime schema since 14.0.0)

> **Status: implemented in 14.0.0.** Schema v12 is the runtime schema of MCP Gateway 14.x ("core architecture v2").
> 14.x still reads v11 files — migrated in memory, with one deprecation warning per v11 field and a startup notice —
> until 15.0.0. Upgrade guide: [docs/migration/v13-to-v14.md](../migration/v13-to-v14.md). 13.9.0 shipped this design
> as a draft (13.x refuses `version: 12`).

Machine-readable schemas (14.0 runtime schema; the 13.9 path `schema/v12-draft/` is kept as an identical, deprecated alias copy until 15.0.0):

- [`schema/v12/config.schema.json`](../../schema/v12/config.schema.json): config file (JSON Schema draft-07);
- [`schema/v12/module.schema.json`](../../schema/v12/module.schema.json): feature module declaration.

Both are generated from the code (`npx tsx scripts/gen-schema-v12.ts`; `--check` reports drift) and are covered by
`test/v14-prep-13-9-0.test.ts`.

## Goals

1. **One module lifecycle.** Every feature module goes through the same states and calls, driven by the kernel:
   `init` → (`reconfigure`)* → `disable` → `dispose`, with `health` at any time. 13.x modules mostly use `mount()` plus
   `onStop` cleanups (13.4.0 finding F3); 14.0 moves them to the lifecycle methods through adapters, one module at a
   time.
2. **Capability declarations.** A module declares what it uses (`capabilities`), the kernel enforces operator
   denials (`modules.capabilities.<id>.deny`) at activation.
3. **Init / unload interfaces with bounds.** `modules.lifecycle.initTimeoutMs`, `unloadTimeoutMs`, `drainMs`.
4. **Consistent naming.** Every feature section is the camelCase of its module id; module settings live in `modules`.
5. **No security regressions.** Guards stay `closed` and not configurable; the failure policy model (13.1) is unchanged.

## What changes from v11

| v11 | v12 | Why |
|---|---|---|
| `version: 11` | `version: 12` | new schema |
| `kernel.modules` | `modules.activation` | module lifecycle settings move to the `modules` block |
| `kernel.failurePolicy` | `modules.failurePolicy` | same |
| `features.genaiTelemetry` | `features.genaiOtel` | sections are named after their module id (`genai-otel`) |
| `features.policyShadow` | `features.policySim` | module `policy-sim` |
| `features.postQuantumTls` | `features.pqTls` | module `pq-tls` |
| — | `modules.lifecycle` | NEW: bounds for init / unload / drain |
| — | `modules.capabilities` | NEW: per-module capability denials |

Everything else (servers, auth, store, every feature section's body) is unchanged. The full list of deprecated v11
fields, with the version that removes them, is [docs/deprecations.md](../deprecations.md).

A v12 file:

<!-- docs-check: skip -->
```yaml
version: 12
modules:
  activation: lazy            # v11 kernel.modules
  failurePolicy:
    billing: closed           # v11 kernel.failurePolicy
  lifecycle:
    initTimeoutMs: 10000
    unloadTimeoutMs: 5000
  capabilities:
    config-assistant:
      deny: [outbound-network]
features:
  genaiOtel:                  # v11 features.genaiTelemetry
    otlpEndpoint: http://otel-collector:4318
```

## Module lifecycle (14.0 kernel)

| Call | When | Contract (tested in 13.x by `test/contract-13-4-0.test.ts` and `test/v14-prep-13-9-0.test.ts`) |
|---|---|---|
| `init(ctx)` | the module becomes active (its section appears, or at start) | before its routes are mounted; a throw marks it failed and its failure policy applies |
| `reconfigure(next, prev, ctx)` | a reload while it stays active | applies the new section without a restart (13.9.0 fixed genai-otel `exportIntervalMs`, finding F4); undone by `reconfigure(prev, next)` in a failed transaction |
| `disable(ctx)` | its section is removed | timers stopped, routes taken down, its hook leaves the call plan; final work uses the last applied config, not the live one (13.9.0 fixed the pq-identity final checkpoint, finding F5) |
| `dispose()` | gateway stop | reverse dependency order, idempotent |
| `health()` | `GET /api/v1/admin/kernel` | `ok` / `degraded` / `failed` |

Instance isolation (finding F3): stopping or reloading one `Gateway` instance never deactivates a module in another
instance in the same process (13.9.0 contract test, all 46 modules). Module-level singleton state shared between
instances is still present in 13.x and is removed by the 14.0 lifecycle (per-instance state passed through `ctx`).

## Module declaration and capabilities

Each module declares (`module.schema.json`): `id`, `since`, `summary`, `apiVersion: v12` (`v12-draft` accepted as an alias until 15.0.0),
`configSections`, `dependsOn`, `hook`, `lifecycle` (which of `mount`, `init`, `reconfigure`, `disable`, `dispose`,
`health` it implements), `capabilities` and `failurePolicy` (`default`, `configurable`). Rules: a module with a call
hook declares `call-hook` and a failure policy; a `security-guard` module's policy is `closed` and not configurable.

Capability vocabulary: `admin-routes`, `client-routes`, `call-hook`, `security-guard`, `background-timers`,
`state-store`, `outbound-network`, `filesystem`, `signing-keys`, `invoke-tools`.

In 13.9 the declaration of each of the 46 built-in modules is **derived** from the manifest and its registration
(`moduleDeclarationV12`): only the capabilities those prove (`admin-routes`, `client-routes`, `call-hook`,
`security-guard`). Runtime capabilities (`background-timers`, `outbound-network`, `filesystem`, …) are declared by the
modules themselves when they move to the 14.0 lifecycle — the kernel cannot enforce a denial before that.

## Migration path

1. 13.9: run your v11 file as before; read the deprecation warnings (or list them with `mcp-gateway validate` /
   `GET /api/v1/admin/deprecations`); preview the migration:

   ```bash
   mcp-gateway config migrate --to v12 --dry-run -c mcp-gateway.yml
   mcp-gateway config diff --to v12 -c mcp-gateway.yml
   ```

   The preview prints the v12 config, a unified diff and a compatibility report (errors, warnings, manual steps);
   `--json` for tooling. Keep running the v11 file.
2. 14.0 (decided): reads v12 **and still accepts v11 files**, migrated in memory with one deprecation warning per
   field and one startup notice (adapters and incremental migration, as the roadmap asks). v11 support is removed in
   15.0.0. The migration tool writes files: `mcp-gateway config migrate --to v12` (`<name>.v12.<ext>` or `-o`),
   `--in-place` (backup `<file>.v11.bak`), `mcp-gateway config rollback`.

## 14.0 implementation notes

- **Adapter, not rewrite.** Internally the gateway keeps the v11 names (`kernel.*`, `genaiTelemetry`, `policyShadow`,
  `postQuantumTls`): `normalizeSchemaVersion` (src/config/v12-deprecations.ts) maps a v12 file onto them, so the 46
  modules, authentication and the proxy layer are unchanged. The admin API writes the running config back in v12 form.
- **Lifecycle v2 / v11-compat.** Modules with `apiVersion: 2` implement the lifecycle natively (genai-otel in 14.0);
  all others run through the v11-compat adapter (`mount` + `onStop`, cleanups owned by the module since 13.4.0).
  `modules.lifecycle.initTimeoutMs` / `unloadTimeoutMs` bound `init` and `disable` / `dispose` for both.
- **Capabilities.** Declared per module in the manifest (runtime capabilities) plus `call-hook` / `security-guard`.
  A denied declared capability refuses activation (all modules). For lifecycle-v2 modules, `ctx.timers` and
  `ctx.net.fetch` refuse undeclared or denied use at run time and the kernel clears their timers on disable / stop.
  `filesystem`, `signing-keys`, `state-store`, `invoke-tools` are not intercepted at run time in 14.0.
- **Per-instance state (F3).** Each `Gateway` has an `InstanceScope` (src/kernel/instance.ts) carried by
  `AsyncLocalStorage` through its requests, start / reload / stop and the timers they start. Module singletons are
  `instanceLocal(...)` proxies; the kernel drops a module's state on disable / dispose. Pure memos (parsed Cedar
  policies, embedding memo) stay process-wide and say so.
