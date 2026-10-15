/**
 * 17.0.0 GA — released by owner decision (2026-10-15) while the v17 release gates are open.
 *
 *  G1 the package is 17.0.0 and the plugin compatibility row for 17.0 is `shipped` (plugin API v6 only).
 *  G2 honesty: the CHANGELOG 17.0.0 section, README (en + zh-CN), SECURITY.md, docs/release-gates.md,
 *     docs/v17/freeze.md, docs/migrating-to-v17.md and docs/versions.md say it was released by owner decision and that
 *     the external security review and the dedicated-hardware soak were not performed.
 *  G3 no document claims that gate A, B or C passed / closed / was performed.
 *  G4 channels: README / versions name 17.x as `latest` and 14.9.x as the pinned `v14-lts` line (image `:14`);
 *     docs-check knows 14.9.2 as a maintained line and `v14-lts` as a dist-tag.
 *  G5 the README minimal configuration is a schema v13 file (17.0 refuses `version: 12`).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as compat from '../src/plugins/compat.js';

const ROOT = join(__dirname, '..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
const pkg = JSON.parse(read('package.json')) as { version: string };
const STATEMENT = /released by owner decision; external security review and dedicated-hardware soak not yet performed/i;

function changelogSection(v: string): string {
  const t = read('CHANGELOG.md');
  const i = t.indexOf(`## [${v}]`);
  expect(i, `CHANGELOG has ## [${v}]`).toBeGreaterThan(-1);
  const j = t.indexOf('\n## [', i + 1);
  return t.slice(i, j < 0 ? undefined : j);
}

const [maj] = pkg.version.split('.').map(Number) as [number];
const isGa17 = maj === 17 && !pkg.version.includes('-');

describe.runIf(isGa17)('17.0.0 GA (owner decision)', () => {
  it('G1 version 17.0.0, plugin compatibility 17.0 row shipped', () => {
    expect(pkg.version).toMatch(/^17\.\d+\.\d+$/);
    const r17 = compat.PLUGIN_COMPATIBILITY.find((r) => r.from === '17.0.0');
    expect(r17?.status).toBe('shipped');
    expect(compat.pluginApiSupport(pkg.version)).toEqual({ min: 6, max: 6 });
  });

  it('G2 every release document carries the owner-decision statement', () => {
    const cl = changelogSection('17.0.0');
    expect(cl).toMatch(/Released by owner decision; external security review and dedicated-hardware soak not yet performed/);
    expect(cl).toMatch(/None of the release gates has been passed/);
    for (const f of ['README.md', 'SECURITY.md', 'docs/release-gates.md', 'docs/v17/freeze.md', 'docs/migrating-to-v17.md', 'docs/versions.md']) {
      expect(read(f).replace(/\s*\n\s*(>\s*)?/g, ' '), f).toMatch(STATEMENT);
    }
    expect(read('README.zh-CN.md')).toMatch(/由项目所有者决定发布；外部安全审查与专用硬件长稳测试尚未进行/);
  });

  it('G3 no document claims a passed gate', () => {
    const files = ['CHANGELOG.md', 'README.md', 'SECURITY.md', 'docs/release-gates.md', 'docs/v17/freeze.md', 'docs/migrating-to-v17.md', 'docs/versions.md'];
    const claim = /\bgates?\s+(A|B|C)\b[^.\n]{0,40}\b(has|have|was|were|is|are)\s+(been\s+)?(passed|closed|performed|satisfied)\b/i;
    for (const f of files) {
      const t = f === 'CHANGELOG.md' ? changelogSection('17.0.0') : read(f);
      expect(t, f).not.toMatch(claim);
    }
  });

  it('G4 channels: 17.x latest, 14.9.x pinned as v14-lts', () => {
    const readme = read('README.md');
    expect(readme).toMatch(/Current release: \*\*17\.0\.\d+\*\* \(npm `latest`\)/);
    expect(readme).toMatch(/\| 14\.x \| 14\.9\.2 \| `v14-lts` \| `:14` \|/);
    const versions = read('docs/versions.md');
    expect(versions).toMatch(/\| 17\.x \| current \| `latest`, `next` \|/);
    expect(versions).toMatch(/\| 14\.9\.x \| maintained[^|]*\| `v14-lts` \|/);
    const dc = JSON.parse(read('scripts/docs-check.json'));
    expect(dc.lts['14.9']).toBe('14.9.2');
    expect(dc.distTags).toContain('v14-lts');
  });

  it('G5 README minimal configuration is schema v13', () => {
    const readme = read('README.md');
    const i = readme.indexOf('## Minimal configuration');
    expect(readme.slice(i, i + 600)).toMatch(/\nversion: 13\b/);
  });
});
