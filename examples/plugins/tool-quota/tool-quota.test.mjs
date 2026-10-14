// node --test examples/plugins/tool-quota/  — the plugin loaded the way the gateway loads it (signed, worker runtime).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startPluginHarness, createTestSigningKey, signPluginFile } from '@winstonsayno/mcp-gateway/testing';

test('install → quota → crash recovery', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tool-quota-'));
  copyFileSync(new URL('./tool-quota.mjs', import.meta.url), join(dir, 'tool-quota.mjs'));
  const key = createTestSigningKey('vendor-2026');
  signPluginFile(join(dir, 'tool-quota.mjs'), key);
  const h = await startPluginHarness({ module: './tool-quota.mjs', runtime: 'worker', options: { limit: 1 } }, { baseDir: dir, trust: key.trust({ requireSigned: true }) });
  try {
    assert.equal((await h.callTool('search')).action, 'continue');
    assert.equal((await h.callTool('search')).action, 'deny');
    await h.crash();
    assert.equal((await h.callTool('search')).action, 'continue'); // fresh runtime: in-memory counters start over
  } finally {
    await h.close();
  }
});
