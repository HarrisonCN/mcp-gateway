/**
 * Compliance suite (3.7): PII detection and redaction, data residency, SOC 2 / GDPR reports.
 *
 * - **PII (3.7–5.9; 6.0: use `dlp`):** the detectors below (`scanPii`) scan tool arguments (before they leave for the upstream) and/or results (before they
 *   reach the client) for e-mail addresses, phone numbers, payment cards (Luhn-checked), US SSNs, IBANs (mod-97),
 *   IPv4 addresses and PRC resident ID numbers (checksum). `action: redact` (default) masks matches
 *   (`[REDACTED:email]`), `block` refuses the call (`-32012`), `tag` only counts them.
 * - **Residency:** servers declare a `region`; `compliance.residency` rules pin tenants (or everybody) to region
 *   globs. A call that would send a tenant's data to a server — or a federation peer — outside its regions is
 *   refused (`-32011`).
 * - **Reports:** `GET /api/v1/compliance/report?framework=soc2|gdpr` summarises controls and evidence from the
 *   live configuration, metrics and request history (JSON or Markdown).
 *
 * @module policy/compliance
 */

import type { ComplianceConfig, PiiCategory } from '../utils/types.js';
import { globToRegExp } from '../utils/tool-filter.js';

export const ERR_RESIDENCY = -32011;
export const ERR_PII_BLOCKED = -32012;

export const PII_CATEGORIES: PiiCategory[] = ['email', 'phone', 'credit-card', 'ssn', 'iban', 'ipv4', 'cn-id'];

function luhn(digits: string): boolean {
  let sum = 0;
  let dbl = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (dbl) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    dbl = !dbl;
  }
  return sum % 10 === 0;
}

function ibanValid(raw: string): boolean {
  const s = raw.replace(/\s+/g, '').toUpperCase();
  if (s.length < 15 || s.length > 34) return false;
  const re = s.slice(4) + s.slice(0, 4);
  let rem = 0;
  for (const ch of re) {
    const v = ch >= 'A' && ch <= 'Z' ? String(ch.charCodeAt(0) - 55) : ch;
    for (const c of v) rem = (rem * 10 + (c.charCodeAt(0) - 48)) % 97;
  }
  return rem === 1;
}

function cnIdValid(id: string): boolean {
  const w = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2];
  const codes = '10X98765432';
  let sum = 0;
  for (let i = 0; i < 17; i++) sum += (id.charCodeAt(i) - 48) * w[i]!;
  return codes[sum % 11] === id[17]!.toUpperCase();
}

export interface Detector {
  category: PiiCategory;
  re: RegExp;
  valid?: (m: string) => boolean;
}

/** Built-in PII detectors (exported 5.6 for DLP). */
export const DETECTORS: Detector[] = [
  { category: 'email', re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g },
  { category: 'iban', re: /\b[A-Z]{2}\d{2}(?: ?[A-Z0-9]{4}){2,7}(?: ?[A-Z0-9]{1,4})?\b/g, valid: ibanValid },
  { category: 'credit-card', re: /\b(?:\d[ -]?){12,18}\d\b/g, valid: (m) => luhn(m.replace(/[ -]/g, '')) && m.replace(/[ -]/g, '').length >= 13 },
  { category: 'cn-id', re: /\b\d{6}(?:19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\d{3}[\dXx]\b/g, valid: cnIdValid },
  { category: 'ssn', re: /\b(?!000|666|9\d\d)\d{3}-(?!00)\d{2}-(?!0000)\d{4}\b/g },
  { category: 'phone', re: /(?<![\w+])\+\d{1,3}[ .-]?\(?\d{1,4}\)?(?:[ .-]?\d{2,4}){2,4}(?!\w)|\(\d{3}\)[ .-]?\d{3}[ .-]\d{4}\b|\b\d{3}[.-]\d{3}[.-]\d{4}\b|\b1[3-9]\d{9}\b/g },
  { category: 'ipv4', re: /\b(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)\b/g },
];

export interface PiiFinding {
  category: PiiCategory;
  /** JSON path of the string the match was found in. */
  path: string;
}

export interface PiiScanResult<T> {
  value: T;
  findings: PiiFinding[];
}

/** Scan (and optionally mask) every string inside a JSON value. */
export function scanPii<T>(value: T, opts: { categories?: PiiCategory[]; redact?: boolean } = {}): PiiScanResult<T> {
  const cats = new Set(opts.categories ?? PII_CATEGORIES);
  const dets = DETECTORS.filter((d) => cats.has(d.category));
  const findings: PiiFinding[] = [];
  const scanString = (s: string, path: string): string => {
    let out = s;
    for (const d of dets) {
      out = out.replace(d.re, (m) => {
        if (m.startsWith('[REDACTED:')) return m;
        if (d.valid && !d.valid(m)) return m;
        findings.push({ category: d.category, path });
        return opts.redact ? `[REDACTED:${d.category}]` : m;
      });
    }
    return out;
  };
  const walk = (v: unknown, path: string, depth: number): unknown => {
    if (depth > 64) return v;
    if (typeof v === 'string') return scanString(v, path);
    if (Array.isArray(v)) return v.map((x, i) => walk(x, `${path}[${i}]`, depth + 1));
    if (v && typeof v === 'object') {
      const o: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(v as Record<string, unknown>)) o[k] = walk(x, path ? `${path}.${k}` : k, depth + 1);
      return o;
    }
    return v;
  };
  const out = walk(value, '', 0) as T;
  return { value: opts.redact ? out : value, findings };
}

export type PiiDirection = 'arguments' | 'results';

/** Applies `compliance.residency` and keeps counters for the reports (6.0: PII handling moved to `dlp`). */
export class ComplianceEngine {
  readonly piiCounts = new Map<string, number>();
  readonly blocked = { pii: 0, residency: 0 };

  constructor(private readonly config: () => ComplianceConfig | undefined) {}

  /** Allowed region globs for a tenant (undefined = unrestricted). */
  regionsFor(tenant: string | undefined): string[] | undefined {
    const rules = this.config()?.residency?.rules ?? [];
    const rule = rules.find((r) => (r.tenants ?? ['*']).some((g) => globToRegExp(g).test(tenant ?? '-')));
    return rule?.regions;
  }

  /** Whether a tenant may send data to a server / peer in `region`. Unknown region counts as a violation when pinned. */
  residencyAllows(tenant: string | undefined, region: string | undefined): boolean {
    const allowed = this.regionsFor(tenant);
    if (!allowed) return true;
    if (!region) return this.config()?.residency?.allowUnknown === true;
    return allowed.some((g) => globToRegExp(g).test(region));
  }

  noteResidencyBlock(): void {
    this.blocked.residency++;
  }

  findings(): Record<string, number> {
    return Object.fromEntries([...this.piiCounts.entries()].sort());
  }
}

// ─── Reports ───────────────────────────────────────────────────────────────────

export interface ReportInput {
  framework: 'soc2' | 'gdpr';
  generatedAt: string;
  gatewayVersion: string;
  period: { since: string; until: string };
  config: {
    authStrategy: string;
    tenants: number;
    auditEnabled: boolean;
    auditRetentionDays?: number;
    tlsUpstreams: number;
    plainUpstreams: number;
    policyRules: number;
    approvals: boolean;
    outputFilter: boolean;
    pii?: { action: string; scope: string; categories: string[] };
    residencyRules: number;
    secretsProviders: number;
    rotationSeconds?: number;
    rateLimit: boolean;
    authLockout: boolean;
    redactPatterns: number;
  };
  activity: {
    calls: number;
    errors: number;
    denied: number;
    clients: Array<{ client: string; calls: number }>;
    piiFindings: Record<string, number>;
    blocked: { pii: number; residency: number };
  };
  warnings: Array<{ id: string; severity: string; message: string }>;
}

export interface ControlResult {
  id: string;
  title: string;
  status: 'pass' | 'warn' | 'fail';
  evidence: string;
}

/** Map configuration and activity to framework controls. */
export function evaluateControls(r: ReportInput): ControlResult[] {
  const c = r.config;
  const ctl = (id: string, title: string, ok: boolean | 'warn', evidence: string): ControlResult => ({ id, title, status: ok === 'warn' ? 'warn' : ok ? 'pass' : 'fail', evidence });
  if (r.framework === 'soc2') {
    return [
      ctl('CC6.1', 'Logical access is authenticated', c.authStrategy !== 'none', `auth.strategy = ${c.authStrategy}`),
      ctl('CC6.1-b', 'Access is scoped per tenant / role', c.tenants > 0 ? true : 'warn', `${c.tenants} tenant(s) configured`),
      ctl('CC6.6', 'Brute-force and abuse protection', c.authLockout && c.rateLimit ? true : 'warn', `rate limit: ${c.rateLimit ? 'on' : 'off'}, lockout: ${c.authLockout ? 'on' : 'off'}`),
      ctl('CC6.7', 'Data in transit to upstreams is encrypted', c.plainUpstreams === 0 ? true : 'warn', `${c.tlsUpstreams} TLS / ${c.plainUpstreams} plain-HTTP upstream(s)`),
      ctl('CC6.8', 'Tool calls are governed by policy', c.policyRules > 0 || c.approvals ? true : 'warn', `${c.policyRules} policy rule(s), approvals ${c.approvals ? 'on' : 'off'}`),
      ctl('CC7.2', 'Activity is logged and retained', c.auditEnabled, c.auditEnabled ? `audit log on${c.auditRetentionDays ? `, ${c.auditRetentionDays} day retention` : ''}` : 'audit log off'),
      ctl('CC7.3', 'Security events are detected', c.outputFilter || !!c.pii ? true : 'warn', `output filter ${c.outputFilter ? 'on' : 'off'}, PII scanning ${c.pii ? c.pii.action : 'off'}`),
      ctl('CC8.1', 'Credentials are managed and rotated', c.secretsProviders > 0 ? (c.rotationSeconds ? true : 'warn') : 'warn', `${c.secretsProviders} secret provider(s), rotation ${c.rotationSeconds ? `every ${c.rotationSeconds}s` : 'off'}`),
      ctl('C1.1', 'Confidential data is redacted from logs', c.redactPatterns >= 0, `built-in secret patterns + ${c.redactPatterns} custom`),
    ];
  }
  return [
    ctl('Art.5(1)(c)', 'Data minimisation: personal data is redacted', c.pii ? (c.pii.action === 'tag' ? 'warn' : true) : 'warn', c.pii ? `PII ${c.pii.action} on ${c.pii.scope} (${c.pii.categories.join(', ')})` : 'PII scanning off'),
    ctl('Art.5(1)(e)', 'Storage limitation: logs have a retention period', c.auditEnabled ? (c.auditRetentionDays ? true : 'warn') : true, c.auditEnabled ? `audit retention ${c.auditRetentionDays ?? 'unlimited'} days` : 'no persistent audit log'),
    ctl('Art.25', 'Data protection by design (default deny / scoping)', c.authStrategy !== 'none', `auth.strategy = ${c.authStrategy}, ${c.tenants} tenant(s)`),
    ctl('Art.30', 'Records of processing activities', c.auditEnabled ? true : 'warn', c.auditEnabled ? 'audit log on' : 'audit log off'),
    ctl('Art.32', 'Security of processing (encryption, access control)', c.plainUpstreams === 0 && c.authStrategy !== 'none' ? true : 'warn', `${c.plainUpstreams} plain-HTTP upstream(s)`),
    ctl('Art.44', 'International transfers are restricted (data residency)', c.residencyRules > 0 ? true : 'warn', `${c.residencyRules} residency rule(s); ${r.activity.blocked.residency} transfer(s) blocked`),
  ];
}

export function buildReport(r: ReportInput): Record<string, unknown> {
  const controls = evaluateControls(r);
  const summary = { pass: controls.filter((c) => c.status === 'pass').length, warn: controls.filter((c) => c.status === 'warn').length, fail: controls.filter((c) => c.status === 'fail').length };
  return { framework: r.framework, generatedAt: r.generatedAt, gatewayVersion: r.gatewayVersion, period: r.period, summary, controls, activity: r.activity, warnings: r.warnings };
}

export function reportMarkdown(rep: Record<string, unknown>): string {
  const r = rep as { framework: string; generatedAt: string; gatewayVersion: string; period: { since: string; until: string }; summary: { pass: number; warn: number; fail: number }; controls: ControlResult[]; activity: ReportInput['activity']; warnings: ReportInput['warnings'] };
  const icon = { pass: '✅', warn: '⚠️', fail: '❌' } as const;
  const lines = [
    `# ${r.framework === 'soc2' ? 'SOC 2' : 'GDPR'} compliance report`,
    '',
    `Generated ${r.generatedAt} by mcp-gateway ${r.gatewayVersion} · period ${r.period.since} → ${r.period.until}`,
    '',
    `**${r.summary.pass} pass · ${r.summary.warn} warn · ${r.summary.fail} fail**`,
    '',
    '| Control | Status | Evidence |',
    '|---|---|---|',
    ...r.controls.map((c) => `| ${c.id} — ${c.title} | ${icon[c.status]} ${c.status} | ${c.evidence.replace(/\|/g, '\\|')} |`),
    '',
    '## Activity',
    '',
    `- Calls: ${r.activity.calls} (errors ${r.activity.errors}, refused ${r.activity.denied})`,
    `- Blocked: ${r.activity.blocked.pii} for PII, ${r.activity.blocked.residency} for data residency`,
    `- PII findings: ${Object.entries(r.activity.piiFindings).map(([k, v]) => `${k} ${v}`).join(', ') || 'none'}`,
    `- Top clients: ${r.activity.clients.slice(0, 10).map((c) => `${c.client} (${c.calls})`).join(', ') || 'none'}`,
  ];
  if (r.warnings.length) lines.push('', '## Security warnings', '', ...r.warnings.map((w) => `- **${w.severity}** ${w.id}: ${w.message}`));
  return lines.join('\n') + '\n';
}
