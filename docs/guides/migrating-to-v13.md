# Migrating to 13.0

13.0 makes the kernel truly modular: a feature module is evaluated only when it is enabled. Config schema stays
**v11** — existing config files load unchanged, `migrate` is not needed. 10.x remains the LTS line.

## What changes for operators

| Before (12.x) | 13.0 |
|---|---|
| All 47 feature modules evaluated at start, routes mounted only when active | A module is evaluated (`import()`) only when its `features.<section>` is configured; `kernel`, `conformance`, `k8s`, `terraform`, `policy-sim` on their first request |
| A module that threw while loading stopped the gateway | It is isolated: its routes answer `503`, its call hooks are skipped, modules that depend on it fail too, everything else runs |
| `GET /api/v1/admin/kernel` `modules[].active` | plus `state` (`inactive` · `available` · `active` · `disabled` · `failed`), `evaluated`, `dependsOn`, `loadMs`, `error`, `health`, and top-level `evaluated` (load order) |

`kernel.modules: eager` restores the 10.x behaviour (every module evaluated at start). Removing a section on hot
reload disables the module (its routes answer 404, its hooks stop, `disable()` runs); ES modules cannot be unloaded
from memory, so a module evaluated once stays in memory until restart.

Hot reload: a module that fails to activate during a reload is marked failed (isolated) rather than rolling the whole
reload back; other reload failures still roll back as in 12.0.

## What changes for embedders (`import … from '@winstonsayno/mcp-gateway'`)

- **New lean entry `@winstonsayno/mcp-gateway/gateway`** — `Gateway`, `loadConfig` / `validateConfig`, the authorizer,
  the kernel API (`FEATURE_MANIFEST`, `loadFeature`, `registerFeature`, `registerCallHook`, …) and all config types.
  It evaluates no feature module. The package root keeps every export, but because it re-exports each module's
  helpers, importing the root evaluates all modules — prefer `/gateway` unless you need those helpers.
- **Call-hook order** is the manifest order (a hook registered with `{ first: true }` still runs first; hooks of unknown
  ids — plugins — run after the built-ins in registration order). `callHooks()` lists only hooks of evaluated
  modules.
- **`createFeatureRouter()`** returns a `FeatureRouter`: `await router.activate()` after creating it (the gateway does
  this in `start()`), `await router.reconcile(prevConfig)` after a reload, `await router.dispose()` on stop. `sync()` is
  now async. Routers built with an explicit `features: [...]` list work as before (modules are activated on their
  first request if you do not call `activate()`).
- **`listFeatures()`** lists every built-in module from the manifest, evaluated or not, then runtime registrations.
- `dlpStats` moved to `policy/dlp-stats` and `policyFor` to the DLP schema; both are still exported from the DLP
  module and the root.

## Writing modules: the lifecycle contract

All members are optional; existing modules (`mount` / `mountClient` only) keep working.

```ts
registerFeature({
  id: 'my-module', since: '1.0.0', summary: '…',
  init: async (ctx) => { /* once, when it becomes active, before routes are mounted */ },
  reconfigure: async (next, prev, ctx) => { /* every reload while it stays active */ },
  disable: async (ctx) => { /* its section was removed (lazy mode) */ },
  dispose: async () => { /* gateway stop; reverse dependency order */ },
  health: () => ({ status: 'ok' }),
  mount: (router, ctx) => { /* /api/v1/admin/my-module */ },
});
```

A throw from `init`, `reconfigure` or `disable` marks the module failed. Built-in modules declare their dependencies in
`src/features/manifest.ts` (`dependsOn`) and obtain them with `await requireDependency(from, dep)` instead of importing
another module; the kernel evaluates and initialises dependencies first and rejects undeclared use and cycles.

## Benchmark

`node bench/kernel.mjs --compare bench/baseline.json` (built `dist/`). Minimal profile on the same machine, median of
three interleaved runs × 5: import 918 → 658 ms, RSS 60.2 → 53.8 MiB, heap 23.3 → 19.5 MiB, feature modules
evaluated 47 → 0, start 16.7 → 21.9 ms (activation is now asynchronous). CI fails if a profile evaluates more modules
than recorded.
