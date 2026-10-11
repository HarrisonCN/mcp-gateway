/** 13.4.0: docs auto-check — the repository's docs are clean, and every rule catches what it is meant to catch. */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { runDocsCheck, cliSpec } from '../scripts/docs-check.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const version = (JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { version: string }).version;

/** A minimal repository with one README. */
function repo(readme: string, extra: Record<string, string> = {}) {
  const d = mkdtempSync(join(tmpdir(), 'docs-check-'));
  mkdirSync(join(d, 'src'));
  mkdirSync(join(d, 'scripts'));
  mkdirSync(join(d, 'docs'));
  copyFileSync(join(root, 'src/cli.ts'), join(d, 'src/cli.ts'));
  writeFileSync(join(d, 'package.json'), JSON.stringify({ name: '@winstonsayno/mcp-gateway', version: '13.4.0' }));
  writeFileSync(join(d, 'package-lock.json'), JSON.stringify({ version: '13.4.0' }));
  writeFileSync(join(d, 'scripts/docs-check.json'), JSON.stringify({ lts: { '12.0': '12.0.6', '10.9': '10.9.7' }, distTags: ['v12-0', 'v10-lts'], historical: ['docs/old.md'] }));
  writeFileSync(join(d, 'README.md'), readme);
  for (const [f, t] of Object.entries(extra)) writeFileSync(join(d, f), t);
  return d;
}
const rules = async (readme: string, extra?: Record<string, string>) => (await runDocsCheck(repo(readme, extra))).findings.map((f) => `${f.rule}: ${f.message}`);
const fence = (lang: string, body: string) => '```' + lang + '\n' + body + '\n```\n';

describe('docs-check', () => {
  it('the repository docs have no findings', async () => {
    const { findings, stats } = await runDocsCheck(root);
    expect(findings.map((f) => `${f.file}:${f.line} [${f.rule}] ${f.message}`)).toEqual([]);
    expect(stats.configs).toBeGreaterThan(50);
    expect(stats.links).toBeGreaterThan(100);
  }, 60_000);

  it('a clean document passes', async () => {
    expect(await rules(`# T\n\nSee [below](#t).\n\n${fence('bash', 'docker pull ghcr.io/harrisoncn/mcp-gateway:13.4.0\nnpm i @winstonsayno/mcp-gateway@13\nnpx mcp-gateway validate -c mcp-gateway.yml --strict')}${fence('yaml', 'version: 12\nservers:\n  - { id: a, name: A, transport: stdio, command: node }\nfeatures:\n  dlp: {}')}`)).toEqual([]);
  });

  it('fails on stale image tags, npm pins and "latest" statements', async () => {
    const r = await rules(`${fence('bash', 'docker run ghcr.io/harrisoncn/mcp-gateway:1\ndocker run ghcr.io/harrisoncn/mcp-gateway:1.0.0\nnpm i @winstonsayno/mcp-gateway@11.2.0')}\nThe latest 13.3.0 release.\n`);
    expect(r).toEqual(expect.arrayContaining([expect.stringMatching(/^image: stale image tag ":1"/), expect.stringMatching(/^image: stale image tag ":1.0.0"/), expect.stringMatching(/^version: stale npm version "11.2.0"/), expect.stringMatching(/^version: "latest 13.3.0" is stale/)]));
  });

  it('fails on a stale "current release" line or supported-versions row', async () => {
    const r = await rules('Current release: **13.3.0** (npm `latest`).\n\n| Line | Latest |\n|---|---|\n| 13.x | 13.3.0 | `latest` |\n| 10.x | 10.9.6 | `v10-lts` |\n| 12.x | 12.0.6 | `v12-0` |\n');
    expect(r).toEqual(['version: current release stated as 13.3.0 (package is 13.4.0)', 'version: supported-versions row 13.x names 13.3.0 (latest is 13.4.0)', 'version: supported-versions row 10.x names 10.9.6 (latest is 10.9.7)']);
  });

  it('accepts supported LTS lines and digests, and exempts historical files from version rules', async () => {
    expect(await rules(fence('bash', 'docker pull ghcr.io/harrisoncn/mcp-gateway:10\ndocker pull ghcr.io/harrisoncn/mcp-gateway:12.0.6\ndocker pull ghcr.io/harrisoncn/mcp-gateway@sha256:<digest>\nnpm i @winstonsayno/mcp-gateway@v10-lts'))).toEqual([]);
    const d = repo('# ok\n');
    writeFileSync(join(d, 'docs/old.md'), fence('bash', 'docker run ghcr.io/harrisoncn/mcp-gateway:3.0.0'));
    expect((await runDocsCheck(d)).findings).toEqual([]);
  });

  it('validates config snippets against schema v11', async () => {
    const r = await rules(fence('yaml', 'version: 10\nservers: []') + fence('yaml', 'servers:\n  - id: a\n    command: node') + fence('yaml', 'dlp: {}\nservers: []') + fence('yaml', 'port: 4000\nservrs: []'));
    expect(r).toEqual(expect.arrayContaining([
      expect.stringMatching(/^config: config "version: 10"/),
      expect.stringMatching(/^config: servers\.0\.name: Required/),
      expect.stringMatching(/^config: .*dlp: removed in 10\.0/),
      expect.stringMatching(/^config: unknown top-level key\(s\): servrs/),
    ]));
  });

  it('checks the gateway config embedded in a Kubernetes ConfigMap and Helm values', async () => {
    const cm = 'apiVersion: v1\nkind: ConfigMap\nmetadata: { name: gw }\ndata:\n  mcp-gateway.yml: |\n    version: 12\n    servers:\n      - { id: a, command: node }\n';
    const values = 'image: { repository: x }\nconfig:\n  version: 9\n  servers: []\n';
    expect(await rules(fence('yaml', cm) + fence('yaml', values))).toEqual(expect.arrayContaining([expect.stringMatching(/^config: servers\.0\.name: Required/), expect.stringMatching(/^config: config "version: 9"/)]));
  });

  it('checks JSON / TypeScript syntax, CLI commands and flags, links and anchors', async () => {
    const r = await rules(`${fence('json', '{ "a": 1, }')}${fence('ts', 'const x: number = ;')}${fence('bash', 'mcp-gateway start --no-such-flag\nmcp-gateway frobnicate\nmcp-gateway plugin sign p.js -k k.pem --key-id k1')}\n[x](docs/missing.md) [y](#nope)\n`);
    expect(r).toEqual(expect.arrayContaining([
      expect.stringMatching(/^syntax: JSON/),
      expect.stringMatching(/^syntax: ts:/),
      'cli: unknown flag "--no-such-flag" for "mcp-gateway start"',
      'cli: unknown command "mcp-gateway frobnicate"',
      'link: broken link "docs/missing.md" (no such file)',
      'link: broken anchor "#nope" in README.md',
    ]));
    expect(r.filter((x) => x.includes('sign'))).toEqual([]);
  });

  it('a skip marker exempts one block', async () => {
    expect(await rules(`<!-- docs-check: skip -->\n${fence('json', '{ bad }')}`)).toEqual([]);
  });

  it('reads every CLI command and flag from src/cli.ts (including shared option helpers)', () => {
    const spec = cliSpec(root);
    expect([...spec.get('start')!]).toEqual(expect.arrayContaining(['-c', '--config', '--no-watch', '--insecure']));
    expect([...spec.get('diff')!]).toEqual(expect.arrayContaining(['--against', '-c', '--url', '--key']));
    expect([...spec.get('sign')!]).toEqual(expect.arrayContaining(['-k', '--key-id', '--pq-key']));
  });

  it('security docs: private vulnerability reporting is enabled (verified via the API), no independent audit claimed', () => {
    for (const f of ['SECURITY.md', 'README.md', 'README.zh-CN.md', 'docs/security/threat-model.md', 'docs/security/incident-response.md']) {
      const t = readFileSync(join(root, f), 'utf8');
      expect(t, f).not.toMatch(/not enabled yet|pending enablement|private reporting is disabled|尚未启用/i);
    }
    const sec = readFileSync(join(root, 'SECURITY.md'), 'utf8');
    expect(sec).toContain('https://github.com/HarrisonCN/mcp-gateway/security/advisories/new');
    expect(sec).toMatch(/private vulnerability reporting is enabled/i);
    expect(sec).toMatch(/no independent third-party (security )?audit/i);
    expect(readFileSync(join(root, 'README.md'), 'utf8')).toMatch(/no independent third-party audit/i);
    expect(readFileSync(join(root, 'README.zh-CN.md'), 'utf8')).toMatch(/尚未经过独立第三方安全审计/);
  });

  it('the package version is the one the docs are checked against', () => {
    expect(version).toMatch(/^14\./);
  });
});
