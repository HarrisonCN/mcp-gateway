/**
 * Unified gateway kernel (10.0): one place that describes how this gateway is assembled — the config schema it reads,
 * every feature module and the call-hook pipeline in execution order, which feature sections are configured, and the
 * long-term-support status of the release line.
 *
 * Schema v10 puts every feature module's section under `features: { … }`; the kernel validates them with the
 * module's schema, hands each module its section, mounts its admin routes under `/api/v1/admin/<id>` (client routes
 * under `/api/v1/features/<id>`) and runs its call hooks in a single pipeline.
 *
 * - `GET /admin/kernel` — `{ version, schema, lts, modules, hooks, features }`.
 *
 * @module features/kernel
 */

import { registerFeature, listFeatures, FEATURE_CONFIG_KEYS } from '../gateway/features.js';
import { callHooks } from '../gateway/hooks.js';
import { VERSION } from '../utils/version.js';

/** Config schema version read by this release line. */
export const CONFIG_SCHEMA_VERSION = 10;

/** Long-term support of the 10.x line. */
export const LTS = {
  line: '10.x',
  codename: 'Kernel',
  lts: true,
  /** Bug and security fixes. */
  activeUntil: '2027-10-31',
  /** Security fixes only. */
  maintenanceUntil: '2028-10-31',
} as const;

/** LTS status of a release line on a date. */
export function ltsStatus(now = new Date()): 'active' | 'maintenance' | 'end-of-life' {
  const d = now.toISOString().slice(0, 10);
  if (d <= LTS.activeUntil) return 'active';
  if (d <= LTS.maintenanceUntil) return 'maintenance';
  return 'end-of-life';
}

registerFeature({
  id: 'kernel',
  since: '10.0.0',
  summary: 'Unified gateway kernel: config schema v10, feature modules, call-hook pipeline and LTS status in one view',
  mount(router, ctx) {
    router.get('/', (_req, res) => {
      const cfg = ctx.config() as unknown as Record<string, unknown>;
      res.json({
        version: VERSION,
        schema: CONFIG_SCHEMA_VERSION,
        lts: { ...LTS, status: ltsStatus() },
        modules: listFeatures().map((m) => ({ ...m, path: `/api/v1/admin/${m.id}` })),
        hooks: callHooks().map((h, i) => ({ order: i + 1, id: h.id, before: !!h.before, after: !!h.after })),
        features: FEATURE_CONFIG_KEYS.map((k) => ({ section: `features.${k}`, configured: cfg[k] !== undefined })),
      });
    });
  },
});
