/**
 * MGW-2026-016 regression: a signed plugin must run exactly the bytes whose signature was verified.
 *  S1 the file is swapped right after the gateway read + verified it → refused, the swapped code never runs
 *  S2 a signed entry cannot pull unsigned code from disk through a relative import
 *  S3 an untouched signed plugin still loads and runs
 */
import { describe, it, expect, vi } from 'vitest';
import { writeFileSync, mkdtempSync, existsSync } from 'fs';
import * as fsp from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { PluginHost, loadPlugin } from '../src/plugins/index.js';
import { generateSigningKey, signArtifact } from '../src/plugins/trust.js';

vi.mock('fs/promises', async (orig) => {
  const m = await orig<typeof import('fs/promises')>();
  const readFile = vi.fn(m.readFile);
  return { ...m, readFile, default: { ...m, readFile } };
});

const call = () => ({ serverId: 's', name: 't', kind: 'tool' as const, method: 'tools/call', arguments: {}, via: 'rest' as const, state: new Map() });

describe('MGW-2026-016 signed plugins load the verified bytes', () => {
  it('S1-S3', async () => {
    const d = mkdtempSync(join(tmpdir(), 'mgw-016-'));
    const marker = join(d, 'evil-ran');
    const good = `export default { name: 'signed', apiVersion: 5, onToolCall: () => ({ action: 'deny', reason: 'signed-code' }) };`;
    const evil = `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'x'); export default { name: 'signed', apiVersion: 5 };`;
    const key = generateSigningKey();
    const trust = { requireSigned: true, keys: [{ id: 'k1', publicKey: key.publicKey }] };
    const sign = (f: string, src: string) => (writeFileSync(join(d, f), src), writeFileSync(join(d, `${f}.sig`), JSON.stringify(signArtifact(src, key.privateKey, 'k1'))));

    // S3
    sign('ok.mjs', good);
    const ok = await loadPlugin({ module: './ok.mjs' } as never, d, trust as never);
    const host = new PluginHost();
    await host.set([ok]);
    expect(JSON.stringify(await host.beforeCall(call()))).toMatch(/signed-code/);
    await host.close();

    // S1
    sign('swap.mjs', good);
    const f = join(d, 'swap.mjs');
    const real = (await vi.importActual<typeof import('fs/promises')>('fs/promises')).readFile;
    let reads = 0;
    vi.mocked(fsp.readFile).mockImplementation((async (p: Parameters<typeof real>[0], o?: Parameters<typeof real>[1]) => {
      const out = await real(p, o as never);
      if (String(p) === f && reads++ === 0) writeFileSync(f, evil);
      return out;
    }) as never);
    const r = await loadPlugin({ module: './swap.mjs' } as never, d, trust as never).then(() => 'loaded', (e: Error) => e.message);
    vi.mocked(fsp.readFile).mockImplementation(real as never);
    expect(reads).toBeGreaterThan(0);
    expect(existsSync(marker), 'the swapped (unsigned) code ran').toBe(false);
    expect(r).toMatch(/changed after signature verification/);

    // S2
    writeFileSync(join(d, 'helper.mjs'), `export const x = 1;`);
    sign('dep.mjs', `import { x } from './helper.mjs'; export default { name: 'dep', apiVersion: 5, x };`);
    await expect(loadPlugin({ module: './dep.mjs' } as never, d, trust as never)).rejects.toThrow(/self-contained/);
  });
});
