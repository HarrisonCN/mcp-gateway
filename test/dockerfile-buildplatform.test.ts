// 15.0.0-rc.4 (forward-port of #224 / #225): the v14.9.2 release image build hung until the 30-minute job timeout
// because the multi-arch build ran the builder stage (dev `npm ci` + tsc) under QEMU arm64 emulation, which crashed
// with `qemu: uncaught target signal 4 (Illegal instruction)`. The builder's output (dist/) is architecture-independent,
// so the builder runs on the build host ($BUILDPLATFORM); only the runner stage is built per target platform.
// CI has no multi-arch build, so this guards the Dockerfile shape; the release image build exercises it for real.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const dockerfile = readFileSync(join(__dirname, '..', 'Dockerfile'), 'utf8');
/** `FROM` lines without comments, in order. */
const froms = dockerfile
  .split('\n')
  .map((l) => l.trim())
  .filter((l) => /^FROM\s/i.test(l));

function stage(name: string): { from: string; body: string } {
  const lines = dockerfile.split('\n');
  const start = lines.findIndex((l) => new RegExp(`^FROM\\s.*\\sAS\\s+${name}\\s*$`, 'i').test(l.trim()));
  expect(start, `stage ${name}`).toBeGreaterThanOrEqual(0);
  let end = lines.findIndex((l, i) => i > start && /^FROM\s/i.test(l.trim()));
  if (end < 0) end = lines.length;
  return { from: lines[start].trim(), body: lines.slice(start + 1, end).join('\n') };
}

describe('Dockerfile: builder on $BUILDPLATFORM, runner per target platform (rc.4)', () => {
  it('has exactly a builder and a runner stage', () => {
    expect(froms).toHaveLength(2);
  });

  it('runs the builder stage on the build platform', () => {
    expect(stage('builder').from).toMatch(/^FROM\s+--platform=\$BUILDPLATFORM\s+\$\{NODE_IMAGE\}\s+AS\s+builder$/i);
  });

  it('builds the runner stage for the target platform (no --platform pin)', () => {
    const { from } = stage('runner');
    expect(from).not.toMatch(/--platform/i);
    expect(from).toMatch(/^FROM\s+\$\{NODE_IMAGE\}\s+AS\s+runner$/i);
  });

  it('copies only the architecture-independent build output from the builder', () => {
    const copies = stage('runner')
      .body.split('\n')
      .map((l) => l.trim())
      .filter((l) => /^COPY\s+--from=builder/i.test(l));
    expect(copies.length).toBeGreaterThan(0);
    for (const c of copies) expect(c).toMatch(/^COPY\s+--from=builder\s+(--chown=\S+\s+)?\/app\/dist\b/i);
  });

  it('installs production dependencies (native or not) in the runner stage, per platform', () => {
    expect(stage('runner').body).toMatch(/npm ci[^\n]*--omit=dev/);
  });
});
