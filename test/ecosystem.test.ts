/** 9.8: ecosystem marketplace GA. */
import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startFeatureGw, type FeatureGw } from './helpers/feature-gw.js';
import { validateConfig } from '../src/config/loader.js';
import { ecosystemState } from '../src/features/ecosystem.js';

let h: FeatureGw | undefined;
let wk: Server | undefined;
beforeEach(() => ecosystemState.reset());
afterEach(async () => {
  await h?.stop();
  h = undefined;
  wk?.close();
  wk = undefined;
});
const client = (key: string) => async (path: string, body?: unknown) => {
  const r = await fetch(`${h!.base}/api/v1/features/ecosystem/${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: r.status, body: (await r.json()) as any };
};
const listing = (name: string, publisher = 'acme', extra: Record<string, unknown> = {}) => ({ name, version: '1.0.0', kind: 'plugin', publisher, description: `${name} plugin`, url: `https://plugins.example/${name}.mjs`, tags: ['security'], ...extra });
const wellKnown = (doc: unknown) =>
  new Promise<string>((resolve) => {
    wk = createServer((_q, r) => r.setHeader('content-type', 'application/json').end(JSON.stringify(doc)));
    wk.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(wk!.address() as AddressInfo).port}/.well-known/mcp-gateway-publisher.json`));
  });

describe('ecosystem marketplace GA (9.8)', () => {
  it('validates publishers', () => {
    expect(() => validateConfig({ version: 11, servers: [], features: { ecosystem: { publishers: [{ id: 'a', name: 'A' }, { id: 'a', name: 'B' }] } } })).toThrow(/duplicate publisher/);
    expect(() => validateConfig({ version: 11, servers: [], features: { ecosystem: { publishers: [{ id: 'A B', name: 'x' }] } } })).toThrow();
  });

  it('submission → review queue → approve / reject → catalogue with ratings; persistence', async () => {
    const file = join(mkdtempSync(join(tmpdir(), 'mgw-eco-')), 'eco.json');
    h = await startFeatureGw({ ecosystem: { file, publishers: [{ id: 'acme', name: 'ACME' }] } } as never);
    const op = client('op');
    const sc = client('scoped');
    expect((await sc('submissions', listing('pii-guard'))).body).toEqual({ id: 'acme.pii-guard@1.0.0', status: 'pending' });
    expect((await sc('submissions', listing('pii-guard'))).status).toBe(409);
    expect((await sc('submissions', listing('bad', 'acme', { version: 'one' }))).status).toBe(400);
    await sc('submissions', listing('spam'));
    expect((await sc('catalog')).body.count).toBe(0); // nothing approved yet
    const q = await h.admin('ecosystem');
    expect(q.body.stats).toMatchObject({ listings: 2, pending: 2 });
    expect((await h.admin('ecosystem/listings/acme.spam@1.0.0/reject', {})).status).toBe(400); // needs a reason
    expect((await h.admin('ecosystem/listings/acme.spam@1.0.0/reject', { reason: 'duplicate of pii-guard' })).body.status).toBe('rejected');
    expect((await h.admin('ecosystem/listings/acme.pii-guard@1.0.0/approve', {})).body.status).toBe('approved');
    const cat = await sc('catalog?tag=security');
    expect(cat.body.listings).toEqual([expect.objectContaining({ id: 'acme.pii-guard@1.0.0', publisher: { id: 'acme', name: 'ACME', verified: false }, rating: { average: null, count: 0 } })]);
    expect((await sc('catalog?kind=tool')).body.count).toBe(0);
    expect((await sc('listings/acme.pii-guard@1.0.0/ratings', { stars: 6 })).status).toBe(400);
    await sc('listings/acme.pii-guard@1.0.0/ratings', { stars: 2, comment: 'meh' });
    await sc('listings/acme.pii-guard@1.0.0/ratings', { stars: 4, comment: 'better now' }); // replaces
    expect((await op('listings/acme.pii-guard@1.0.0/ratings', { stars: 1, comment: 'spam spam' })).body.rating).toEqual({ average: 2.5, count: 2 });
    expect((await sc('listings/acme.spam@1.0.0/ratings', { stars: 5 })).status).toBe(404);
    const reviews = (await sc('listings/acme.pii-guard@1.0.0')).body.reviews;
    expect(reviews.map((r: any) => r.stars).sort()).toEqual([1, 4]);
    const hideFor = ecosystemState.listings.get('acme.pii-guard@1.0.0')!.reviews.find((r) => r.stars === 1)!.client;
    expect((await h.admin(`ecosystem/reviews/acme.pii-guard@1.0.0/${encodeURIComponent(hideFor)}/hide`, {})).body.rating).toEqual({ average: 4, count: 1 });
    ecosystemState.reset();
    expect((await sc('catalog')).body.listings[0].rating.average).toBe(4); // reloaded from file
  });

  it('verifies publishers via the well-known file and auto-approves them', async () => {
    const url = await wellKnown({ publisher: 'acme', keyIds: ['acme-2026', 'acme-2025'] });
    h = await startFeatureGw({ ecosystem: { autoApproveVerified: true, publishers: [{ id: 'acme', name: 'ACME', wellKnownUrl: url, keyIds: ['acme-2026'] }, { id: 'evil', name: 'Evil', wellKnownUrl: url }, { id: 'nodomain', name: 'X' }] } } as never);
    const sc = client('scoped');
    expect((await sc('submissions', listing('before'))).body.status).toBe('pending');
    expect((await h.admin('ecosystem/publishers/acme/verify', {})).body.verified).toBe(true);
    expect((await h.admin('ecosystem/publishers/evil/verify', {})).body.message).toContain('names publisher "acme"');
    expect((await h.admin('ecosystem/publishers/nodomain/verify', {})).body.message).toContain('no domain');
    expect((await sc('submissions', listing('after'))).body.status).toBe('approved');
    const cat = await sc('catalog');
    expect(cat.body.listings.map((l: any) => `${l.name}:${l.publisher.verified}`)).toEqual(['after:true']);
    expect((await h.admin('ecosystem')).body.publishers.find((p: any) => p.id === 'acme').verified).toBe(true);
  });
});
