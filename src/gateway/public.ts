/**
 * `@winstonsayno/mcp-gateway/gateway` (13.0): the lean entry point — the gateway, config loading and validation, the
 * single authorizer, the kernel (manifest, module loader, feature registry, call hooks) and the shared types.
 *
 * Unlike the package root, which re-exports every feature module's helpers (and therefore evaluates all of them),
 * importing this entry evaluates no feature module: the gateway loads a module through the manifest's `import()`
 * only when its config section is present (or `kernel.modules: eager`). Use it for embedding and for the fastest cold
 * start; import a feature's helpers from the root when you need them.
 *
 * @module gateway/public
 */
export { Gateway } from './index.js';
export type { GatewayOptions } from './index.js';
export { loadConfig, validateConfig, generateDefaultConfig, resolveConfigPath } from '../config/loader.js';
export { authorize, clientPrincipal, systemPrincipal, deniedPrincipal, grantCovers, principalChain, ERR_FORBIDDEN as ERR_AUTHZ_FORBIDDEN, type Principal, type Delegation, type AuthzCall, type AuthzDenial } from '../auth/authorizer.js';
export { registerFeature, listFeatures, createFeatureRouter, isFeatureActive, moduleMode, FEATURE_ACTIVATION, FEATURE_CONFIG_KEYS } from './features.js';
export type { FeatureModule, FeatureContext, FeatureRouter, KernelModuleView, ModuleHealth } from './features.js';
export { registerCallHook, callHooks } from './hooks.js';
export type { CallHook, HookCall } from './hooks.js';
export { FEATURE_MANIFEST, manifestEntry } from '../features/manifest.js';
export type { FeatureManifestEntry } from '../features/manifest.js';
export { loadFeature, loadedFeatures, dependencyOrder, requireDependency } from './kernel-runtime.js';
export { logger } from '../utils/logger.js';
export { VERSION } from '../utils/version.js';
export type * from '../utils/types.js';
