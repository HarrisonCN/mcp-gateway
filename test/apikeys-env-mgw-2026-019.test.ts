/**
 * MGW-2026-019 regression: `${VAR}` references in string-form API keys (`auth.apiKeys: ["${OPERATOR_KEY}"]`, the form
 * the control-plane guide shows since 7.0) and in `controlPlane.token` were not expanded — the literal text
 * `${OPERATOR_KEY}` became a valid operator key, and a data plane configured the same way authenticated with it, so a
 * cluster set up from the docs worked while anyone could call the admin API with `Authorization: Bearer ${OPERATOR_KEY}`.
 *
 * Fixed: references are expanded in every API key form and in `controlPlane.token`; a reference to an unset or empty
 * variable is a config error (fail closed) instead of a literal or empty key.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { loadConfig, validateConfig } from '../src/config/loader.js';
import { Gateway } from '../src/gateway/index.js';
import { logger } from '../src/utils/logger.js';

logger.setLevel('error');

describe('MGW-2026-019: ${VAR} in API keys and controlPlane.token', () => {
  const stops: Array<() => Promise<void>> = [];
  afterEach(async () => {
    for (const s of stops.splice(0)) await s().catch(() => undefined);
    delete process.env.MGW019_OPERATOR_KEY;
    delete process.env.MGW019_UNSET;
  });

  it('a gateway configured like the control-plane guide does not accept the literal "${OPERATOR_KEY}"', async () => {
    process.env.MGW019_OPERATOR_KEY = 'op-019-0123456789abcdef0123456789abcdef';
    const dir = mkdtempSync(join(tmpdir(), 'mgw019-'));
    const file = join(dir, 'mcp-gateway.yml');
    writeFileSync(file, 'version: 13\nhost: 127.0.0.1\ncontrolPlane:\n  role: control\nauth:\n  strategy: api-key\n  apiKeys:\n    - ${MGW019_OPERATOR_KEY}\nservers: []\n');
    const cfg = await loadConfig(file);
    const gw = new Gateway({ ...cfg, port: 0, host: '127.0.0.1', logLevel: 'error' });
    await gw.start();
    stops.push(() => gw.stop());
    const base = `http://127.0.0.1:${gw.address()!.port}`;
    const literal = await fetch(`${base}/api/v1/admin/config`, { headers: { authorization: 'Bearer ${MGW019_OPERATOR_KEY}' } });
    expect(literal.status).toBe(401);
    const real = await fetch(`${base}/api/v1/admin/config`, { headers: { authorization: `Bearer ${process.env.MGW019_OPERATOR_KEY}` } });
    expect(real.status).toBe(200);
  });

  it('expands references in string and object keys and in controlPlane.token; unset variables are refused', () => {
    process.env.MGW019_OPERATOR_KEY = 'op-019-value';
    const c = validateConfig({ auth: { strategy: 'api-key', apiKeys: ['${MGW019_OPERATOR_KEY}', { name: 'ci', key: 'ci-${MGW019_OPERATOR_KEY}' }] } });
    expect(c.auth?.apiKeys?.[0]).toBe('op-019-value');
    expect((c.auth?.apiKeys?.[1] as { key: string }).key).toBe('ci-op-019-value');
    const dp = validateConfig({ controlPlane: { role: 'data', url: 'http://cp.internal:4000', token: '${MGW019_OPERATOR_KEY}' } });
    expect(dp.controlPlane?.token).toBe('op-019-value');
    expect(() => validateConfig({ auth: { strategy: 'api-key', apiKeys: ['${MGW019_UNSET}'] } })).toThrow(/MGW019_UNSET.*not set/);
    expect(() => validateConfig({ auth: { strategy: 'api-key', apiKeys: [{ key: '${MGW019_UNSET}' }] } })).toThrow(/MGW019_UNSET.*not set/);
    expect(() => validateConfig({ controlPlane: { role: 'data', url: 'http://cp.internal:4000', token: '${MGW019_UNSET}' } })).toThrow(/MGW019_UNSET.*not set/);
    // hashed keys and plain keys are unchanged
    const h = 'sha256:' + 'a'.repeat(64);
    expect(validateConfig({ auth: { strategy: 'api-key', apiKeys: [h, 'plain-key-value'] } }).auth?.apiKeys).toEqual([h, 'plain-key-value']);
  });
});
