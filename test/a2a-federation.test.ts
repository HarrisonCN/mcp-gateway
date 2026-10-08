/** 8.2: cross-gateway A2A federation. */
import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { startFeatureGw, fakeServer, type FeatureGw } from './helpers/feature-gw.js';
import { validateConfig } from '../src/config/loader.js';
import { Gateway } from '../src/gateway/index.js';
import { A2aFederationSchema, federationState, refreshRemote, sendToRemote } from '../src/features/a2a-federation.js';
import type { GatewayConfig } from '../src/utils/types.js';

let h: FeatureGw | undefined;
let remote: Gateway | undefined;
beforeEach(() => federationState.reset());
afterEach(async () => {
  await h?.stop();
  await remote?.stop();
  h = undefined;
  remote = undefined;
});

async function startRemote(): Promise<string> {
  remote = new Gateway({ port: 0, host: '127.0.0.1', logLevel: 'error', monitor: { requestLog: false }, servers: [fakeServer('fake')], auth: { strategy: 'api-key', apiKeys: ['remote-key'] }, a2a: { enabled: true, name: 'eu-gateway' } } as GatewayConfig);
  await remote.start();
  return `http://127.0.0.1:${remote.address()!.port}`;
}

describe('A2A federation (8.2)', () => {
  it('validates config', () => {
    expect(() => validateConfig({ servers: [], a2aFederation: { remotes: [{ id: 'a', url: 'not a url' }] } })).toThrow();
    expect(() => validateConfig({ servers: [], a2aFederation: { remotes: [{ id: 'a', url: 'https://a.example' }, { id: 'a', url: 'https://b.example' }] } })).toThrow(/duplicate remote id/);
    expect(validateConfig({ version: 8, servers: [], a2aFederation: { remotes: [{ id: 'eu', url: 'https://eu.example' }] } }).a2aFederation).toBeDefined();
  });

  it('reads remote agent cards (auth, skill filter) and forwards tasks', async () => {
    const url = await startRemote();
    const c = A2aFederationSchema.parse({ gatewayId: 'us', remotes: [{ id: 'eu', url, token: 'remote-key', skills: ['echo'] }, { id: 'noauth', url }, { id: 'down', url: 'http://127.0.0.1:9' }] });
    const st = await refreshRemote(c.remotes[0]!, 2000);
    expect(st).toMatchObject({ status: 'online', card: { name: 'eu-gateway' }, skills: [{ id: 'echo' }] });
    expect((await refreshRemote(c.remotes[1]!, 2000)).error).toMatch(/HTTP 401/);
    expect((await refreshRemote(c.remotes[2]!, 2000)).status).toBe('error');
    const ok = await sendToRemote(c, 'eu', 'echo', { a: 1 }, 'key:x');
    expect(ok.status).toBe(200);
    expect((ok.body.task as { status: { state: string } }).status.state).toBe('completed');
    expect((await sendToRemote(c, 'eu', 'other', {}, 'key:x')).status).toBe(403);
    expect((await sendToRemote(c, 'nope', 'echo', {}, 'key:x')).status).toBe(404);
    expect((await sendToRemote(c, 'down', 'echo', {})).status).toBe(502);
    expect(federationState.log.map((l) => `${l.remote}:${l.state}`)).toEqual(['eu:completed']);
  });

  it('end to end through the feature routes', async () => {
    const url = await startRemote();
    h = await startFeatureGw({
      auth: { strategy: 'api-key', apiKeys: ['op', { key: 'ops-key', name: 'ops-1', servers: ['fake'] }, { key: 'dev-key', name: 'dev', servers: ['fake'] }] },
      a2aFederation: { remotes: [{ id: 'eu', url, token: 'remote-key', clients: ['key:ops-*'] }] },
    } as never);
    const as = (key: string) => ({ authorization: `Bearer ${key}`, 'content-type': 'application/json' });
    const skills = (await (await fetch(`${h.base}/api/v1/features/a2a-federation/skills`, { headers: as('ops-key') })).json()) as any; // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(skills.skills.map((s: { ref: string }) => s.ref)).toContain('echo@eu');
    expect(((await (await fetch(`${h.base}/api/v1/features/a2a-federation/skills`, { headers: as('dev-key') })).json()) as any).skills).toEqual([]); // eslint-disable-line @typescript-eslint/no-explicit-any
    const sent = await fetch(`${h.base}/api/v1/features/a2a-federation/send`, { method: 'POST', headers: as('ops-key'), body: JSON.stringify({ remote: 'eu', skill: 'echo', arguments: { hi: 1 } }) });
    expect(sent.status).toBe(200);
    expect(((await sent.json()) as any).task.status.state).toBe('completed'); // eslint-disable-line @typescript-eslint/no-explicit-any
    expect((await fetch(`${h.base}/api/v1/features/a2a-federation/send`, { method: 'POST', headers: as('dev-key'), body: JSON.stringify({ remote: 'eu', skill: 'echo' }) })).status).toBe(403);
    const admin = await h.admin('a2a-federation');
    expect(admin.body.remotes[0]).toMatchObject({ id: 'eu', status: 'online' });
    expect(admin.body.recent[0]).toMatchObject({ remote: 'eu', skill: 'echo', client: 'key:ops-1', state: 'completed' });
    expect((await h.admin('a2a-federation/refresh', {})).body.remotes[0]).toMatchObject({ id: 'eu', status: 'online' });
  });
});
