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

import { registerFeature, listFeatures, FEATURE_CONFIG_KEYS, isFeatureActive, moduleMode } from '../gateway/features.js';
import { callHooks } from '../gateway/hooks.js';
import { VERSION } from '../utils/version.js';

/** Config schema version read by this release line. */
export const CONFIG_SCHEMA_VERSION = 11;

/** Long-term support of the 10.x line (12.x is the current, non-LTS line; 10.x keeps its LTS dates). */
export const LTS = {
  line: '10.x',
  codename: 'Kernel',
  lts: true,
  /** Bug and security fixes. */
  activeUntil: '2027-10-31',
  /** Security fixes only. */
  maintenanceUntil: '2028-10-31',
} as const;

/** Current release line (12.0). */
export const RELEASE_LINE = { line: '12.x', lts: false } as const;

/** LTS status of the 10.x line on a date. */
export function ltsStatus(now = new Date()): 'active' | 'maintenance' | 'end-of-life' {
  const d = now.toISOString().slice(0, 10);
  if (d <= LTS.activeUntil) return 'active';
  if (d <= LTS.maintenanceUntil) return 'maintenance';
  return 'end-of-life';
}

registerFeature({
  id: 'kernel',
  since: '10.0.0',
  summary: 'Unified gateway kernel: config schema v11, lazily activated feature modules, call-hook pipeline and support status in one view',
  mount(router, ctx) {
    router.get('/', (_req, res) => {
      const cfg = ctx.config() as unknown as Record<string, unknown>;
      res.json({
        version: VERSION,
        schema: CONFIG_SCHEMA_VERSION,
        line: RELEASE_LINE,
        lts: { ...LTS, status: ltsStatus() },
        moduleMode: moduleMode(ctx.config()),
        modules: listFeatures().map((m) => ({ ...m, path: `/api/v1/admin/${m.id}`, active: isFeatureActive(ctx.config(), m.id) })),
        hooks: callHooks().map((h, i) => ({ order: i + 1, id: h.id, before: !!h.before, after: !!h.after })),
        features: FEATURE_CONFIG_KEYS.map((k) => ({ section: `features.${k}`, configured: cfg[k] !== undefined })),
      });
    });
  },
});
