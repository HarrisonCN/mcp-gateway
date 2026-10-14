# Plugin compatibility matrix

Which plugin API versions each gateway version loads, and which plugin API v5 capabilities arrived in which gateway
release (15.2.0-canary.1). The same table is available as data from `@winstonsayno/mcp-gateway/testing`
(`PLUGIN_COMPATIBILITY`, `pluginApiSupport(gatewayVersion)`, `isPluginApiSupported(apiVersion, gatewayVersion)`), so a
plugin's own CI can assert which gateways it supports. A repository test keeps this page and the data identical.

A plugin declares the contract it was written for with `apiVersion`. A gateway refuses a plugin that declares a newer
version than it implements and one that declares a removed version (the error names the migration guide).
Prerelease versions count as their release: `15.2.0-canary.1` is in the `8.0.0 – <16.0.0` row.

| Gateway | Loads plugin API | Status | Notes |
|---|---|---|---|
| 17.0.0 + | v6 | proposal | plugin API v6: module plugins only in worker / process / wasm (inline removed); codemod in 16.9 |
| 16.0.0 – <17.0.0 | v5 | proposal | v5; a module plugin with runtime: inline needs allowInline: true on its entry (config schema v13) |
| 8.0.0 – <16.0.0 | v5 | shipped | v5 only (v4 refused); the current contract |
| 7.9.0 – <8.0.0 | v4 – v5 | shipped | v5 preview: one contract for JS and WASM (WIT world mcp-gateway:plugin@5.0.0) |
| 6.0.0 – <7.9.0 | v4 | shipped | v3 refused |
| 5.0.0 – <6.0.0 | v3 – v4 | shipped | v2 refused |
| 4.9.0 – <5.0.0 | v2 – v4 | shipped | v4: ctx.state; v3 loads unchanged |
| 4.0.0 – <4.9.0 | v2 – v3 | shipped | v3: ctx.secrets, onConfigChange; v1 refused, v2 warns |
| 3.0.0 – <4.0.0 | v1 – v2 | shipped | v2: hooks get a context argument; v1 loads with a warning |
| 2.0.0 – <3.0.0 | v1 | shipped | plugin API v1: hooks, fail closed (-32006) |

Plugin API v5 capabilities by gateway release (8.0.0 – <16.0.0):

- signed artifacts (since 5.4)
- WASM components (7.9)
- configSchema / plugin routes (10.5)
- hybrid ML-DSA signatures, experimental (10.8)
- reload fails on an unloadable plugin (13.2)
- worker / process runtime (14.3)
- permissions, limits, circuit breaker (14.3)
- worker is the default runtime (15.0)
- plugin init / doctor (15.2)
- reproducible verify (15.2)
- /testing export (15.2)

Rows marked **proposal** are roadmap plans for the 16.0 and 17.0 majors (plugin API v6 in 17.0: module plugins run
only in `worker` / `process` / WASM, `inline` removed). They can change until the 15.9 / 16.9 preparation releases,
which add the deprecation warnings, a codemod and the migration guide one minor ahead of each major.

## Checking a plugin against the matrix

```js
import { isPluginApiSupported } from '@winstonsayno/mcp-gateway/testing';
import assert from 'node:assert/strict';
assert.ok(isPluginApiSupported(5, '14.9.2'));
assert.ok(!isPluginApiSupported(4, '14.9.2')); // v4 was removed in 8.0
```

See also: [Plugin SDK](plugin-sdk.md) (`plugin init`, `plugin doctor`, the testing harness),
[plugin security](plugin-security.md) (runtimes, permissions, signatures) and the example third-party plugin in
`examples/plugins/tool-quota/`.
