/** 12.0: stdio env allowlist, per-server passthrough and runtime isolation (uid/gid, cwd, sandbox wrappers). */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { childEnv, envAllowed, planSpawn, secretLikePassthrough, DEFAULT_ENV_ALLOWLIST } from '../src/transport/isolation.js';
import { validateConfig } from '../src/config/loader.js';
import { securityWarnings } from '../src/security/posture.js';
import { startFeatureGw, fakeServer, type FeatureGw } from './helpers/feature-gw.js';

const BASE = { PATH: '/usr/bin', HOME: '/home/gw', LANG: 'C.UTF-8', LC_ALL: 'C', TMPDIR: '/tmp', AWS_SECRET_ACCESS_KEY: 'aws', OPENAI_API_KEY: 'sk', DATABASE_URL: 'pg://x', MCP_GATEWAY_API_KEYS: 'k', NODE_EXTRA_CA_CERTS: '/ca.pem', GITHUB_TOKEN: 'ghp' };

describe('stdio environment allowlist (12.0)', () => {
  it('passes only the minimal allowlist, then passthrough, then explicit env', () => {
    const env = childEnv(BASE, {}, [], 'linux');
    expect(Object.keys(env).sort()).toEqual(['HOME', 'LANG', 'LC_ALL', 'PATH', 'TMPDIR']);
    for (const k of ['AWS_SECRET_ACCESS_KEY', 'OPENAI_API_KEY', 'DATABASE_URL', 'MCP_GATEWAY_API_KEYS', 'GITHUB_TOKEN']) expect(env[k]).toBeUndefined();
    expect(childEnv(BASE, {}, ['NODE_EXTRA_CA_CERTS'], 'linux').NODE_EXTRA_CA_CERTS).toBe('/ca.pem');
    expect(childEnv(BASE, {}, ['AWS_*'], 'linux').AWS_SECRET_ACCESS_KEY).toBe('aws');
    expect(childEnv(BASE, { GITHUB_TOKEN: 'scoped', PATH: '/opt/bin' }, [], 'linux')).toMatchObject({ GITHUB_TOKEN: 'scoped', PATH: '/opt/bin' });
    const win = childEnv({ SystemRoot: 'C:\\Windows', ComSpec: 'cmd.exe', Path: 'C:\\bin', SECRET: 'x' }, {}, [], 'win32');
    expect(Object.keys(win).sort()).toEqual(['ComSpec', 'Path', 'SystemRoot']);
    expect(envAllowed('lc_ctype', DEFAULT_ENV_ALLOWLIST, 'linux')).toBe(false);
    expect(envAllowed('LC_CTYPE', DEFAULT_ENV_ALLOWLIST, 'linux')).toBe(true);
  });

  it('flags secret-looking passthrough in the security posture', () => {
    expect(secretLikePassthrough(['NODE_EXTRA_CA_CERTS', 'GITHUB_TOKEN', 'AWS_*', 'MY_API_KEY', 'LANGUAGE'])).toEqual(['GITHUB_TOKEN', 'MY_API_KEY']);
    const w = securityWarnings({ host: '127.0.0.1', auth: { strategy: 'api-key', apiKeys: ['k'.repeat(32)] }, security: { stdioEnvPassthrough: ['OPENAI_API_KEY'] }, servers: [{ id: 'gh', name: 'gh', transport: 'stdio', command: 'x', envPassthrough: ['GITHUB_TOKEN'] }] } as never);
    const ids = w.filter((x) => x.id === 'stdio-secret-passthrough');
    expect(ids).toHaveLength(1);
    expect(ids[0]!.message).toMatch(/GITHUB_TOKEN.*OPENAI_API_KEY|OPENAI_API_KEY.*GITHUB_TOKEN/);
  });

  it('validates envPassthrough and isolation', () => {
    const s = (extra: Record<string, unknown>) => ({ version: 11, servers: [{ id: 'a', name: 'a', transport: 'stdio', command: 'x', ...extra }] });
    expect(() => validateConfig(s({ envPassthrough: ['bad name'] }))).toThrow(/environment variable name/);
    expect(() => validateConfig(s({ isolation: { sandbox: { type: 'container' } } }))).toThrow(/image is required/);
    expect(() => validateConfig(s({ isolation: { sandbox: { type: 'custom', command: ['nsjail'] } } }))).toThrow(/\{command\}/);
    expect(() => validateConfig(s({ isolation: { uid: -1 } }))).toThrow();
    expect(validateConfig(s({ envPassthrough: ['NODE_*'], isolation: { uid: 1000, gid: 1000, cwd: 'srv', sandbox: { type: 'bubblewrap' } } })).servers[0]!.isolation).toMatchObject({ uid: 1000, sandbox: { network: 'none' } });
  });
});

describe('spawn plans (12.0)', () => {
  const srv = (isolation: Record<string, unknown>) => ({ id: 's', command: 'node', args: ['server.js', '--flag'], isolation: isolation as never });
  const env = { PATH: '/usr/bin', HOME: '/h', FOO: 'bar' };
  it('uid / gid / cwd', () => {
    expect(planSpawn(srv({ uid: 1001, gid: 1002, cwd: 'work' }), env, { baseDir: '/etc/mgw', platform: 'linux' })).toEqual({ command: 'node', args: ['server.js', '--flag'], env, cwd: '/etc/mgw/work', uid: 1001, gid: 1002 });
    expect(() => planSpawn(srv({ uid: 1 }), env, { platform: 'win32' })).toThrow(/POSIX-only/);
    expect(planSpawn({ id: 's', command: 'x' }, env)).toEqual({ command: 'x', args: [], env });
  });
  it('bubblewrap: no network by default, clean env inside, cwd bound rw', () => {
    const p = planSpawn(srv({ cwd: '/srv/a', sandbox: { type: 'bubblewrap', writable: ['/data'], readable: ['/models'] } }), env, { platform: 'linux' });
    expect(p.command).toBe('bwrap');
    expect(p.args).toContain('--unshare-all');
    expect(p.args).not.toContain('--share-net');
    expect(p.args).toContain('--clearenv');
    expect(p.args.join(' ')).toContain('--setenv FOO bar');
    expect(p.args.join(' ')).toContain('--bind /srv/a /srv/a');
    expect(p.args.join(' ')).toContain('--bind /data /data');
    expect(p.args.join(' ')).toContain('--ro-bind /models /models');
    expect(p.args.slice(-4)).toEqual(['--', 'node', 'server.js', '--flag']);
    expect(planSpawn(srv({ sandbox: { type: 'bubblewrap', network: 'host' } }), env).args).toContain('--share-net');
  });
  it('firejail, container and custom templates', () => {
    const f = planSpawn(srv({ cwd: '/w', sandbox: { type: 'firejail' } }), env);
    expect(f.command).toBe('firejail');
    expect(f.args).toEqual(expect.arrayContaining(['--net=none', '--whitelist=/w', '--nonewprivs', '--', 'node', 'server.js', '--flag']));
    const c = planSpawn(srv({ uid: 7, cwd: '/w', sandbox: { type: 'container', image: 'node:22-alpine', runtime: 'podman' } }), env, { platform: 'linux' });
    expect(c.command).toBe('podman');
    expect(c.uid).toBeUndefined();
    expect(c.args).toEqual(expect.arrayContaining(['--network', 'none', '--read-only', '--cap-drop=ALL', '--user', '7', '-e', 'FOO', 'node:22-alpine']));
    expect(c.args.join(' ')).not.toContain('bar'); // values are not put on argv
    const x = planSpawn(srv({ cwd: '/w', sandbox: { type: 'custom', network: 'host', command: ['nsjail', '--cwd', '{cwd}', '--net={network}', '--', '{command}', '{args}'] } }), env);
    expect([x.command, ...x.args]).toEqual(['nsjail', '--cwd', '/w', '--net=host', '--', 'node', 'server.js', '--flag']);
  });
});

describe('stdio servers see only the allowlisted environment (12.0, end to end)', () => {
  let h: FeatureGw | undefined;
  let dir: string | undefined;
  afterEach(async () => {
    await h?.stop();
    h = undefined;
    if (dir) rmSync(dir, { recursive: true, force: true });
    for (const k of ['AWS_SECRET_ACCESS_KEY', 'OPENAI_API_KEY', 'MGW_TEST_PASS']) delete process.env[k];
  });
  it('a real child: no inherited credentials, passthrough + explicit env + cwd applied', async () => {
    process.env.AWS_SECRET_ACCESS_KEY = 'leak-aws';
    process.env.OPENAI_API_KEY = 'leak-openai';
    process.env.MGW_TEST_PASS = 'passed';
    dir = mkdtempSync(join(tmpdir(), 'mgw-iso-'));
    h = await startFeatureGw({ security: { stdioEnvPassthrough: ['MGW_TEST_*'] }, servers: [{ ...fakeServer('fake', { EXPLICIT: 'yes' }), isolation: { cwd: dir } }] } as never);
    const r = await fetch(`${h.base}/api/v1/tools/call`, { method: 'POST', headers: { authorization: 'Bearer op', 'content-type': 'application/json' }, body: JSON.stringify({ server: 'fake', tool: 'env', arguments: {} }) });
    const body = (await r.json()) as { result: { content: Array<{ text: string }> } };
    const seen = JSON.parse(body.result.content[0]!.text) as { env: Record<string, string>; cwd: string };
    expect(seen.env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
    expect(seen.env.OPENAI_API_KEY).toBeUndefined();
    expect(seen.env.MGW_TEST_PASS).toBe('passed');
    expect(seen.env.EXPLICIT).toBe('yes');
    expect(seen.env.PATH).toBeDefined();
    expect(realpathSync(seen.cwd)).toBe(realpathSync(dir));
  }, 30_000);
});
