/** 7.8: automated compliance reports. */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startFeatureGw, type FeatureGw } from './helpers/feature-gw.js';
import { validateConfig } from '../src/config/loader.js';
import { FEATURE_CONFIG_KEYS } from '../src/gateway/features.js';
import { writeBundle, verifyBundle, renderFramework } from '../src/features/compliance-reports.js';
import type { GatewayConfig } from '../src/utils/types.js';

let h: FeatureGw | undefined;
afterEach(async () => {
  await h?.stop();
  h = undefined;
});

// 10.0: feature sections go under `features` (schema v10).
const cfg = (extra: Record<string, unknown> = {}) => {
  const feats = Object.fromEntries(Object.entries(extra).filter(([k]) => (FEATURE_CONFIG_KEYS as readonly string[]).includes(k)));
  const core = Object.fromEntries(Object.entries(extra).filter(([k]) => !(k in feats)));
  return validateConfig({ servers: [{ id: 'a', name: 'a', transport: 'streamable-http', url: 'https://a.example/mcp' }], auth: { strategy: 'api-key', apiKeys: ['secret-key'] }, ...core, ...(Object.keys(feats).length ? { features: feats } : {}) }) as GatewayConfig;
};

describe('compliance reports (7.8)', () => {
  it('ISO 27001 controls reflect the 7.x features', () => {
    const base = renderFramework('iso27001', cfg(), [], 0, Date.now());
    const status = (r: typeof base, id: string) => (r.json.controls as Array<{ id: string; status: string }>).find((c) => c.id === id)!.status;
    expect(status(base, 'A.5.15')).toBe('pass');
    expect(status(base, 'A.8.7')).toBe('warn');
    expect(status(base, 'A.8.32')).toBe('warn');
    const hardened = renderFramework('iso27001', cfg({ sanitize: {}, rollouts: [{ id: 'r', stable: 'a', canary: 'b' }], approvalFlows: { flows: [] }, audit: { enabled: true } }), [], 0, Date.now());
    expect(status(hardened, 'A.8.7')).toBe('pass');
    expect(status(hardened, 'A.8.32')).toBe('pass');
    expect(status(hardened, 'A.8.2')).toBe('pass');
    expect(status(hardened, 'A.8.15')).toBe('pass');
    expect(hardened.md).toContain('# ISO/IEC 27001:2022 Annex A evidence report');
    const soc2 = renderFramework('soc2', cfg(), [{ id: '1', timestamp: new Date().toISOString(), success: true, durationMs: 3, clientId: 'key:x' } as never], 0, Date.now());
    expect((soc2.json.activity as { calls: number }).calls).toBe(1);
    expect(soc2.md).toContain('SOC 2 compliance report');
  });

  it('bundles: files, redacted config, SHA-256 manifest, tamper detection', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mgw-comp-'));
    const m = writeBundle(dir, 'monthly', ['soc2', 'gdpr', 'iso27001'], cfg(), [], 30, Date.parse('2026-10-01T00:00:00Z'));
    expect(m.bundle).toBe('monthly-2026-10-01T00-00-00-000Z');
    expect(m.files.map((f) => f.name)).toEqual(['soc2.md', 'soc2.json', 'gdpr.md', 'gdpr.json', 'iso27001.md', 'iso27001.json', 'config.redacted.json']);
    expect(m.period).toEqual({ since: '2026-09-01T00:00:00.000Z', until: '2026-10-01T00:00:00.000Z' });
    const conf = readFileSync(join(dir, m.bundle, 'config.redacted.json'), 'utf8');
    expect(conf).not.toContain('secret-key');
    expect(verifyBundle(join(dir, m.bundle))).toEqual({ ok: true, problems: [] });
    writeFileSync(join(dir, m.bundle, 'soc2.md'), 'edited');
    expect(verifyBundle(join(dir, m.bundle)).problems).toEqual(['soc2.md: sha256 mismatch']);
    expect(() => validateConfig({ servers: [], features: { complianceReports: { schedules: [{ id: 'x', frameworks: ['hipaa'] }] } } })).toThrow();
  });

  it('gateway: run now, list with verification, download, preview, prune', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mgw-comp-gw-'));
    h = await startFeatureGw({ complianceReports: { outputDir: dir, keep: 2, schedules: [{ id: 'weekly', frameworks: ['iso27001'], every: 'weekly', periodDays: 7 }] } } as never);
    const run = await h.admin('compliance-reports/run', { schedule: 'weekly' });
    expect(run.status).toBe(201);
    expect(run.body.frameworks.map((f: { framework: string }) => f.framework)).toEqual(['iso27001']);
    const name = run.body.bundle as string;
    const file = await h.admin(`compliance-reports/bundles/${name}/iso27001.md`);
    expect(String(file.body)).toContain('ISO/IEC 27001');
    expect((await h.admin(`compliance-reports/bundles/${name}/nope.md`)).status).toBe(404);
    expect((await h.admin('compliance-reports/bundles/..%2F..%2Fetc/passwd')).status).toBeGreaterThanOrEqual(400);
    await new Promise((r) => setTimeout(r, 5));
    await h.admin('compliance-reports/run', { frameworks: ['soc2'] });
    await new Promise((r) => setTimeout(r, 5));
    await h.admin('compliance-reports/run', { frameworks: ['gdpr'], periodDays: 3 });
    const list = await h.admin('compliance-reports');
    expect(list.body.bundles).toHaveLength(2);
    expect(list.body.bundles.every((b: { verified: boolean }) => b.verified)).toBe(true);
    expect(readdirSync(dir)).toHaveLength(2);
    expect(list.body.schedules[0]).toMatchObject({ id: 'weekly', every: 'weekly' });
    expect(list.body.schedules[0].lastRunAt).toBeTruthy();
    expect((await h.admin('compliance-reports/run', { schedule: 'nope' })).status).toBe(404);
    expect((await h.admin('compliance-reports/run', { frameworks: ['hipaa'] })).status).toBe(400);
    expect((await h.admin('compliance-reports/preview?framework=gdpr')).body.framework).toBe('gdpr');
    expect((await h.admin('compliance-reports/preview?framework=x')).status).toBe(400);
  });
});
