/**
 * 13.4.0: deployment examples (examples/deploy, referenced by docs/deployment.md) are current and boot.
 * CI additionally runs them for real (.github/workflows/deploy-examples.yml: `docker compose up`, kind + Helm).
 * Here: the files parse, image references follow the current release, the gateway configs they carry validate
 * against schema v11, and a gateway started from each config answers health and a tool call.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync, existsSync, mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { parse as parseYaml, parseAllDocuments } from 'yaml';
import { validateConfig } from '../src/config/loader.js';
import { Gateway } from '../src/gateway/index.js';
import { logger } from '../src/utils/logger.js';

logger.setLevel('error');
const root = fileURLToPath(new URL('..', import.meta.url));
const ex = (p: string) => join(root, 'examples/deploy', p);
const V = (JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { version: string }).version;
const MAJOR = V.split('.')[0];
const IMAGE = 'ghcr.io/harrisoncn/mcp-gateway';
const KEY = 'deploy-example-key-0123456789abcdef0123';

let gw: Gateway | undefined;
afterEach(async () => {
  await gw?.stop();
  gw = undefined;
});

/** Start a gateway from an example config (paths of the example's echo server mapped to the local copy). */
async function boots(raw: Record<string, unknown>, echoPath: string) {
  const dir = mkdtempSync(join(tmpdir(), 'deploy-ex-'));
  const text = JSON.stringify(raw).replaceAll('/app/examples/echo-server.mjs', echoPath).replaceAll('/config/echo-server.mjs', echoPath);
  const cfg = validateConfig({ ...JSON.parse(text), auth: { strategy: 'api-key', apiKeys: [KEY] } });
  gw = new Gateway({ ...cfg, port: 0, host: '127.0.0.1', configDir: dir });
  await gw.start();
  const base = `http://127.0.0.1:${gw.address()!.port}`;
  for (let i = 0; i < 50; i++) {
    if ((await fetch(`${base}/api/v1/health/ready`)).status === 200) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  expect((await fetch(`${base}/api/v1/health/live`)).status).toBe(200);
  expect((await fetch(`${base}/api/v1/health/ready`)).status).toBe(200);
  const r = await fetch(`${base}/api/v1/tools/call`, { method: 'POST', headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' }, body: JSON.stringify({ server: 'echo', tool: 'echo', arguments: { text: 'hello' } }) });
  expect(r.status).toBe(200);
  expect(JSON.stringify(await r.json())).toContain('hello');
  writeFileSync(join(dir, 'done'), '');
}

describe('deployment examples', () => {
  it('Docker Compose: current image, files it mounts exist, its gateway config validates and boots', async () => {
    const compose = parseYaml(readFileSync(ex('compose/docker-compose.yml'), 'utf8')) as { services: Record<string, { image?: string; volumes?: string[]; healthcheck?: unknown; environment?: Record<string, string> }> };
    const svc = compose.services['mcp-gateway'];
    expect(svc.image).toBe(`\${MGW_IMAGE:-${IMAGE}:${MAJOR}}`);
    expect(svc.healthcheck).toBeDefined();
    expect(svc.environment?.MCP_GATEWAY_API_KEYS).toBeDefined();
    for (const v of svc.volumes ?? []) {
      const src = v.split(':')[0];
      if (src.startsWith('./')) expect(existsSync(ex(join('compose', src))), `${src} mounted by compose exists`).toBe(true);
    }
    const cfg = parseYaml(readFileSync(ex('compose/mcp-gateway.yml'), 'utf8')) as Record<string, unknown>;
    expect(cfg.version).toBe(12);
    await boots(cfg, ex('compose/echo-server.mjs'));
  }, 30_000);

  it('Kubernetes manifests: current image, probes on the health endpoints, ConfigMap config validates and boots', async () => {
    const docs = parseAllDocuments(readFileSync(ex('kubernetes/mcp-gateway.yaml'), 'utf8')).map((d) => d.toJS()) as Array<Record<string, any>>; // eslint-disable-line @typescript-eslint/no-explicit-any
    const kinds = docs.map((d) => d.kind);
    expect(kinds).toEqual(expect.arrayContaining(['Secret', 'ConfigMap', 'Deployment', 'Service']));
    const dep = docs.find((d) => d.kind === 'Deployment')!;
    const c = dep.spec.template.spec.containers[0];
    expect(c.image).toBe(`${IMAGE}:${MAJOR}`);
    expect(c.livenessProbe.httpGet.path).toBe('/api/v1/health/live');
    expect(c.readinessProbe.httpGet.path).toBe('/api/v1/health/ready');
    expect(dep.spec.template.spec.securityContext.runAsNonRoot).toBe(true);
    const cm = docs.find((d) => d.kind === 'ConfigMap')!;
    const cfg = parseYaml(cm.data['mcp-gateway.yml']) as Record<string, unknown>;
    expect(cfg.version).toBe(12);
    expect(cm.data['echo-server.mjs']).toBe(readFileSync(ex('compose/echo-server.mjs'), 'utf8'));
    await boots(cfg, ex('compose/echo-server.mjs'));
  }, 30_000);

  it('Helm values: the gateway config validates and boots; the chart appVersion is the current release', async () => {
    const values = parseYaml(readFileSync(ex('helm/values.yaml'), 'utf8')) as { config: Record<string, unknown>; existingSecret?: string; image?: { tag?: string } };
    expect(values.existingSecret).toBeTruthy();
    expect(values.image?.tag ?? '').toBe('');
    const chart = parseYaml(readFileSync(join(root, 'deploy/helm/mcp-gateway/Chart.yaml'), 'utf8')) as { appVersion: string; version: string };
    expect(String(chart.appVersion)).toBe(V);
    expect(String(chart.version)).toBe(V);
    await boots(values.config, ex('compose/echo-server.mjs'));
  }, 30_000);

  it('container healthchecks probe 127.0.0.1 (busybox wget resolves localhost to ::1; the gateway listens on IPv4)', () => {
    // found by the Compose CI job: the image HEALTHCHECK on http://localhost:4000 always failed → containers "unhealthy"
    const files = ['Dockerfile', 'examples/docker/docker-compose.yml', 'examples/deploy/compose/docker-compose.yml'];
    for (const f of files) {
      const t = readFileSync(join(root, f), 'utf8');
      expect(t, f).toMatch(/127\.0\.0\.1:4000\/api\/v1\/health\/live/);
      expect(t, f).not.toMatch(/wget[^\n]*localhost:4000/);
    }
  });

  it('docs/deployment.md points at the examples and shows current tags only', () => {
    const doc = readFileSync(join(root, 'docs/deployment.md'), 'utf8');
    for (const f of ['examples/deploy/compose/docker-compose.yml', 'examples/deploy/kubernetes/mcp-gateway.yaml', 'examples/deploy/helm/values.yaml']) expect(doc).toContain(f);
    const tags = [...doc.matchAll(/(?:^|[\s"'`(])ghcr\.io\/harrisoncn\/mcp-gateway:([\w.-]+)/gm)].map((m) => m[1]);
    expect(tags.length).toBeGreaterThan(3);
    const minor = V.split('.').slice(0, 2).join('.');
    for (const t of tags) expect(['latest', MAJOR, minor, V, '12', '12.0', '10', '10.9']).toContain(t);
    expect(doc).toMatch(/@sha256:/);
    expect(existsSync(join(root, '.github/workflows/deploy-examples.yml'))).toBe(true);
    void dirname;
  });
});
