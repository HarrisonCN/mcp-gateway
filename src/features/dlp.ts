/**
 * Data loss prevention (5.6): classify sensitive data in tool traffic and mask it per tenant.
 *
 * Every match of a built-in PII detector (e-mail, phone, card, SSN, IBAN, IPv4, PRC ID) or a custom detector gets a
 * sensitivity **level** — `public` < `internal` < `confidential` < `restricted`. Each tenant has a **clearance**;
 * data above it is handled with the tenant's **strategy**:
 *
 * - `redact` → `[REDACTED:email]`;
 * - `mask` → keeps the last 4 characters (`••••••1234`);
 * - `hash` → a stable pseudonym `tok_3f9a1c2b` (HMAC with the tenant's salt), so joins still work;
 * - `block` → the call fails with `-32013`.
 *
 * ```yaml
 * dlp:
 *   scope: results                 # arguments | results | both
 *   default: { clearance: internal, strategy: mask }
 *   tenants:
 *     finance: { clearance: restricted }
 *     trial:   { clearance: public, strategy: block }
 *   detectors:
 *     - { name: employee-id, pattern: "EMP-\\d{6}", level: confidential }
 *   levels: { ipv4: public }       # override built-in category levels
 * ```
 *
 * - `GET  /admin/dlp` — effective policy and counters (findings by category / level, actions by strategy).
 * - `POST /admin/dlp/classify` — `{ value, tenant? }` → findings and the value as that tenant would see it.
 *
 * @module features/dlp
 */

import { createHmac } from 'node:crypto';
import { z } from 'zod';
import { registerFeature, objectBody } from '../gateway/features.js';
import { registerCallHook } from '../gateway/hooks.js';
import { DETECTORS } from '../policy/compliance.js';
import { globToRegExp } from '../utils/tool-filter.js';
import type { GatewayConfig } from '../utils/types.js';
import { type DlpConfig, DlpSchema, ERR_DLP_BLOCKED, LEVELS, type Level, type Strategy, TenantPolicy, policyFor } from './schemas/dlp.js';
export { policyFor } from './schemas/dlp.js';
export { dlpStats } from '../policy/dlp-stats.js';
import { dlpStats, countDlpFindings as count } from '../policy/dlp-stats.js';
export { type DlpConfig, DlpSchema, ERR_DLP_BLOCKED, LEVELS, type Level, type Strategy } from './schemas/dlp.js';
type Resolved = z.output<typeof DlpSchema>;

/** Built-in category levels. */
export const DEFAULT_LEVELS: Record<string, Level> = { email: 'internal', phone: 'internal', ipv4: 'internal', iban: 'confidential', 'credit-card': 'restricted', ssn: 'restricted', 'cn-id': 'restricted' };

export interface DlpFinding {
  category: string;
  level: Level;
  path: string;
  action: Strategy | 'allow';
}
export interface DlpResult<T> {
  value: T;
  findings: DlpFinding[];
  blocked: boolean;
}

const rank = (l: Level) => LEVELS.indexOf(l);


export function maskValue(s: string, strategy: Exclude<Strategy, 'block'>, category: string, salt: string): string {
  if (strategy === 'redact') return `[REDACTED:${category}]`;
  if (strategy === 'hash') return `tok_${createHmac('sha256', salt).update(s).digest('hex').slice(0, 8)}`;
  const keep = s.length > 8 ? 4 : 0;
  return '•'.repeat(Math.max(4, s.length - keep)) + (keep ? s.slice(-keep) : '');
}

/** Classify and transform every string inside a JSON value for one tenant. */
export function applyDlp<T>(value: T, cfg: Resolved, tenant: string | undefined): DlpResult<T> {
  const pol = policyFor(cfg, tenant);
  const dets = [
    ...DETECTORS.map((d) => ({ name: d.category as string, re: d.re, valid: d.valid, level: (cfg.levels[d.category] ?? DEFAULT_LEVELS[d.category] ?? 'confidential') as Level })),
    ...cfg.detectors.map((d) => ({ name: d.name, re: new RegExp(d.pattern, 'g'), valid: undefined as ((m: string) => boolean) | undefined, level: (cfg.levels[d.name] ?? d.level) as Level })),
  ];
  const findings: DlpFinding[] = [];
  let blocked = false;
  const scan = (s: string, path: string): string => {
    let out = s;
    for (const d of dets) {
      d.re.lastIndex = 0;
      out = out.replace(d.re, (m) => {
        if (m.startsWith('[REDACTED:') || m.startsWith('tok_') || m.startsWith('••••')) return m;
        if (d.valid && !d.valid(m)) return m;
        const over = rank(d.level) > rank(pol.clearance);
        const action: DlpFinding['action'] = over ? pol.strategy : 'allow';
        findings.push({ category: d.name, level: d.level, path, action });
        if (!over) return m;
        if (pol.strategy === 'block') {
          blocked = true;
          return m;
        }
        return maskValue(m, pol.strategy, d.name, pol.salt);
      });
    }
    return out;
  };
  const walk = (v: unknown, path: string, depth: number): unknown => {
    if (depth > 64) return v;
    if (typeof v === 'string') return scan(v, path);
    if (Array.isArray(v)) return v.map((x, i) => walk(x, `${path}[${i}]`, depth + 1));
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, walk(x, path ? `${path}.${k}` : k, depth + 1)]));
    return v;
  };
  const out = walk(value, '', 0) as T;
  return { value: blocked ? value : out, findings, blocked };
}

/** Counters since start (process-wide). */

function active(cfg: GatewayConfig, serverId: string, dir: 'arguments' | 'results'): Resolved | undefined {
  if (!cfg.dlp) return undefined;
  const d = DlpSchema.parse(cfg.dlp);
  if (!d.enabled || (d.scope !== 'both' && d.scope !== dir)) return undefined;
  if (d.servers?.length && !d.servers.some((g) => globToRegExp(g).test(serverId))) return undefined;
  return d;
}

registerCallHook({
  id: 'dlp',
  before: (call, cfg) => {
    const d = active(cfg, call.serverId, 'arguments');
    if (!d) return;
    const r = applyDlp(call.args, d, call.tenant);
    if (!r.findings.length) return;
    count(r.findings);
    if (r.blocked) return { refuse: { code: ERR_DLP_BLOCKED, message: `DLP: sensitive data in the arguments (${[...new Set(r.findings.filter((f) => f.action === 'block').map((f) => f.category))].join(', ')})`, data: { levels: [...new Set(r.findings.map((f) => f.level))] } } };
    return { args: r.value };
  },
  after: (call, result, cfg) => {
    if (!result.success) return;
    const d = active(cfg, call.serverId, 'results');
    if (!d) return;
    const r = applyDlp(result.result, d, call.tenant);
    if (!r.findings.length) return;
    count(r.findings);
    if (r.blocked) {
      const cats = [...new Set(r.findings.filter((f) => f.action === 'block').map((f) => f.category))];
      return { success: false, durationMs: result.durationMs, error: { code: ERR_DLP_BLOCKED, message: `DLP: the result contains data above this caller's clearance (${cats.join(', ')})`, data: { decision: 'dlp', categories: cats } } };
    }
    return { ...result, result: r.value };
  },
});

registerFeature({
  id: 'dlp',
  since: '5.6.0',
  summary: 'Data loss prevention: sensitivity levels, per-tenant clearance and masking',
  mount: (router, ctx) => {
    const cfg = () => DlpSchema.parse(ctx.config().dlp ?? { enabled: false });
    router.get('/', (_req, res) => {
      const c = cfg();
      res.json({
        enabled: !!ctx.config().dlp && c.enabled,
        scope: c.scope,
        levels: { ...DEFAULT_LEVELS, ...Object.fromEntries(c.detectors.map((d) => [d.name, d.level])), ...c.levels },
        default: policyFor(c, undefined),
        tenants: Object.fromEntries(Object.keys(c.tenants).map((t) => { const { salt: _s, ...p } = policyFor(c, t); return [t, p]; })),
        stats: dlpStats,
      });
    });
    router.post('/classify', (req, res) => {
      const b = objectBody(req, res);
      if (!b) return;
      const r = applyDlp(b.value, cfg(), typeof b.tenant === 'string' ? b.tenant : undefined);
      const { salt: _s, ...pol } = policyFor(cfg(), typeof b.tenant === 'string' ? b.tenant : undefined);
      res.json({ policy: pol, blocked: r.blocked, findings: r.findings, value: r.value });
    });
  },
});
