import { describe, it, expect } from 'vitest';
import { validateConfig } from '../src/config/loader.js';
import { migrateConfigText, migrateConfigObject } from '../src/config/migrate.js';
import { configDeprecations } from '../src/utils/deprecations.js';
import { applyDlp, DlpSchema } from '../src/features/dlp.js';
import { parse } from 'yaml';

const V5 = `# my gateway
version: 5
servers:
  - id: crm # the CRM
    name: crm
    transport: stdio
    command: node
compliance:
  pii:
    action: redact
    scope: results
    categories: [email, credit-card]
    servers: ["crm*"]
  residency:
    rules: [{ regions: ["eu-*"] }]
`;

describe('6.0 preparation (5.9)', () => {
  it('deprecates schema v5 and compliance.pii; v6 preview validates', () => {
    expect(configDeprecations({ version: 5, compliance: { pii: {} } }).map((d) => `${d.id}@${d.removedIn}`)).toEqual(['schema-v5@6.0.0', 'compliance-pii@6.0.0']);
    expect(configDeprecations({ compliance: { residency: {} } })).toEqual([]);
    expect(configDeprecations(null)).toEqual([]);
    const v6 = validateConfig({ version: 6, servers: [], dlp: { default: { clearance: 'public' } } });
    expect(v6.version).toBe(6);
    expect(v6.deprecations).toBeUndefined();
    expect(() => validateConfig({ version: 6, servers: [], compliance: { pii: { action: 'redact' } } })).toThrow(/compliance.pii: not part of config schema v6 — use `dlp`/);
  });

  it('migrate --to 6 converts compliance.pii to dlp, keeping comments and residency', () => {
    const r = migrateConfigText(V5);
    expect(r.changes).toEqual(['version: 5 → 6', 'compliance.pii (action redact) → dlp']);
    expect(r.text).toContain('# the CRM');
    const cfg = parse(r.text);
    expect(cfg.compliance).toEqual({ residency: { rules: [{ regions: ['eu-*'] }] } });
    expect(cfg.dlp).toEqual({ scope: 'results', servers: ['crm*'], default: { clearance: 'public', strategy: 'redact' }, levels: { phone: 'public', ssn: 'public', iban: 'public', ipv4: 'public', 'cn-id': 'public' } });
    const v = validateConfig(cfg);
    expect(v.deprecations).toBeUndefined();
    // the migrated DLP policy redacts what compliance.pii redacted, and nothing else
    const out = applyDlp({ t: 'mail a@b.co, card 4111 1111 1111 1111, ip 10.0.0.1' }, DlpSchema.parse(cfg.dlp), undefined);
    expect(out.value.t).toBe('mail [REDACTED:email], card [REDACTED:credit-card], ip 10.0.0.1');
    expect(migrateConfigText(r.text).changed).toBe(false);
  });

  it('maps block / tag / disabled and leaves an existing dlp alone', () => {
    const block = migrateConfigObject({ compliance: { pii: { action: 'block' } }, servers: [] });
    expect(block.config.dlp).toEqual({ scope: 'both', default: { clearance: 'public', strategy: 'block' } });
    expect(block.config.compliance).toBeUndefined();
    const tag = migrateConfigText(JSON.stringify({ version: 5, compliance: { pii: { action: 'tag', enabled: false } }, servers: [] }), 'json');
    expect(JSON.parse(tag.text).dlp).toEqual({ enabled: false, scope: 'both', default: { clearance: 'restricted' } });
    const both = migrateConfigText(JSON.stringify({ version: 5, dlp: {}, compliance: { pii: {} }, servers: [] }), 'json');
    expect(both.notes.join()).toMatch(/merge compliance.pii into dlp by hand/);
    expect(JSON.parse(both.text).compliance.pii).toEqual({});
    const blockNotes = migrateConfigText(JSON.stringify({ compliance: { pii: { action: 'block' } }, servers: [] }), 'json');
    expect(blockNotes.notes.join()).toMatch(/-32013/);
    expect(migrateConfigText('version: 6\nplugins: [{ module: ./p.mjs }]\n').notes.join()).toMatch(/apiVersion: 4/);
    expect(() => migrateConfigText('version: 6\n', 'yaml', 5)).toThrow(/already on schema v6/);
  });
});
