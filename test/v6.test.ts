import { describe, it, expect } from 'vitest';
import { validateConfig } from '../src/config/loader.js';
import { migrateConfigText, migrateConfigObject } from '../src/config/migrate.js';
import { configDeprecations } from '../src/utils/deprecations.js';
import { applyDlp, DlpSchema } from '../src/features/dlp.js';
import { parse } from 'yaml';
import { nodeVersionError, MIN_NODE_MAJOR } from '../src/utils/node-check.js';

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

describe('6.0: schema v6, compliance.pii removed, migrate --to 6', () => {
  it('refuses schema v5 and compliance.pii; v6 validates', () => {
    expect(configDeprecations({ version: 5, compliance: { pii: {} } })).toEqual([]);
    expect(() => validateConfig({ version: 5, servers: [] })).toThrow(/schema v5 was removed in 6.0/);
    expect(configDeprecations({ compliance: { residency: {} } })).toEqual([]);
    expect(configDeprecations(null)).toEqual([]);
    const v7 = validateConfig({ version: 9, servers: [], dlp: { default: { clearance: 'public' } } });
    expect(v7.version).toBe(9);
    expect(v7.deprecations).toBeUndefined(); // 8.0
    expect(() => validateConfig({ version: 9, servers: [], compliance: { pii: { action: 'redact' } } })).toThrow(/compliance.pii: removed in 6.0 — use `dlp`/);
  });

  it('migrate --to 6 converts compliance.pii to dlp, keeping comments and residency', () => {
    const r = migrateConfigText(V5, undefined, 6);
    expect(r.changes).toEqual(['version: 5 → 6', 'compliance.pii (action redact) → dlp']);
    expect(r.text).toContain('# the CRM');
    const cfg = parse(r.text);
    expect(cfg.compliance).toEqual({ residency: { rules: [{ regions: ['eu-*'] }] } });
    expect(cfg.dlp).toEqual({ scope: 'results', servers: ['crm*'], default: { clearance: 'public', strategy: 'redact' }, levels: { phone: 'public', ssn: 'public', iban: 'public', ipv4: 'public', 'cn-id': 'public' } });
    expect(() => validateConfig(cfg)).toThrow(/schema v6 was removed in 7.0/); // 7.0
    // the migrated DLP policy redacts what compliance.pii redacted, and nothing else
    const out = applyDlp({ t: 'mail a@b.co, card 4111 1111 1111 1111, ip 10.0.0.1' }, DlpSchema.parse(cfg.dlp), undefined);
    expect(out.value.t).toBe('mail [REDACTED:email], card [REDACTED:credit-card], ip 10.0.0.1');
    expect(migrateConfigText(r.text, undefined, 6).changed).toBe(false);
  });

  it('maps block / tag / disabled and leaves an existing dlp alone', () => {
    const block = migrateConfigObject({ compliance: { pii: { action: 'block' } }, servers: [] }, 6);
    expect(block.config.dlp).toEqual({ scope: 'both', default: { clearance: 'public', strategy: 'block' } });
    expect(block.config.compliance).toBeUndefined();
    const tag = migrateConfigText(JSON.stringify({ version: 5, compliance: { pii: { action: 'tag', enabled: false } }, servers: [] }), 'json', 6);
    expect(JSON.parse(tag.text).dlp).toEqual({ enabled: false, scope: 'both', default: { clearance: 'restricted' } });
    const both = migrateConfigText(JSON.stringify({ version: 5, dlp: {}, compliance: { pii: {} }, servers: [] }), 'json', 6);
    expect(both.notes.join()).toMatch(/merge compliance.pii into dlp by hand/);
    expect(JSON.parse(both.text).compliance.pii).toEqual({});
    const blockNotes = migrateConfigText(JSON.stringify({ compliance: { pii: { action: 'block' } }, servers: [] }), 'json', 6);
    expect(blockNotes.notes.join()).toMatch(/-32013/);
    expect(migrateConfigText('version: 6\nplugins: [{ module: ./p.mjs }]\n', 'yaml', 7).notes.join()).toMatch(/apiVersion: 4/);
    expect(() => migrateConfigText('version: 6\n', 'yaml', 5)).toThrow(/already on schema v6/);
  });
});

describe('Node.js 22+ (6.0)', () => {
  it('accepts 22 and newer, refuses older runtimes with a clear message', () => {
    expect(MIN_NODE_MAJOR).toBe(22);
    expect(nodeVersionError('22.0.0')).toBeUndefined();
    expect(nodeVersionError('v24.1.0')).toBeUndefined();
    expect(nodeVersionError('20.11.1')).toMatch(/requires Node.js 22 or newer \(running v20.11.1\)/);
    expect(nodeVersionError('v18.0.0')).toMatch(/running v18.0.0/);
    expect(nodeVersionError()).toBeUndefined();
  });
});
