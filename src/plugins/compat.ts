/**
 * 15.2.0-canary.1: the plugin compatibility matrix as data — which plugin API versions each gateway version loads,
 * and which plugin API v5 capabilities arrived in which gateway release. `docs/guides/plugin-compatibility.md`
 * embeds {@link compatibilityMarkdown} verbatim (a test fails when the guide and this table drift apart).
 *
 * Sources: CHANGELOG (plugin API v1 in 2.0.0 … v5 required in 8.0.0) and `PLUGIN_API_VERSION` /
 * `PLUGIN_API_MIN_VERSION` in plugins/index.ts. Rows marked `proposal` are the roadmap's plans for 16.0 / 17.0 and
 * may change before those releases.
 *
 * @module plugins/compat
 */

export interface PluginCompatRow {
  /** First gateway version of the row (inclusive). */
  from: string;
  /** First gateway version after the row (exclusive); open-ended when absent. */
  until?: string;
  /** Oldest plugin API version this gateway range loads. */
  min: number;
  /** Newest plugin API version this gateway range implements. */
  max: number;
  /** `shipped`: released behaviour; `proposal`: planned on the roadmap, not released. */
  status: 'shipped' | 'proposal';
  /** What changed for plugin authors in this range. */
  notes: string;
  /** Plugin capabilities available in this range, `(since x.y)`-tagged for the long-lived v5 range. */
  features?: string[];
}

/** Plugin API versions × gateway versions (oldest first). */
export const PLUGIN_COMPATIBILITY: readonly PluginCompatRow[] = [
  { from: '2.0.0', until: '3.0.0', min: 1, max: 1, status: 'shipped', notes: 'plugin API v1: hooks, fail closed (-32006)' },
  { from: '3.0.0', until: '4.0.0', min: 1, max: 2, status: 'shipped', notes: 'v2: hooks get a context argument; v1 loads with a warning' },
  { from: '4.0.0', until: '4.9.0', min: 2, max: 3, status: 'shipped', notes: 'v3: ctx.secrets, onConfigChange; v1 refused, v2 warns' },
  { from: '4.9.0', until: '5.0.0', min: 2, max: 4, status: 'shipped', notes: 'v4: ctx.state; v3 loads unchanged' },
  { from: '5.0.0', until: '6.0.0', min: 3, max: 4, status: 'shipped', notes: 'v2 refused' },
  { from: '6.0.0', until: '7.9.0', min: 4, max: 4, status: 'shipped', notes: 'v3 refused' },
  { from: '7.9.0', until: '8.0.0', min: 4, max: 5, status: 'shipped', notes: 'v5 preview: one contract for JS and WASM (WIT world mcp-gateway:plugin@5.0.0)' },
  {
    from: '8.0.0',
    until: '16.0.0',
    min: 5,
    max: 5,
    status: 'shipped',
    notes: 'v5 only (v4 refused); the current contract',
    features: [
      'signed artifacts (since 5.4)',
      'WASM components (7.9)',
      'configSchema / plugin routes (10.5)',
      'hybrid ML-DSA signatures, experimental (10.8)',
      'reload fails on an unloadable plugin (13.2)',
      'worker / process runtime (14.3)',
      'permissions, limits, circuit breaker (14.3)',
      'worker is the default runtime (15.0)',
      'plugin init / doctor (15.2)',
      'reproducible verify (15.2)',
      '/testing export (15.2)',
    ],
  },
  { from: '16.0.0', until: '17.0.0', min: 5, max: 5, status: 'proposal', notes: 'v5; runtime: inline needs plugins.allowInline: true (config schema v13)' },
  { from: '17.0.0', min: 6, max: 6, status: 'proposal', notes: 'plugin API v6: module plugins only in worker / process / wasm (inline removed); codemod in 16.9' },
];

const core = (v: string): [number, number, number] => {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(v.trim().replace(/^v/, ''));
  if (!m) throw new Error(`not a gateway version: ${v}`);
  return [Number(m[1]), Number(m[2]), Number(m[3])];
};
const cmp = (a: string, b: string): number => {
  const x = core(a);
  const y = core(b);
  return x[0] - y[0] || x[1] - y[1] || x[2] - y[2];
};

/** Whether a gateway version (prerelease suffix ignored: 15.2.0-canary.1 counts as 15.2.0) falls in a row. */
export function inRange(version: string, row: Pick<PluginCompatRow, 'from' | 'until'>): boolean {
  return cmp(version, row.from) >= 0 && (row.until === undefined || cmp(version, row.until) < 0);
}

/** The plugin API range a gateway version loads (`proposal: true` for planned versions), or undefined before 2.0. */
export function pluginApiSupport(gatewayVersion: string): { min: number; max: number; proposal?: true } | undefined {
  const row = PLUGIN_COMPATIBILITY.find((r) => inRange(gatewayVersion, r));
  if (!row) return undefined;
  return { min: row.min, max: row.max, ...(row.status === 'proposal' ? { proposal: true as const } : {}) };
}

/** Whether a plugin declaring `apiVersion` loads on a gateway version. */
export function isPluginApiSupported(apiVersion: number, gatewayVersion: string): boolean {
  const s = pluginApiSupport(gatewayVersion);
  return !!s && apiVersion >= s.min && apiVersion <= s.max;
}

/** The matrix as the markdown table embedded in docs/guides/plugin-compatibility.md. */
export function compatibilityMarkdown(): string {
  const range = (r: PluginCompatRow) => (r.until ? `${r.from} – <${r.until}` : `${r.from} +`);
  const api = (r: PluginCompatRow) => (r.min === r.max ? `v${r.max}` : `v${r.min} – v${r.max}`);
  const lines = [
    '| Gateway | Loads plugin API | Status | Notes |',
    '|---|---|---|---|',
    ...[...PLUGIN_COMPATIBILITY].reverse().map((r) => `| ${range(r)} | ${api(r)} | ${r.status} | ${r.notes} |`),
  ];
  const v5 = PLUGIN_COMPATIBILITY.find((r) => r.features);
  if (v5?.features) lines.push('', `Plugin API v5 capabilities by gateway release (${range(v5)}):`, '', ...v5.features.map((f) => `- ${f}`));
  return lines.join('\n');
}
