/**
 * 14.9.0 "v15 release candidate" — migration validation, end to end.
 *
 *  M1 every example config (plain files, the Kubernetes ConfigMap, the Helm values) is taken back to schema v11
 *     (`downgradeFromV12`) and migrated forward again with `migrateToV12`: no errors, valid against
 *     schema/v12/config.schema.json, loads, and is the same config the example ships.
 *  M2 the same through the CLI on files: `config migrate --in-place` then `config rollback` restores the v11 bytes.
 *  M3 every complete config snippet in the docs (`version: 12` YAML blocks in docs/**, examples/**, README*) loads and
 *     survives the v12 → v11 → v12 round trip. Placeholders (`<…>` digests, `${VAR}`) are filled in; a snippet that
 *     elides parts with `…` is illustrative and listed explicitly.
 *  M4 every partial snippet (a top-level section such as `features:` or `routing:`) that loads on top of a minimal
 *     config also round-trips; the number that load is pinned from below so docs rot shows up here.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync, readdirSync, statSync, existsSync, mkdtempSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { tmpdir } from 'os';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import { parse as parseYaml, parseAllDocuments, stringify } from 'yaml';
import Ajv from 'ajv';
import { validateConfig } from '../src/config/loader.js';
import { migrateToV12, downgradeFromV12, downgradeLoss } from '../src/config/v12.js';
import { logger } from '../src/utils/logger.js';

logger.setLevel('error');
/* eslint-disable @typescript-eslint/no-explicit-any */
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CLI = join(ROOT, 'src', 'cli.ts');
const schema = () => new Ajv({ allErrors: true, strict: false }).compile(JSON.parse(readFileSync(join(ROOT, 'schema/v12/config.schema.json'), 'utf8')));

/** Values for every `${VAR}` the docs and examples reference, so their snippets load as written. */
const ENV_REFS = new Set<string>();
const saved: Record<string, string | undefined> = {};
function collectRefs(text: string) {
  for (const m of text.matchAll(/\$\{([A-Z0-9_]+)(?::-[^}]*)?\}/g)) ENV_REFS.add(m[1]!);
}

function walk(dir: string, pick: (name: string) => boolean, out: string[] = []): string[] {
  for (const n of readdirSync(dir)) {
    if (n === 'node_modules' || n.startsWith('.')) continue;
    const p = join(dir, n);
    if (statSync(p).isDirectory()) walk(p, pick, out);
    else if (pick(n)) out.push(p);
  }
  return out;
}

function exampleConfigs(): Array<{ name: string; text: string }> {
  const out: Array<{ name: string; text: string }> = [];
  for (const p of walk(join(ROOT, 'examples'), (n) => /^mcp-gateway\.ya?ml$/.test(n))) {
    const txt = readFileSync(p, 'utf8');
    const docs = parseAllDocuments(txt).map((x) => x.toJS());
    if (docs.length === 1 && docs[0]?.version === 12) out.push({ name: p.slice(ROOT.length + 1), text: txt });
    for (const d of docs) {
      const cm = d?.kind === 'ConfigMap' ? d.data?.['mcp-gateway.yml'] : undefined;
      if (typeof cm === 'string') out.push({ name: `${p.slice(ROOT.length + 1)} (ConfigMap)`, text: cm });
    }
  }
  const helm = join(ROOT, 'examples/deploy/helm/values.yaml');
  if (existsSync(helm)) {
    const v = parseYaml(readFileSync(helm, 'utf8'));
    if (v?.config && typeof v.config === 'object') out.push({ name: 'examples/deploy/helm/values.yaml (config)', text: stringify(v.config) });
  }
  return out;
}

interface Snippet { file: string; line: number; text: string }
function docSnippets(): Snippet[] {
  const files = [...walk(join(ROOT, 'docs'), (n) => n.endsWith('.md')), ...walk(join(ROOT, 'examples'), (n) => n.endsWith('.md')), join(ROOT, 'README.md'), join(ROOT, 'README.zh-CN.md')];
  const out: Snippet[] = [];
  for (const f of files) {
    const t = readFileSync(f, 'utf8');
    for (const m of t.matchAll(/```ya?ml\n([\s\S]*?)```/g)) out.push({ file: f.slice(ROOT.length + 1), line: t.slice(0, m.index).split('\n').length, text: m[1]! });
  }
  return out;
}
/** Fill documented placeholders: `sha256:<digest …>` → a well-formed digest. */
const fill = (s: string) => s.replace(/sha256:<[^>\n]*>/g, `sha256:${'0'.repeat(64)}`);
const illustrative = (s: string) => /…|\.\.\.\s*[\]}]|\{\s*\.\.\.\s*\}|,\s*\.\.\.\s*\}/.test(s);

/** v12 → v11 → v12 must give back the same config, valid against the schema and loadable. */
function roundTrip(name: string, v12: any) {
  const validate = schema();
  expect(() => validateConfig(JSON.parse(JSON.stringify(v12))), name).not.toThrow();
  const v11 = downgradeFromV12(v12) as any;
  expect(v11.version, name).toBe(11);
  expect(() => validateConfig(JSON.parse(JSON.stringify(v11))), `${name} (as v11)`).not.toThrow();
  const r = migrateToV12(stringify(v11));
  expect(r.report.errors, name).toEqual([]);
  // v12-only settings (modules.lifecycle / capabilities) have no v11 form: the downgrade names them instead of
  // dropping them silently, and everything else comes back unchanged
  const lost = downgradeLoss(v12);
  const expected = JSON.parse(JSON.stringify(v12));
  for (const p of lost) {
    const [a, b] = p.split('.');
    delete expected[a!][b!];
    if (!Object.keys(expected[a!]).length) delete expected[a!];
  }
  expect(r.config, name).toEqual(expected);
  expect(validate(r.config), `${name}: ${JSON.stringify(validate.errors?.slice(0, 3))}`).toBe(true);
  expect(migrateToV12(r.text).changes, `${name}: second migration is a no-op`).toEqual([]);
}

beforeAll(() => {
  for (const e of exampleConfigs()) collectRefs(e.text);
  for (const s of docSnippets()) collectRefs(s.text);
  for (const k of ENV_REFS) {
    saved[k] = process.env[k];
    if (!process.env[k]) process.env[k] = `test-${k.toLowerCase()}-0123456789abcdef`;
  }
});
afterAll(() => {
  for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
});

describe('M1 examples: v11 → v12 migration end to end', () => {
  it('every shipped example round-trips through schema v11 and back', () => {
    const list = exampleConfigs();
    expect(list.length).toBeGreaterThanOrEqual(8);
    for (const { name, text } of list) roundTrip(name, parseYaml(text));
  });
});

describe('M1b downgrade loss is reported', () => {
  it('downgradeLoss names the v12-only module settings a v11 file cannot hold', () => {
    expect(downgradeLoss({ version: 12, servers: [], modules: { activation: 'lazy', failurePolicy: { billing: 'closed' } } })).toEqual([]);
    expect(downgradeLoss({ version: 12, servers: [], modules: { activation: 'lazy', lifecycle: { initTimeoutMs: 1 }, capabilities: { x: { deny: [] } } } })).toEqual(['modules.lifecycle', 'modules.capabilities']);
    expect(downgradeLoss({ version: 12, servers: [] })).toEqual([]);
  });
});

describe('M2 CLI on files: config migrate --in-place, then config rollback', () => {
  it('migrates each example (as v11) in place, loads as v12, and rollback restores the v11 bytes', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rc-migrate-'));
    const list = exampleConfigs().slice(0, 6); // the CLI is slow to start; the in-memory round trip covers all of them
    for (const [i, { name, text }] of list.entries()) {
      const v11Text = stringify(downgradeFromV12(parseYaml(text)));
      const f = join(dir, `gw-${i}.yml`);
      writeFileSync(f, v11Text);
      const run = (...a: string[]) => spawnSync(process.execPath, ['--import', 'tsx', CLI, ...a], { cwd: ROOT, encoding: 'utf8', env: { ...process.env } });
      const mig = run('config', 'migrate', '-c', f, '--to', 'v12', '--in-place');
      expect(mig.status, `${name}: ${mig.stderr}`).toBe(0);
      const migrated = parseYaml(readFileSync(f, 'utf8'));
      expect(migrated.version, name).toBe(12);
      expect(migrated, name).toEqual(parseYaml(text));
      const rb = run('config', 'rollback', '-c', f);
      expect(rb.status, `${name}: ${rb.stderr}`).toBe(0);
      expect(readFileSync(f, 'utf8'), name).toBe(v11Text);
    }
  }, 120_000);
});

describe('M3 complete config snippets in the docs', () => {
  it('every `version: 12` snippet loads and round-trips (illustrative ones with … are listed)', () => {
    const complete = docSnippets().filter((s) => /^version:\s*12\b/m.test(s.text));
    expect(complete.length).toBeGreaterThanOrEqual(6);
    const skipped: string[] = [];
    for (const s of complete) {
      const where = `${s.file}:${s.line}`;
      if (illustrative(s.text)) { skipped.push(where); continue; }
      if (/^include:/m.test(s.text)) continue; // a GitOps directory fragment: rendered and checked by gitops-14-7-0 (G1)
      roundTrip(where, parseYaml(fill(s.text)));
    }
    // keep the illustrative list short and explicit: a new one should be a deliberate choice
    expect(skipped.map((w) => w.split(':')[0]).sort(), skipped.join(', ')).toEqual(['docs/guides/confidential.md', 'docs/guides/edge-runtime.md', 'docs/guides/offline.md', 'docs/guides/tool-registry.md']);
  });
});

describe('M4 partial snippets (top-level sections) in the docs', () => {
  it('each section that loads on a minimal config also round-trips v12 → v11 → v12', () => {
    const TOP = new Set(Object.keys((schema().schema as any).properties ?? {}));
    let loaded = 0;
    let candidates = 0;
    for (const s of docSnippets()) {
      if (/^version:/m.test(s.text) || illustrative(s.text)) continue;
      let o: any;
      try { o = parseYaml(fill(s.text)); } catch { continue; }
      if (!o || typeof o !== 'object' || Array.isArray(o)) continue;
      const keys = Object.keys(o);
      if (!keys.length || !keys.every((k) => TOP.has(k))) continue;
      candidates++;
      const cfg = { version: 12, servers: [], ...o };
      try { validateConfig(JSON.parse(JSON.stringify(cfg))); } catch { continue; } // fragments may lean on other sections
      loaded++;
      roundTrip(`${s.file}:${s.line}`, cfg);
    }
    expect(candidates).toBeGreaterThanOrEqual(40);
    expect(loaded).toBeGreaterThanOrEqual(Math.floor(candidates * 0.5));
  });
});
