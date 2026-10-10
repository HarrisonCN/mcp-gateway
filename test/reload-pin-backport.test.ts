/**
 * MGW-2026-011 (LTS backport probe / regression): a call held for approval (or otherwise in flight) across a hot
 * reload must not run with the server config / injected credentials of the configuration committed meanwhile.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { startFeatureGw, fakeServer, type FeatureGw } from './helpers/feature-gw.js';
import type { GatewayConfig } from '../src/utils/types.js';

/* eslint-disable @typescript-eslint/no-explicit-any */
let h: FeatureGw | undefined;
afterEach(async () => {
  await h?.stop();
  h = undefined;
});
const ADMIN_TOKEN = 'admin-token-gen2-ONLY';
process.env.MGW_T011_ADMIN = ADMIN_TOKEN;
const call = async (server: string, args: Record<string, unknown> = { x: 1 }) => {
  const r = await fetch(`${h!.base}/api/v1/tools/call`, { method: 'POST', headers: { authorization: 'Bearer op', 'content-type': 'application/json' }, body: JSON.stringify({ server, tool: 'echo', arguments: args }) });
  return { status: r.status, text: await r.text() };
};
const tagOf = (text: string): string | undefined => /"_server\\?":\\?"([a-z0-9-]+)/.exec(text)?.[1];
const until = async (cond: () => boolean, ms = 8000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('condition not met in time');
};

describe('calls in flight across a hot reload (MGW-2026-011)', () => {
  it('an approval hold that spans a reload never runs with the new server config, its credentials or under the new policy', async () => {
    h = await startFeatureGw({
      servers: [fakeServer('fake', { SERVER_TAG: 'v1' })],
      policy: { rules: [{ name: 'hold', effect: 'approve', tools: ['echo'] }], approval: { timeoutSeconds: 30 } },
    } as never);
    const gw = h.gw as any;
    const pending = call('fake', { q: 'gen1' });
    await until(() => gw.invoker.approvals.list().pending.length === 1);
    await gw.reload({
      ...gw.config,
      servers: [{ ...fakeServer('fake', { SERVER_TAG: 'v2' }), inject: [{ ref: 'secret://env/MGW_T011_ADMIN', argument: 'token' }] }],
      policy: { rules: [{ name: 'lockdown', effect: 'deny', tools: ['echo'] }], approval: { timeoutSeconds: 30 } },
    } as GatewayConfig);
    gw.invoker.approvals.decide(gw.invoker.approvals.list().pending[0].id, true, 'key:op');
    const r = await pending;
    expect(r.text).not.toContain(ADMIN_TOKEN);
    expect(tagOf(r.text)).not.toBe('v2');
    expect((await call('fake')).status).toBe(403);
  }, 30_000);

  it('calls that do not span a reload are unaffected', async () => {
    h = await startFeatureGw({ servers: [fakeServer('fake', { SERVER_TAG: 'v1' })] } as never);
    const gw = h.gw as any;
    expect(tagOf((await call('fake')).text)).toBe('v1');
    await gw.reload({ ...gw.config, servers: [fakeServer('fake', { SERVER_TAG: 'v2' })] } as GatewayConfig);
    await until(() => gw.proxy.isConnected('fake'));
    expect(tagOf((await call('fake')).text)).toBe('v2');
  }, 30_000);
});
