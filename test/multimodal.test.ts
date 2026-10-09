/** 9.1: multimodal tools. */
import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { startFeatureGw, type FeatureGw } from './helpers/feature-gw.js';
import { validateConfig } from '../src/config/loader.js';
import { applyMultimodal, base64Bytes, multimodalState, ERR_MEDIA_REFUSED } from '../src/features/multimodal.js';
import type { GatewayConfig, ProxyResponse } from '../src/utils/types.js';
import { fingerprint } from '../src/auth/middleware.js';

let h: FeatureGw | undefined;
beforeEach(() => multimodalState.reset());
afterEach(async () => {
  await h?.stop();
  h = undefined;
});
const b64 = (n: number, fill = 7) => Buffer.alloc(n, fill).toString('base64');
const res = (...content: unknown[]): ProxyResponse => ({ success: true, result: { content }, durationMs: 1 });
const cfg = (multimodal: Record<string, unknown>) => ({ servers: [], multimodal }) as unknown as GatewayConfig;

describe('multimodal tools (9.1)', () => {
  it('validates the policy', () => {
    expect(() => validateConfig({ version: 11, servers: [], features: { multimodal: { maxItemBytes: 10, maxTotalBytes: 5 } } })).toThrow(/maxItemBytes must not exceed/);
    expect(() => validateConfig({ version: 11, servers: [], features: { multimodal: { onViolation: 'drop' } } })).toThrow();
    expect(validateConfig({ version: 11, servers: [], features: { multimodal: { allowedTypes: ['image/png'] } } }).multimodal).toBeDefined();
    expect(ERR_MEDIA_REFUSED).toBe(-32022);
    expect(base64Bytes(b64(10))).toBe(10);
    expect(base64Bytes(b64(11))).toBe(11);
  });

  it('passes allowed content, refuses or strips the rest', () => {
    const img = { type: 'image', data: b64(100), mimeType: 'image/png' };
    const exe = { type: 'resource', resource: { uri: 'file:///x', blob: b64(10), mimeType: 'application/x-msdownload' } };
    expect(applyMultimodal(res({ type: 'text', text: 'hi' }, img), 'fake', 'shot', cfg({}))).toBeUndefined();
    const r = applyMultimodal(res(img, exe), 'fake', 'shot', cfg({}))!;
    expect(r.success).toBe(false);
    expect(r.error!.code).toBe(ERR_MEDIA_REFUSED);
    expect(r.error!.message).toContain('application/x-msdownload is not allowed');
    const s = applyMultimodal(res(img, exe), 'fake', 'shot', cfg({ onViolation: 'strip' }))!;
    const c = (s.result as any).content;
    expect(c[0]).toEqual(img);
    expect(c[1].type).toBe('text');
    expect(c[1].text).toContain('resource removed');
    const big = applyMultimodal(res({ type: 'audio', data: b64(2000), mimeType: 'audio/wav' }), 'fake', 'rec', cfg({ maxItemBytes: 1000, maxTotalBytes: 1000 }))!;
    expect(big.error!.message).toContain('exceeds maxItemBytes 1000');
    const total = applyMultimodal(res(img, img, img), 'fake', 'shot', cfg({ maxItemBytes: 150, maxTotalBytes: 250 }))!;
    expect(total.error!.message).toContain('maxTotalBytes');
    expect(applyMultimodal(res(exe), 'other', 't', cfg({ servers: ['fake'] }))).toBeUndefined();
    expect(multimodalState.stats).toMatchObject({ refused: 3, stripped: 1 });
  });

  it('offloads large items and streams them with ranges; admin stats', async () => {
    h = await startFeatureGw({ multimodal: { offloadAboveBytes: 1000 } } as never);
    const data = Buffer.alloc(200_000);
    for (let i = 0; i < data.length; i++) data[i] = i % 251;
    const out = applyMultimodal(res({ type: 'image', data: data.toString('base64'), mimeType: 'image/jpeg' }), 'fake', 'cam', cfg({ offloadAboveBytes: 1000 }), Date.now(), { clientId: `key:${fingerprint('scoped')}` })!;
    const link = (out.result as any).content[0];
    expect(link.type).toBe('resource_link');
    expect(link.size).toBe(200_000);
    const get = (headers: Record<string, string> = {}) => fetch(`${h!.base}${link.uri}`, { headers: { authorization: 'Bearer scoped', ...headers } });
    let r = await get();
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toBe('image/jpeg');
    expect(Buffer.from(await r.arrayBuffer()).equals(data)).toBe(true);
    r = await get({ range: 'bytes=100-199' });
    expect(r.status).toBe(206);
    expect(r.headers.get('content-range')).toBe('bytes 100-199/200000');
    expect(Buffer.from(await r.arrayBuffer()).equals(data.subarray(100, 200))).toBe(true);
    expect((await get({ range: 'bytes=300000-' })).status).toBe(416);
    expect((await fetch(`${h.base}/api/v1/features/multimodal/blobs/nope`, { headers: { authorization: 'Bearer scoped' } })).status).toBe(404);
    const a = await h.admin('multimodal');
    expect(a.body.enabled).toBe(true);
    expect(a.body.stats.offloaded).toBe(1);
    expect(a.body.blobs[0]).toMatchObject({ mimeType: 'image/jpeg', bytes: 200_000, tool: 'cam' });
    expect((await h.admin('multimodal/blobs', undefined, 'DELETE')).body.dropped).toBe(1);
    expect((await h.admin('multimodal', undefined, 'GET', { authorization: 'Bearer scoped' })).status).toBe(403);
  });
});
