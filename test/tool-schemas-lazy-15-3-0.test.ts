/**
 * 15.3.0-canary.0: `policy.toolSchemas` is loaded on first use (13.3.0 cold-start rule, bench/kernel.mjs module guard).
 *
 * The CI "Load + faults" job's kernel bench refused the first PR build: the `minimal` profile (no features, no policy)
 * evaluated src/policy/tool-schemas + json-schema at import time (moduleKb 2213.4 > 1.1 × 1995.2 + 5). A gateway without
 * `policy.toolSchemas` must not pay for them:
 *  L1 the gateway / invoker import graph has no value import of the governor or the validator (type-only is fine);
 *  L2 an invoker that never sees `policy.toolSchemas` never loads the governor; L3 the first configured use loads it once.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { ToolInvoker } from '../src/gateway/invoker.js';

const SRC = resolve(__dirname, '..', 'src');
const valueImport = (file: string, mod: string) =>
  readFileSync(join(SRC, file), 'utf8')
    .split('\n')
    .some((l) => /^\s*import\s+(?!type\b)/.test(l) && l.includes(`'${mod}'`));

describe('policy.toolSchemas is lazy (15.3.0-canary.0)', () => {
  it('L1 no value import of tool-schemas / json-schema from the gateway or the invoker', () => {
    for (const f of ['gateway/invoker.ts', 'gateway/index.ts', 'gateway/ops-console.ts']) {
      expect(valueImport(f, '../policy/tool-schemas.js'), f).toBe(false);
      expect(valueImport(f, '../policy/json-schema.js'), f).toBe(false);
    }
  });

  it('L2/L3 the governor is created on first use only, and only once', async () => {
    const inv = new ToolInvoker({} as never);
    expect(inv.toolSchemasLoaded).toBe(false);
    const [a, b] = await Promise.all([inv.loadToolSchemas(), inv.loadToolSchemas()]);
    expect(a).toBe(b);
    expect(inv.toolSchemasLoaded).toBe(true);
    expect(a.report(undefined, [])).toEqual({ validateOutput: 'off', onDrift: 'block', tools: [], missing: [] });
  });
});
