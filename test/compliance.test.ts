/** 3.7: compliance — PII detection / redaction, data residency, SOC 2 / GDPR reports. */
import { describe, it, expect, afterEach } from 'vitest';
import { fileURLToPath } from 'url';
import { scanPii, ComplianceEngine, evaluateControls, buildReport, reportMarkdown, type ReportInput } from '../src/policy/compliance.js';
import { Gateway } from '../src/gateway/index.js';
import { validateConfig } from '../src/config/loader.js';
import type { GatewayConfig, McpServerConfig } from '../src/utils/types.js';
import { logger } from '../src/utils/logger.js';

logger.setLevel('error');
const fixture = fileURLToPath(new URL('./fixtures/fake-mcp-server.mjs', import.meta.url));

describe('PII detection', () => {
  it('finds and masks each category, validating checksums', () => {
    const text = [
      'mail jane.doe@example.com',
      'card 4111 1111 1111 1111',
      'not a card 4111 1111 1111 1112',
      'ssn 123-45-6789',
      'iban GB82 WEST 1234 5698 7654 32',
      'ip 192.168.10.20',
      'id 11010519491231002X',
      'phone +1 415-555-0100',
      'cn mobile 13800138000',
    ].join('\n');
    const r = scanPii({ note: text, nested: [{ email: 'a@b.io' }] }, { redact: true });
    const cats = r.findings.map((f) => f.category);
    for (const c of ['email', 'credit-card', 'ssn', 'iban', 'ipv4', 'cn-id', 'phone']) expect(cats, c).toContain(c);
    expect(cats.filter((c) => c === 'credit-card')).toHaveLength(1);
    expect(r.value.note).toContain('[REDACTED:email]');
    expect(r.value.note).toContain('not a card 4111 1111 1111 1112');
    expect(r.value.note).not.toContain('jane.doe');
    expect(r.value.note).not.toContain('11010519491231002X');
    expect(r.value.nested[0]!.email).toBe('[REDACTED:email]');
    expect(r.findings.find((f) => f.category === 'email' && f.path === 'nested[0].email')).toBeDefined();
    // Without redact the value is untouched; categories can be narrowed.
    const t = scanPii({ s: 'x@y.com 192.168.0.1' }, { categories: ['ipv4'] });
    expect(t.value.s).toBe('x@y.com 192.168.0.1');
    expect(t.findings.map((f) => f.category)).toEqual(['ipv4']);
  });

  it('applies scope, servers, and actions, counting findings', () => {
    let cfg: GatewayConfig['compliance'] = { pii: { action: 'redact', scope: 'arguments', servers: ['crm*'] } };
    const e = new ComplianceEngine(() => cfg);
    expect(e.applyPii('crm', 'arguments', { q: 'a@b.com' }).value).toEqual({ q: '[REDACTED:email]' });
    expect(e.applyPii('crm', 'results', { q: 'a@b.com' }).categories).toEqual([]);
    expect(e.applyPii('other', 'arguments', { q: 'a@b.com' }).categories).toEqual([]);
    cfg = { pii: { action: 'block' } };
    expect(e.applyPii('x', 'results', 'call 13800138000').blocked).toBe(true);
    cfg = { pii: { action: 'tag' } };
    const tag = e.applyPii('x', 'results', 'a@b.com');
    expect(tag).toMatchObject({ value: 'a@b.com', categories: ['email'], blocked: false });
    expect(e.findings()).toMatchObject({ 'arguments:email': 1, 'results:phone': 1, 'results:email': 1 });
    expect(e.blocked.pii).toBe(1);
  });
});

describe('data residency', () => {
  it('pins tenants to regions (first matching rule), unknown regions denied unless allowed', () => {
    let allowUnknown = false;
    const e = new ComplianceEngine(() => ({ residency: { allowUnknown, rules: [{ tenants: ['eu-*'], regions: ['eu-*'] }, { regions: ['*'] }] } }));
    expect(e.residencyAllows('eu-acme', 'eu-west-1')).toBe(true);
    expect(e.residencyAllows('eu-acme', 'us-east-1')).toBe(false);
    expect(e.residencyAllows('eu-acme', undefined)).toBe(false);
    allowUnknown = true;
    expect(e.residencyAllows('eu-acme', undefined)).toBe(true);
    expect(e.residencyAllows('us-co', 'us-east-1')).toBe(true);
    expect(new ComplianceEngine(() => undefined).residencyAllows('x', 'y')).toBe(true);
  });
});

describe('compliance reports', () => {
  const input = (over: Partial<ReportInput['config']> = {}, framework: 'soc2' | 'gdpr' = 'soc2'): ReportInput => ({
    framework, generatedAt: '2026-10-08T00:00:00.000Z', gatewayVersion: '3.7.0', period: { since: 'a', until: 'b' },
    config: { authStrategy: 'api-key', tenants: 2, auditEnabled: true, auditRetentionDays: 30, tlsUpstreams: 2, plainUpstreams: 0, policyRules: 3, approvals: true, outputFilter: true, pii: { action: 'redact', scope: 'both', categories: ['email'] }, residencyRules: 1, secretsProviders: 1, rotationSeconds: 900, rateLimit: true, authLockout: true, redactPatterns: 0, ...over },
    activity: { calls: 10, errors: 1, denied: 1, clients: [{ client: 'key:a', calls: 10 }], piiFindings: { 'results:email': 2 }, blocked: { pii: 0, residency: 1 } },
    warnings: [],
  });
  it('maps configuration to SOC 2 and GDPR controls', () => {
    expect(evaluateControls(input()).every((c) => c.status === 'pass')).toBe(true);
    const weak = evaluateControls(input({ authStrategy: 'none', auditEnabled: false, plainUpstreams: 1 }));
    expect(weak.find((c) => c.id === 'CC6.1')!.status).toBe('fail');
    expect(weak.find((c) => c.id === 'CC7.2')!.status).toBe('fail');
    expect(weak.find((c) => c.id === 'CC6.7')!.status).toBe('warn');
    const gdpr = evaluateControls(input({ pii: undefined, residencyRules: 0 }, 'gdpr'));
    expect(gdpr.find((c) => c.id === 'Art.5(1)(c)')!.status).toBe('warn');
    expect(gdpr.find((c) => c.id === 'Art.44')!.status).toBe('warn');
    const md = reportMarkdown(buildReport(input({}, 'gdpr')));
    expect(md).toMatch(/^# GDPR compliance report/);
    expect(md).toContain('| Art.44 — International transfers are restricted (data residency) | ✅ pass |');
  });
});

describe('compliance in the gateway', () => {
  let gw: Gateway | undefined;
  afterEach(async () => {
    await gw?.stop();
    gw = undefined;
  });

  it('redacts PII both ways, enforces residency, and serves reports', async () => {
    const srv = (id: string, region: string): McpServerConfig => ({ id, name: id, transport: 'stdio', command: process.execPath, args: [fixture], region });
    gw = new Gateway({
      port: 0, host: '127.0.0.1', logLevel: 'error', monitor: { requestLog: true },
      auth: { strategy: 'api-key', apiKeys: [{ name: 'eu', key: 'key-eu' }, { name: 'ops', key: 'key-ops' }] },
      tenants: [{ id: 'eu-acme', servers: ['*'], members: [{ client: 'key:eu', role: 'admin' }] }],
      compliance: { pii: { action: 'redact', categories: ['email', 'credit-card'] }, residency: { rules: [{ tenants: ['eu-*'], regions: ['eu-*'] }] } },
      servers: [srv('eu-crm', 'eu-west-1'), srv('us-crm', 'us-east-1')],
    } as GatewayConfig);
    await gw.start();
    const api = `http://127.0.0.1:${gw.address()!.port}/api/v1`;
    const call = async (key: string, server: string, args: Record<string, unknown>) => {
      const r = await fetch(`${api}/tools/call`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` }, body: JSON.stringify({ server, tool: 'echo', arguments: args }) });
      return { status: r.status, body: (await r.json()) as any };
    };
    // The echo server returns its arguments: the e-mail was redacted before it left the gateway.
    const ok = await call('key-eu', 'eu-crm', { note: 'write to jane@example.com, card 4111111111111111' });
    expect(ok.status).toBe(200);
    expect(ok.body.result.content[0].text).toContain('[REDACTED:email]');
    expect(ok.body.result.content[0].text).toContain('[REDACTED:credit-card]');
    expect(ok.body.result.content[0].text).not.toContain('jane@');
    // EU tenant → US server is refused.
    const blocked = await call('key-eu', 'us-crm', { q: 1 });
    expect(blocked.status).toBe(403);
    expect(JSON.stringify(blocked.body)).toMatch(/Data residency/);
    // Operators (no tenant) are not pinned by the eu-* rule.
    expect((await call('key-ops', 'us-crm', { q: 1 })).status).toBe(200);

    const st = (await (await fetch(`${api}/compliance`, { headers: { authorization: 'Bearer key-ops' } })).json()) as any;
    expect(st.blocked.residency).toBe(1);
    expect(st.findings['arguments:email']).toBe(1);
    expect(st.residency.servers).toEqual([{ id: 'eu-crm', region: 'eu-west-1' }, { id: 'us-crm', region: 'us-east-1' }]);
    const rep = (await (await fetch(`${api}/compliance/report?framework=soc2`, { headers: { authorization: 'Bearer key-ops' } })).json()) as any;
    expect(rep.framework).toBe('soc2');
    expect(rep.activity.calls).toBe(3);
    expect(rep.activity.denied).toBe(1);
    expect(rep.controls.find((c: { id: string }) => c.id === 'CC6.1').status).toBe('pass');
    const md = await fetch(`${api}/compliance/report?framework=gdpr&format=md`, { headers: { authorization: 'Bearer key-ops' } });
    expect(md.headers.get('content-type')).toMatch(/text\/markdown/);
    expect(await md.text()).toMatch(/^# GDPR compliance report/);
    expect((await fetch(`${api}/compliance/report?framework=hipaa`, { headers: { authorization: 'Bearer key-ops' } })).status).toBe(400);
    expect((await fetch(`${api}/compliance`, { headers: { authorization: 'Bearer key-eu' } })).status).toBe(403);
  });

  it('validates compliance config', () => {
    expect(() => validateConfig({ servers: [], compliance: { pii: { action: 'redact', categories: ['email'] }, residency: { rules: [{ regions: ['eu-*'] }] } } })).not.toThrow();
    expect(() => validateConfig({ servers: [], compliance: { pii: { categories: ['dna'] } } })).toThrow();
    expect(() => validateConfig({ servers: [], compliance: { residency: { rules: [{ regions: [] }] } } })).toThrow();
  });
});
