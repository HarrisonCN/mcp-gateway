/** 10.9.1 LTS security backport: 10.x-only call sites (workflows) go through the central authorizer; LTS release plumbing. */
import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { startFeatureGw, fakeServer, type FeatureGw } from './helpers/feature-gw.js';
import { childEnv } from '../src/transport/stdio.js';
import { securityWarnings } from '../src/security/posture.js';
import { validateConfig } from '../src/config/loader.js';

let h: FeatureGw | undefined;
afterEach(async () => {
  await h?.stop();
  h = undefined;
});

const post = (key: string, path: string, body: unknown) =>
  fetch(`${h!.base}${path}`, { method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, body: (await r.json()) as any })); // eslint-disable-line @typescript-eslint/no-explicit-any

describe('workflows run as the caller that started them (10.9.1)', () => {
  it('a restricted key cannot reach an out-of-scope tool through a workflow; the operator can', async () => {
    h = await startFeatureGw({
      version: 10,
      servers: [fakeServer('fake'), fakeServer('vault')],
      auth: { strategy: 'api-key', apiKeys: ['op', { key: 'alice-key', name: 'alice', servers: ['fake'] }] },
      workflows: [{ id: 'leak', nodes: [{ id: 'a', tool: 'vault/echo', args: {} }] }, { id: 'fine', nodes: [{ id: 'a', tool: 'fake/echo', args: {} }] }],
    } as never);
    const leak = await post('op', '/api/v1/admin/workflows/run', { workflow: 'leak', wait: true });
    expect(leak.status).toBe(200);
    expect(leak.body.status).toBe('succeeded');
    // alice cannot reach the admin route at all; the module call path itself is bounded by the starting principal:
    const { runWorkflow, WorkflowsSchema } = await import('../src/features/workflows.js');
    const [leakWf, fineWf] = WorkflowsSchema.parse([{ id: 'leak', nodes: [{ id: 'a', tool: 'vault/echo', args: {} }] }, { id: 'fine', nodes: [{ id: 'a', tool: 'fake/echo', args: {} }] }]);
    const { clientPrincipal } = await import('../src/auth/authorizer.js');
    const gw = h.gw as unknown as { invoker: { invoke: (c: unknown) => Promise<{ success: boolean; error?: { code: number } }> } };
    const alice = clientPrincipal('key:alice', { servers: ['fake'] });
    const inv = (s: string, t: string, a: Record<string, unknown>) => gw.invoker.invoke({ serverId: s, name: t, kind: 'tool', method: 'tools/call', params: { name: t, arguments: a }, via: 'rest', principal: alice });
    const denied = await runWorkflow(leakWf!, {}, inv as never);
    expect(denied.status).toBe('failed');
    const ok = await runWorkflow(fineWf!, {}, inv as never);
    expect(ok.status).toBe('succeeded');
  }, 30_000);
});

describe('stdio environment allowlist on schema v10 (10.9.1)', () => {
  it('only the allowlist, passthrough and explicit env reach the child; secret-like passthrough is flagged', () => {
    const env = childEnv({ PATH: '/bin', HOME: '/h', AWS_SECRET_ACCESS_KEY: 's', OPENAI_API_KEY: 'o', NODE_EXTRA_CA_CERTS: '/ca', LC_ALL: 'C' }, { FOO: 'bar' }, ['NODE_EXTRA_CA_CERTS'], 'linux');
    expect(env).toEqual({ PATH: '/bin', HOME: '/h', LC_ALL: 'C', NODE_EXTRA_CA_CERTS: '/ca', FOO: 'bar' });
    const cfg = validateConfig({ version: 10, servers: [{ id: 's', name: 's', transport: 'stdio', command: 'x', envPassthrough: ['OPENAI_API_KEY'] }], security: { stdioEnvPassthrough: ['AWS_*'] } });
    const w = securityWarnings(cfg).find((x) => x.id === 'stdio-secret-passthrough');
    expect(w?.message).toMatch(/servers\.s\.envPassthrough: OPENAI_API_KEY/);
    expect(() => validateConfig({ version: 10, servers: [{ id: 's', name: 's', transport: 'stdio', command: 'x', envPassthrough: ['NOT VALID'] }] })).toThrow();
  });
});

describe('10.x LTS release plumbing (10.9.1)', () => {
  const wf = (name: string) => parse(readFileSync(`.github/workflows/${name}`, 'utf8')) as any; // eslint-disable-line @typescript-eslint/no-explicit-any
  it('the image workflow never moves `latest`; builds do not pull from Docker Hub', () => {
    const meta = wf('docker.yml').jobs.image.steps.find((s: { id?: string }) => s.id === 'meta');
    expect(meta.with.flavor).toMatch(/latest=false/);
    expect(readFileSync('Dockerfile', 'utf8')).toMatch(/ARG NODE_IMAGE=public\.ecr\.aws\/docker\/library\/node:22-alpine/);
    expect(wf('ci.yml').jobs.test.services.redis.image).toMatch(/^public\.ecr\.aws\//);
  });
  it('client SDKs are not republished for a 10.x gateway release', () => {
    expect(readFileSync('.github/workflows/clients-publish.yml', 'utf8').match(/10\.\*\) echo/g)).toHaveLength(2);
  });
});
