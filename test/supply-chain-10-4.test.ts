// 10.4: guard the supply-chain pipeline (signing, scanning, SBOM, Dependabot) against accidental removal.
import { describe, expect, it } from 'vitest';
import { readFileSync, existsSync } from 'fs';
import { parse } from 'yaml';

const wf = (name: string) => parse(readFileSync(`.github/workflows/${name}`, 'utf8')) as any;
const steps = (job: any) => (job.steps ?? []) as Array<Record<string, any>>;

describe('supply chain (10.4)', () => {
  it('docker.yml signs the pushed image by digest with cosign keyless and verifies it', () => {
    const d = wf('docker.yml');
    expect(d.permissions['id-token']).toBe('write');
    const s = steps(d.jobs.image);
    const build = s.find((x) => String(x.uses ?? '').startsWith('docker/build-push-action'));
    expect(build?.id).toBe('build');
    expect(build?.with?.provenance).toBe(true);
    expect(build?.with?.sbom).toBe(true);
    expect(s.some((x) => String(x.uses ?? '').startsWith('sigstore/cosign-installer'))).toBe(true);
    const sign = s.find((x) => /cosign sign --yes/.test(x.run ?? ''));
    expect(sign?.run).toContain('@${DIGEST}');
    expect(sign?.env?.DIGEST).toContain('steps.build.outputs.digest');
    expect(s.find((x) => /cosign verify/.test(x.run ?? ''))?.run).toContain('token.actions.githubusercontent.com');
  });

  it('CI scans dependencies and the image with Trivy (blocking) and builds SBOMs', () => {
    const job = wf('ci.yml').jobs['supply-chain'];
    const trivy = steps(job).filter((x) => String(x.uses ?? '').startsWith('aquasecurity/trivy-action'));
    const fs = trivy.find((x) => x.with['scan-type'] === 'fs');
    expect(fs?.with['exit-code']).toBe('1');
    expect(fs?.with.severity).toContain('HIGH');
    const img = trivy.filter((x) => x.with['scan-type'] === 'image');
    expect(img.some((x) => x.with['exit-code'] === '1' && x.with.severity.includes('CRITICAL'))).toBe(true);
    const runs = steps(job).map((x) => x.run ?? '').join('\n');
    expect(runs).toContain('npm sbom --omit dev --sbom-format cyclonedx');
    expect(runs).toContain('MCP_GATEWAY_API_KEYS=ci-key');
  });

  it('release assets include SBOMs and checksums', () => {
    const runs = steps(wf('release.yml').jobs.assets).map((x) => x.run ?? '').join('\n');
    expect(runs).toContain('--sbom-format spdx');
    expect(runs).toMatch(/gh release upload .*SHA256SUMS/);
  });

  it('Dependabot covers every package ecosystem in the repository', () => {
    const d = parse(readFileSync('.github/dependabot.yml', 'utf8')) as { updates: Array<{ 'package-ecosystem': string; directory: string }> };
    const eco = d.updates.map((u) => `${u['package-ecosystem']}:${u.directory}`);
    for (const e of ['npm:/', 'npm:/clients/js', 'gradle:/clients/kotlin', 'pip:/clients/python', 'gomod:/clients/go', 'github-actions:/', 'docker:/']) {
      expect(eco).toContain(e);
    }
  });

  it('security docs exist and are linked from SECURITY.md', () => {
    const sec = readFileSync('SECURITY.md', 'utf8');
    for (const f of ['docs/security/incident-response.md', 'docs/security/supply-chain.md']) {
      expect(existsSync(f)).toBe(true);
      expect(sec).toContain(f);
    }
  });
});
