/**
 * Automated compliance reports (7.8): scheduled, tamper-evident evidence bundles for SOC 2, ISO/IEC 27001 and GDPR.
 *
 * Each run writes a **bundle** directory `<outputDir>/<schedule>-<timestamp>/` with, per framework, a Markdown report
 * and its JSON, the running config with secrets redacted, and a `manifest.json` listing every file with its SHA-256
 * (and a digest of the manifest itself) so auditors can verify nothing was edited. Old bundles beyond `keep` are pruned.
 *
 * ```yaml
 * complianceReports:
 *   outputDir: ./compliance
 *   keep: 12
 *   schedules:
 *     - { id: monthly, frameworks: [soc2, iso27001, gdpr], every: monthly, periodDays: 30 }
 * ```
 *
 * Controls are evaluated from the running config and recent activity, including the 6.x / 7.x controls (DLP,
 * anomaly detection, output sanitisation, approval flows, gradual rollouts, control-plane split).
 *
 * - `GET  /admin/compliance-reports` — schedules (last / next run) and bundles.
 * - `POST /admin/compliance-reports/run` — `{ schedule? , frameworks?, periodDays? }` → manifest (runs now).
 * - `GET  /admin/compliance-reports/bundles/:bundle/:file` — download a file of a bundle.
 * - `GET  /admin/compliance-reports/preview?framework=iso27001&format=md|json` — evaluate without writing.
 *
 * @module features/compliance-reports
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { z } from 'zod';
import { registerFeature, objectBody, badRequest, type FeatureContext } from '../gateway/features.js';
import { portableConfig, withFeatureSection } from '../gateway/admin.js';
import { redactConfig } from '../config/diff.js';
import { buildReport, reportMarkdown, type ControlResult, type ReportInput } from '../policy/compliance.js';
import { securityWarnings } from '../security/posture.js';
import { dlpStats } from '../policy/dlp-stats.js';
import { VERSION } from '../utils/version.js';
import { logger } from '../utils/logger.js';
import type { GatewayConfig, RequestMetric } from '../utils/types.js';
import { ComplianceReportsConfig, ComplianceReportsSchema, EVERY_MS, Framework } from './schemas/compliance-reports.js';
export { ComplianceReportsConfig, ComplianceReportsSchema, Framework } from './schemas/compliance-reports.js';
type Cfg = z.output<typeof ComplianceReportsSchema>;

const settings = (cfg: GatewayConfig): Cfg | undefined => {
  if (!cfg.complianceReports) return undefined;
  const c = ComplianceReportsSchema.parse(cfg.complianceReports);
  return c.enabled ? c : undefined;
};

/** Report input (config + activity) for the 3.7 SOC 2 / GDPR controls. */
export function reportInput(framework: 'soc2' | 'gdpr', cfg: GatewayConfig, metrics: RequestMetric[], since: number, until: number): ReportInput {
  const inPeriod = metrics.filter((m) => {
    const t = Date.parse(String(m.timestamp));
    return t >= since && t <= until;
  });
  const clients = new Map<string, number>();
  for (const m of inPeriod) clients.set(m.clientId ?? 'anonymous', (clients.get(m.clientId ?? 'anonymous') ?? 0) + 1);
  const remote = cfg.servers.filter((s) => s.url);
  const dlp = cfg.dlp as { enabled?: boolean; scope?: string } | undefined;
  return {
    framework,
    generatedAt: new Date(until).toISOString(),
    gatewayVersion: VERSION,
    period: { since: new Date(since).toISOString(), until: new Date(until).toISOString() },
    config: {
      authStrategy: cfg.auth?.strategy ?? 'none',
      tenants: cfg.tenants?.length ?? 0,
      auditEnabled: cfg.audit?.enabled === true,
      auditRetentionDays: cfg.audit?.enabled ? (cfg.audit.retentionDays ?? 30) : undefined,
      tlsUpstreams: remote.filter((s) => /^(https|wss):/.test(s.url!)).length,
      plainUpstreams: remote.filter((s) => /^(http|ws):/.test(s.url!) && !/^(https?|wss?):\/\/(localhost|127\.0\.0\.1|\[::1\])/.test(s.url!)).length,
      policyRules: cfg.policy?.rules?.length ?? 0,
      approvals: (cfg.policy?.rules ?? []).some((r) => (r as { effect?: string }).effect === 'approve') || !!cfg.approvalFlows,
      outputFilter: (!!cfg.policy?.outputFilter && cfg.policy.outputFilter.enabled !== false) || !!cfg.sanitize,
      pii: dlp && dlp.enabled !== false ? { action: 'redact', scope: dlp.scope ?? 'both', categories: Object.keys(dlpStats.byCategory) } : undefined,
      residencyRules: cfg.compliance?.residency?.rules?.length ?? 0,
      secretsProviders: cfg.secrets?.providers?.length ?? 0,
      rotationSeconds: cfg.secrets?.rotation?.intervalSeconds,
      rateLimit: !!cfg.rateLimit,
      authLockout: !!cfg.security?.authLockout,
      redactPatterns: cfg.security?.redactPatterns?.length ?? 0,
    },
    activity: {
      calls: inPeriod.length,
      errors: inPeriod.filter((m) => !m.success).length,
      denied: inPeriod.filter((m) => !m.success && m.durationMs === 0).length,
      clients: [...clients.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25).map(([client, calls]) => ({ client, calls })),
      piiFindings: { ...dlpStats.byCategory },
      blocked: { pii: dlpStats.byAction.block ?? 0, residency: 0 },
    },
    warnings: securityWarnings(cfg).map((w) => ({ id: w.id, severity: w.level, message: w.message })),
  };
}

/** ISO/IEC 27001:2022 Annex A controls the gateway provides evidence for. */
export function iso27001Controls(cfg: GatewayConfig, r: ReportInput): ControlResult[] {
  const c = r.config;
  const ctl = (id: string, title: string, ok: boolean | 'warn', evidence: string): ControlResult => ({ id, title, status: ok === 'warn' ? 'warn' : ok ? 'pass' : 'fail', evidence });
  return [
    ctl('A.5.15', 'Access control', c.authStrategy !== 'none', `auth.strategy = ${c.authStrategy}; ${c.tenants} tenant(s)`),
    ctl('A.5.17', 'Authentication information', c.authStrategy !== 'none' ? (c.authLockout ? true : 'warn') : false, `lockout ${c.authLockout ? 'on' : 'off'}`),
    ctl('A.5.18', 'Access rights (least privilege)', c.tenants > 0 || c.policyRules > 0 ? true : 'warn', `${c.tenants} tenant(s), ${c.policyRules} policy rule(s)`),
    ctl('A.5.34', 'Privacy and protection of PII', c.pii ? true : 'warn', c.pii ? `DLP on (${c.pii.scope})` : 'DLP off'),
    ctl('A.8.2', 'Privileged access rights', c.approvals ? true : 'warn', `approvals ${c.approvals ? 'on' : 'off'}${cfg.approvalFlows ? ' (multi-step flows)' : ''}`),
    ctl('A.8.7', 'Protection against malware / malicious input', cfg.sanitize || cfg.anomaly ? true : 'warn', `output sanitisation ${cfg.sanitize ? 'on' : 'off'}, anomaly detection ${cfg.anomaly ? 'on' : 'off'}`),
    ctl('A.8.12', 'Data leakage prevention', c.pii || c.outputFilter ? true : 'warn', `DLP ${c.pii ? 'on' : 'off'}, output filter ${c.outputFilter ? 'on' : 'off'}`),
    ctl('A.8.15', 'Logging', c.auditEnabled, c.auditEnabled ? `audit log on, ${c.auditRetentionDays} day retention` : 'audit log off'),
    ctl('A.8.16', 'Monitoring activities', cfg.monitor?.prometheus || cfg.anomaly ? true : 'warn', `prometheus ${cfg.monitor?.prometheus ? 'on' : 'off'}; ${r.activity.calls} call(s) in period, ${r.activity.errors} error(s)`),
    ctl('A.8.20', 'Network security', cfg.security?.ipAllowlist?.length || cfg.mtls ? true : 'warn', `IP allowlist ${cfg.security?.ipAllowlist?.length ?? 0} range(s), upstream mTLS ${cfg.mtls ? 'on' : 'off'}`),
    ctl('A.8.24', 'Use of cryptography', c.plainUpstreams === 0 ? true : 'warn', `${c.tlsUpstreams} TLS / ${c.plainUpstreams} plain-HTTP upstream(s)`),
    ctl('A.8.32', 'Change management', cfg.rollouts?.length || cfg.controlPlane?.role === 'control' ? true : 'warn', `${cfg.rollouts?.length ?? 0} gradual rollout(s); control plane role ${cfg.controlPlane?.role ?? 'all'}`),
  ];
}

export interface Rendered {
  json: Record<string, unknown>;
  md: string;
}

/** Evaluate one framework. */
export function renderFramework(fw: Framework, cfg: GatewayConfig, metrics: RequestMetric[], since: number, until: number): Rendered {
  if (fw !== 'iso27001') {
    const rep = buildReport(reportInput(fw, cfg, metrics, since, until));
    return { json: rep, md: reportMarkdown(rep) };
  }
  const input = reportInput('soc2', cfg, metrics, since, until);
  const controls = iso27001Controls(cfg, input);
  const summary = { pass: controls.filter((c) => c.status === 'pass').length, warn: controls.filter((c) => c.status === 'warn').length, fail: controls.filter((c) => c.status === 'fail').length };
  const json = { framework: 'iso27001', generatedAt: input.generatedAt, gatewayVersion: VERSION, period: input.period, summary, controls, activity: input.activity, warnings: input.warnings };
  const icon = { pass: '✅', warn: '⚠️', fail: '❌' } as const;
  const md = [
    '# ISO/IEC 27001:2022 Annex A evidence report',
    '',
    `Generated ${input.generatedAt} by mcp-gateway ${VERSION} · period ${input.period.since} → ${input.period.until}`,
    '',
    `**${summary.pass} pass · ${summary.warn} warn · ${summary.fail} fail**`,
    '',
    '| Control | Status | Evidence |',
    '|---|---|---|',
    ...controls.map((c) => `| ${c.id} — ${c.title} | ${icon[c.status]} ${c.status} | ${c.evidence.replace(/\|/g, '\\|')} |`),
    '',
  ].join('\n');
  return { json, md };
}

const sha = (b: string | Buffer) => createHash('sha256').update(b).digest('hex');

export interface Manifest {
  bundle: string;
  schedule: string;
  generatedAt: string;
  gatewayVersion: string;
  period: { since: string; until: string };
  frameworks: Array<{ framework: Framework; pass: number; warn: number; fail: number }>;
  files: Array<{ name: string; sha256: string; bytes: number }>;
  digest: string;
}

/** Write one bundle; returns its manifest. */
export function writeBundle(dir: string, schedule: string, frameworks: Framework[], cfg: GatewayConfig, metrics: RequestMetric[], periodDays: number, now = Date.now()): Manifest {
  const until = now;
  const since = until - periodDays * 86_400_000;
  const stamp = new Date(now).toISOString().replace(/[:.]/g, '-');
  const bundle = `${schedule}-${stamp}`;
  const out = join(dir, bundle);
  mkdirSync(out, { recursive: true });
  const files: Manifest['files'] = [];
  const put = (name: string, body: string) => {
    writeFileSync(join(out, name), body);
    files.push({ name, sha256: sha(body), bytes: Buffer.byteLength(body) });
  };
  const fws: Manifest['frameworks'] = [];
  for (const fw of frameworks) {
    const r = renderFramework(fw, cfg, metrics, since, until);
    put(`${fw}.md`, r.md);
    put(`${fw}.json`, JSON.stringify(r.json, null, 2));
    const s = r.json.summary as { pass: number; warn: number; fail: number };
    fws.push({ framework: fw, ...s });
  }
  const rest = withFeatureSection(portableConfig(cfg), 'complianceReports', undefined);
  put('config.redacted.json', JSON.stringify(redactConfig(rest), null, 2));
  const body = { bundle, schedule, generatedAt: new Date(now).toISOString(), gatewayVersion: VERSION, period: { since: new Date(since).toISOString(), until: new Date(until).toISOString() }, frameworks: fws, files };
  const manifest: Manifest = { ...body, digest: sha(JSON.stringify(body)) };
  writeFileSync(join(out, 'manifest.json'), JSON.stringify(manifest, null, 2));
  return manifest;
}

/** Verify a bundle's files against its manifest. */
export function verifyBundle(dir: string): { ok: boolean; problems: string[] } {
  const m = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')) as Manifest;
  const problems: string[] = [];
  const { digest, ...body } = m;
  if (sha(JSON.stringify(body)) !== digest) problems.push('manifest digest mismatch');
  for (const f of m.files) {
    const p = join(dir, f.name);
    if (!existsSync(p)) problems.push(`${f.name}: missing`);
    else if (sha(readFileSync(p)) !== f.sha256) problems.push(`${f.name}: sha256 mismatch`);
  }
  return { ok: problems.length === 0, problems };
}

const listBundles = (dir: string) =>
  existsSync(dir)
    ? readdirSync(dir)
        .filter((n) => existsSync(join(dir, n, 'manifest.json')))
        .map((n) => ({ name: n, at: statSync(join(dir, n, 'manifest.json')).mtimeMs }))
        .sort((a, b) => b.at - a.at || b.name.localeCompare(a.name))
    : [];

function prune(dir: string, keep: number): number {
  const old = listBundles(dir).slice(keep);
  for (const b of old) rmSync(join(dir, b.name), { recursive: true, force: true });
  return old.length;
}

function mount(router: import('express').Router, ctx: FeatureContext): void {
  const dirOf = (c: Cfg) => (isAbsolute(c.outputDir) ? c.outputDir : resolve(ctx.config().configDir ?? process.cwd(), c.outputDir));
  const lastRun = new Map<string, number>();
  const started = Date.now();
  const run = (c: Cfg, schedule: string, frameworks: Framework[], periodDays: number) => {
    const dir = dirOf(c);
    const m = writeBundle(dir, schedule, frameworks, ctx.config(), ctx.recent(100_000), periodDays);
    lastRun.set(schedule, Date.now());
    prune(dir, c.keep);
    logger.info(`Compliance bundle ${m.bundle} written to ${dir}`);
    return m;
  };
  const timer = setInterval(() => {
    const c = settings(ctx.config());
    if (!c) return;
    for (const s of c.schedules) {
      if (Date.now() - (lastRun.get(s.id) ?? started) >= EVERY_MS[s.every]) {
        try {
          run(c, s.id, s.frameworks, s.periodDays);
        } catch (err) {
          logger.error(`Compliance bundle ${s.id} failed: ${err instanceof Error ? err.message : String(err)}`);
          lastRun.set(s.id, Date.now());
        }
      }
    }
  }, 60_000);
  timer.unref();
  ctx.onStop?.(() => clearInterval(timer));

  const need = (res: import('express').Response) => {
    const c = settings(ctx.config());
    if (!c) res.status(404).json({ error: 'Not Found', message: 'Compliance reports are off (configure `complianceReports`)' });
    return c;
  };
  router.get('/', (_req, res) => {
    const c = need(res);
    if (!c) return;
    res.json({
      outputDir: dirOf(c),
      keep: c.keep,
      schedules: c.schedules.map((s) => {
        const last = lastRun.get(s.id);
        return { ...s, lastRunAt: last ? new Date(last).toISOString() : null, nextRunAt: new Date((last ?? started) + EVERY_MS[s.every]).toISOString() };
      }),
      bundles: listBundles(dirOf(c)).map((b) => {
        const m = JSON.parse(readFileSync(join(dirOf(c), b.name, 'manifest.json'), 'utf8')) as Manifest;
        return { name: b.name, schedule: m.schedule, generatedAt: m.generatedAt, frameworks: m.frameworks, verified: verifyBundle(join(dirOf(c), b.name)).ok };
      }),
    });
  });
  router.post('/run', (req, res) => {
    const c = need(res);
    if (!c) return;
    const b = objectBody(req, res);
    if (!b) return;
    const s = typeof b.schedule === 'string' ? c.schedules.find((x) => x.id === b.schedule) : undefined;
    if (typeof b.schedule === 'string' && !s) return void res.status(404).json({ error: 'Not Found', message: `No schedule "${b.schedule}"` });
    const fws = b.frameworks === undefined ? (s?.frameworks ?? ['soc2', 'iso27001', 'gdpr']) : Framework.array().min(1).safeParse(b.frameworks);
    if (!Array.isArray(fws) && !fws.success) return badRequest(res, '"frameworks" must be a non-empty array of soc2 | iso27001 | gdpr');
    const periodDays = typeof b.periodDays === 'number' && b.periodDays >= 1 && b.periodDays <= 366 ? Math.floor(b.periodDays) : (s?.periodDays ?? 30);
    res.status(201).json(run(c, s?.id ?? 'manual', Array.isArray(fws) ? fws : fws.data, periodDays));
  });
  router.get('/preview', (req, res) => {
    const fw = Framework.safeParse(req.query.framework ?? 'iso27001');
    if (!fw.success) return badRequest(res, '"framework" must be soc2 | iso27001 | gdpr');
    const until = Date.now();
    const r = renderFramework(fw.data, ctx.config(), ctx.recent(100_000), until - 30 * 86_400_000, until);
    if (req.query.format === 'md') return void res.type('text/markdown').send(r.md);
    res.json(r.json);
  });
  router.get('/bundles/:bundle/:file', (req, res) => {
    const c = need(res);
    if (!c) return;
    const { bundle, file } = req.params as { bundle: string; file: string };
    if (!/^[A-Za-z0-9._-]+$/.test(bundle) || !/^[A-Za-z0-9._-]+$/.test(file) || bundle.includes('..') || file.includes('..')) return badRequest(res, 'Invalid bundle or file name');
    const p = join(dirOf(c), bundle, file);
    if (!existsSync(p)) return void res.status(404).json({ error: 'Not Found', message: `No ${bundle}/${file}` });
    res.type(file.endsWith('.md') ? 'text/markdown' : 'application/json').send(readFileSync(p));
  });
}

registerFeature({
  id: 'compliance-reports',
  since: '7.8.0',
  summary: 'Automated compliance reports: scheduled SOC 2 / ISO 27001 / GDPR evidence bundles with SHA-256 manifests',
  mount,
});
