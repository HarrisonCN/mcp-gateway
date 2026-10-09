import { describe, it, expect, afterEach } from 'vitest';
import { DlpSchema, applyDlp, maskValue, policyFor } from '../src/features/dlp.js';
import { validateConfig } from '../src/config/loader.js';
import { startFeatureGw, type FeatureGw } from './helpers/feature-gw.js';

let h: FeatureGw | undefined;
afterEach(async () => {
  await h?.stop();
  h = undefined;
});

const cfg = DlpSchema.parse({
  default: { clearance: 'internal', strategy: 'mask' },
  tenants: { finance: { clearance: 'restricted' }, trial: { clearance: 'public', strategy: 'block' }, ops: { strategy: 'hash', salt: 's' }, eu: { strategy: 'redact' } },
  detectors: [{ name: 'employee-id', pattern: 'EMP-\\d{6}', level: 'confidential' }],
  levels: { ipv4: 'public' },
});
const DATA = { note: 'card 4111 1111 1111 1111 for a@b.co, host 10.0.0.1, staff EMP-123456' };

describe('DLP (5.6)', () => {
  it('classifies by level and masks per tenant clearance', () => {
    const def = applyDlp(DATA, cfg, undefined);
    expect(def.findings.map((f) => [f.category, f.level, f.action])).toEqual([
      ['email', 'internal', 'allow'], ['credit-card', 'restricted', 'mask'], ['ipv4', 'public', 'allow'], ['employee-id', 'confidential', 'mask'],
    ]);
    expect(def.value.note).toContain('a@b.co');
    expect(def.value.note).toMatch(/•+1111 for/);
    expect(def.value.note).not.toContain('EMP-123456');
    expect(applyDlp(DATA, cfg, 'finance').value).toEqual(DATA);
    const trial = applyDlp(DATA, cfg, 'trial');
    expect(trial.blocked).toBe(true);
    expect(trial.value).toEqual(DATA);
    const ops = applyDlp(DATA, cfg, 'ops');
    expect(ops.value.note).toMatch(/tok_[0-9a-f]{8}/);
    expect(applyDlp(DATA, cfg, 'ops').value).toEqual(ops.value); // stable pseudonyms
    expect(applyDlp({ a: [DATA.note] }, cfg, 'eu').value.a[0]).toContain('[REDACTED:credit-card]');
    // already-masked output is not re-processed
    expect(applyDlp(def.value, cfg, undefined).findings.filter((f) => f.action !== 'allow')).toEqual([]);
  });

  it('helpers and schema validation', () => {
    expect(maskValue('short', 'mask', 'x', '')).toBe('•••••');
    expect(maskValue('123456789', 'mask', 'x', '')).toBe('•••••6789');
    expect(policyFor(DlpSchema.parse({}), 'nobody')).toMatchObject({ clearance: 'internal', strategy: 'mask' });
    expect(() => validateConfig({ servers: [], features: { dlp: { detectors: [{ name: 'x', pattern: '(' }] } } })).toThrow(/invalid regular expression/);
    expect(applyDlp(42, cfg, undefined).findings).toEqual([]);
  });

  it('masks tool results per tenant and blocks above clearance (live)', async () => {
    h = await startFeatureGw({
      auth: { strategy: 'api-key', apiKeys: ['op', { key: 'k-fin', name: 'fin' }, { key: 'k-trial', name: 'tr' }] },
      tenants: [{ id: 'finance', servers: ['*'], members: [{ client: 'key:fin', role: 'owner' }] }, { id: 'trial', servers: ['*'], members: [{ client: 'key:tr', role: 'owner' }] }],
      dlp: { scope: 'results', default: { clearance: 'internal', strategy: 'mask' }, tenants: { finance: { clearance: 'restricted' }, trial: { clearance: 'public', strategy: 'block' } } },
    } as never);
    const call = async (key: string) => (await (await fetch(`${h!.base}/api/v1/tools/call`, { method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: JSON.stringify({ tool: 'echo', server: 'fake', arguments: { card: '4111 1111 1111 1111' } }) })).json()) as any;
    expect(JSON.stringify((await call('op')).result)).toMatch(/•+1111/);
    expect(JSON.stringify((await call('k-fin')).result)).toContain('4111 1111 1111 1111');
    const tr = await call('k-trial');
    expect(tr.error?.code ?? tr.code).toBeDefined();
    expect(JSON.stringify(tr)).toContain('DLP');
    const st = await h.admin('dlp');
    expect(st.body).toMatchObject({ enabled: true, scope: 'results', tenants: { trial: { strategy: 'block', clearance: 'public' } } });
    expect(st.body.stats.byAction.mask).toBeGreaterThan(0);
    const cl = await h.admin('dlp/classify', { value: 'ssn 123-45-6789', tenant: 'finance' });
    expect(cl.body).toMatchObject({ blocked: false, findings: [{ category: 'ssn', level: 'restricted', action: 'allow' }] });
    expect((await h.admin('dlp/classify', [])).status).toBe(400);
  });

  it('blocks sensitive arguments before they reach the upstream', async () => {
    h = await startFeatureGw({ dlp: { scope: 'arguments', servers: ['fa*'], default: { clearance: 'public', strategy: 'block' } } } as never);
    const r = await fetch(`${h.base}/api/v1/tools/call`, { method: 'POST', headers: { authorization: 'Bearer op', 'content-type': 'application/json' }, body: JSON.stringify({ tool: 'echo', server: 'fake', arguments: { to: 'x@y.org' } }) });
    expect(JSON.stringify(await r.json())).toContain('sensitive data in the arguments (email)');
    await h.gw.reload({ ...(h.gw as any).config, dlp: { scope: 'arguments', default: { clearance: 'public', strategy: 'redact' } } });
    const ok = (await (await fetch(`${h.base}/api/v1/tools/call`, { method: 'POST', headers: { authorization: 'Bearer op', 'content-type': 'application/json' }, body: JSON.stringify({ tool: 'echo', server: 'fake', arguments: { to: 'x@y.org' } }) })).json()) as any;
    expect(JSON.stringify(ok.result)).toContain('[REDACTED:email]');
    await h.gw.reload({ ...(h.gw as any).config, dlp: { scope: 'arguments', servers: ['other'], default: { clearance: 'public', strategy: 'redact' } } });
    const pass = (await (await fetch(`${h.base}/api/v1/tools/call`, { method: 'POST', headers: { authorization: 'Bearer op', 'content-type': 'application/json' }, body: JSON.stringify({ tool: 'echo', server: 'fake', arguments: { to: 'x@y.org' } }) })).json()) as any;
    expect(JSON.stringify(pass.result)).toContain('x@y.org');
  });
});
