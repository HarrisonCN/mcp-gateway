/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * 14.7.0 GitOps 与治理 — declarative config directories, env-diff review, policy simulation, signed releases (tests-first).
 *
 * Contract:
 *  G1 config directory: base.yml + environments/<env>.yml overlay, `include:` (relative, inside the directory, no
 *     cycles); deep merge, lists of objects with `id` merged by id (`$delete: true` removes), `null` removes a key;
 *     secrets by reference only (`${ENV}`, `secret://…`, `sha256:` key hashes) — a literal secret is refused
 *  G2 env diff: two environments diffed structurally (secrets stay references)
 *  G3 signed release manifest (ed25519): git sha, author, approvals; trusted keys + roles; N approvers per environment
 *     (author never counts, one approval per identity); tamper / wrong env / expired / replay refused
 *  G4 policy simulation: recorded or sample calls replayed against the candidate — which allow/deny decisions change
 *     (policy rules, removed servers, key scopes) and why
 *  G5 HTTP: /api/v1/admin/gitops/{status,plan,apply}; enforcement refuses unsigned / unapproved bundles and the
 *     unmanaged config paths (PUT /admin/config, /admin/reload); drift detection; audit entries; metrics
 *  G6 config: controlPlane.gitops validated; schema v12 describes it
 *  G7 CLI: mcp-gateway gitops render|diff|keygen|sign|approve|verify|plan|apply|status (text + --json, exit codes)
 *  G8 examples/gitops: config directory renders for staging and prod; GitHub Actions workflow runs plan / apply
 */
import { describe, it, expect, afterEach, beforeAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, statSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { spawn } from 'node:child_process';
import { parse as parseYaml } from 'yaml';
import {
  renderConfigDir,
  listEnvironments,
  diffEnvironments,
  configHash,
  findSecretLiterals,
  generateSigningKey,
  createReleaseManifest,
  approveRelease,
  verifyRelease,
  simulateRelease,
  GitopsError,
} from '../src/config/gitops.js';
import { validateConfig } from '../src/config/loader.js';
import { buildV12ConfigSchema } from '../src/config/v12.js';
import { startFeatureGw, op, type FeatureGw } from './helpers/feature-gw.js';
import type { GatewayConfig } from '../src/utils/types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI = resolve(__dirname, '..', 'src', 'cli.ts');

function tree(files: Record<string, string>): string {
  const d = mkdtempSync(join(tmpdir(), 'gitops-'));
  for (const [p, c] of Object.entries(files)) {
    mkdirSync(dirname(join(d, p)), { recursive: true });
    writeFileSync(join(d, p), c);
  }
  return d;
}

const BASE = `
version: 13
include: [servers.yml]
auth:
  strategy: api-key
  apiKeys:
    - { name: op, key: "\${GITOPS_OP_KEY}" }
    - { name: ci, key: "sha256:${'a'.repeat(64)}", scope: { servers: [github] } }
rateLimit: { windowSeconds: 60, limit: 100 }
policy:
  default: allow
  rules:
    - { name: no-deletes, effect: deny, tools: ["*delete*"] }
`;
const SERVERS = `
servers:
  - { id: github, name: GitHub, transport: http, url: "https://api.example.com/mcp", headers: { authorization: "Bearer \${GITHUB_TOKEN}" } }
  - { id: files, name: Files, transport: http, url: "https://files.example.com/mcp" }
  - { id: scratch, name: Scratch, transport: http, url: "https://scratch.example.com/mcp" }
`;
const STAGING = `
rateLimit: { limit: 1000 }
`;
const PROD = `
include: [_prod-policy.yml]
servers:
  - { id: github, timeoutMs: 20000 }
  - { id: scratch, $delete: true }
cache: null
`;
const PROD_POLICY = `
policy:
  default: deny
  rules:
    - { name: no-deletes, effect: deny, tools: ["*delete*"] }
    - { name: reads, effect: allow, tools: ["*read*", "*list*", "*search*"] }
`;
const exampleTree = () =>
  tree({ 'base.yml': BASE + 'cache: { enabled: true }\n', 'servers.yml': SERVERS, 'environments/staging.yml': STAGING, 'environments/prod.yml': PROD, 'environments/_prod-policy.yml': PROD_POLICY });

describe('G1 config directory', () => {
  it('renders base + includes + environment overlay with id-merged lists, deletes and a stable hash', async () => {
    const d = exampleTree();
    expect(await listEnvironments(d)).toEqual(['prod', 'staging']);
    const b = await renderConfigDir(d, 'prod');
    expect(b.schema).toBe('mcp-gateway/gitops-bundle@1');
    expect(b.env).toBe('prod');
    expect(b.files).toEqual(['servers.yml', 'base.yml', 'environments/_prod-policy.yml', 'environments/prod.yml']);
    const c = b.config as any; // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(c.include).toBeUndefined();
    expect(c.servers.map((s: { id: string }) => s.id)).toEqual(['github', 'files']);
    expect(c.servers[0]).toMatchObject({ id: 'github', url: 'https://api.example.com/mcp', timeoutMs: 20000, headers: { authorization: 'Bearer ${GITHUB_TOKEN}' } });
    expect(c.cache).toBeUndefined();
    expect(c.policy.default).toBe('deny');
    expect(c.rateLimit).toEqual({ windowSeconds: 60, limit: 100 });
    expect(b.configHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(configHash(JSON.parse(JSON.stringify(c)))).toBe(b.configHash);
    // key order does not change the hash
    const reordered = Object.fromEntries(Object.entries(c).reverse());
    expect(configHash(reordered)).toBe(b.configHash);
    const s = await renderConfigDir(d, 'staging');
    expect((s.config as any).rateLimit).toEqual({ windowSeconds: 60, limit: 1000 }); // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(s.configHash).not.toBe(b.configHash);
  });

  it('refuses unknown environments, includes outside the directory and include cycles', async () => {
    const d = exampleTree();
    await expect(renderConfigDir(d, 'qa')).rejects.toThrow(/unknown environment "qa".*prod, staging/);
    const t = tree({ 'base.yml': 'include: ["../outside.yml"]\n', 'environments/dev.yml': '{}\n' });
    await expect(renderConfigDir(t, 'dev')).rejects.toThrow(/outside the config directory/);
    const abs = tree({ 'base.yml': 'include: ["/etc/passwd"]\n', 'environments/dev.yml': '{}\n' });
    await expect(renderConfigDir(abs, 'dev')).rejects.toThrow(/outside the config directory|relative/);
    const cyc = tree({ 'base.yml': 'include: [a.yml]\n', 'a.yml': 'include: [b.yml]\n', 'b.yml': 'include: [a.yml]\n', 'environments/dev.yml': '{}\n' });
    await expect(renderConfigDir(cyc, 'dev')).rejects.toThrow(/include cycle/);
    await expect(renderConfigDir(tree({ 'environments/dev.yml': '{}\n' }), 'dev')).rejects.toThrow(/base\.yml/);
  });

  it('secrets by reference only: a literal secret anywhere is refused with its path', async () => {
    const bad = tree({
      'base.yml': `servers:\n  - { id: gh, name: gh, transport: http, url: "https://u:p@api.example.com/mcp", headers: { authorization: "Bearer ghp_literal" } }\nauth: { strategy: api-key, apiKeys: [ "plain-operator-key" ] }\n`,
      'environments/dev.yml': '{}\n',
    });
    const err = await renderConfigDir(bad, 'dev').catch((e) => e);
    expect(err).toBeInstanceOf(GitopsError);
    expect(err.message).toMatch(/secret/i);
    expect((err as GitopsError).issues.sort()).toEqual(['auth.apiKeys.0', 'servers.gh.headers.authorization', 'servers.gh.url'].sort());
    expect(err.message).not.toContain('ghp_literal');
    expect(err.message).not.toContain('plain-operator-key');
    expect(findSecretLiterals({ auth: { apiKeys: ['${K}', 'sha256:' + 'b'.repeat(64), { key: 'secret://vault/kv/op#key' }] }, servers: [{ id: 'x', env: { TOKEN: '${T}' } }] })).toEqual([]);
    // env / headers: secret-looking names must be references; other values (MODE, accept) may be literal
    expect(findSecretLiterals({ servers: [{ id: 'x', env: { GITHUB_TOKEN: 'abc', MODE: 'fast' }, headers: { accept: 'application/json', 'x-api-key': 'k' } }] })).toEqual(['servers.x.env.GITHUB_TOKEN', 'servers.x.headers.x-api-key']);
  });
});

describe('G2 env diff', () => {
  it('lists what differs between two environments, secrets left as references', async () => {
    const d = exampleTree();
    const changes = diffEnvironments(await renderConfigDir(d, 'staging'), await renderConfigDir(d, 'prod'));
    const paths = changes.map((c) => c.path);
    expect(paths).toEqual(expect.arrayContaining(['servers.github.timeoutMs', 'servers.scratch', 'policy', 'rateLimit', 'cache']));
    expect(changes.find((c) => c.path === 'servers.scratch')!.change).toBe('removed');
    expect(changes.find((c) => c.path === 'cache')!.change).toBe('removed');
    expect(JSON.stringify(changes)).not.toMatch(/GITHUB_TOKEN\}"?\s*$/); // values redacted like the admin diff
  });
});

describe('G3 signed release manifest', () => {
  const author = generateSigningKey();
  const alice = generateSigningKey();
  const bob = generateSigningKey();
  const mallory = generateSigningKey();
  const trust = {
    environment: 'prod',
    enforce: true,
    requiredApprovals: { prod: 2, '*': 0 },
    trustedKeys: [
      { id: 'author', name: 'carol', publicKey: author.publicKey, roles: ['author' as const] },
      { id: 'alice', name: 'alice', publicKey: alice.publicKey, roles: ['approver' as const] },
      { id: 'bob', name: 'bob', publicKey: bob.publicKey },
      { id: 'carol-approver', name: 'carol', publicKey: generateSigningKey().publicKey, roles: ['approver' as const] },
    ],
  };
  let bundle: Awaited<ReturnType<typeof renderConfigDir>>;
  beforeAll(async () => {
    bundle = await renderConfigDir(exampleTree(), 'prod');
  });
  const signed = (over: Partial<Parameters<typeof createReleaseManifest>[0]> = {}) =>
    createReleaseManifest({ bundle, gitSha: 'a'.repeat(40), author: 'carol', keyId: 'author', privateKeyPem: author.privateKeyPem, ...over });

  it('keys: ed25519, public key as ed25519:<base64>, private key PEM', () => {
    expect(author.publicKey).toMatch(/^ed25519:[A-Za-z0-9+/]{43}=$/);
    expect(author.privateKeyPem).toMatch(/BEGIN PRIVATE KEY/);
    expect(author.keyId).toMatch(/^[0-9a-f]{16}$/);
  });

  it('a manifest signed by a trusted author and approved by two other people verifies', () => {
    let m = signed();
    expect(m).toMatchObject({ schema: 'mcp-gateway/release-manifest@1', env: 'prod', configHash: bundle.configHash, gitSha: 'a'.repeat(40), author: 'carol', keyId: 'author' });
    expect(m.signature).toMatch(/^[A-Za-z0-9+/]+=*$/);
    expect(verifyRelease(m, bundle, trust)).toMatchObject({ ok: false, approvals: 0, required: 2 });
    m = approveRelease(m, { keyId: 'alice', privateKeyPem: alice.privateKeyPem, by: 'alice' });
    expect(verifyRelease(m, bundle, trust)).toMatchObject({ ok: false, approvals: 1, required: 2 });
    expect(verifyRelease(m, bundle, trust).reasons.join(' ')).toMatch(/1 of 2 approvals/);
    m = approveRelease(m, { keyId: 'bob', privateKeyPem: bob.privateKeyPem, by: 'bob' });
    const v = verifyRelease(m, bundle, trust);
    expect(v).toMatchObject({ ok: true, approvals: 2, required: 2, author: 'carol', approvers: ['alice', 'bob'] });
    expect(v.reasons).toEqual([]);
  });

  it('the author never counts as an approver; one approval per identity; untrusted / forged approvals do not count', () => {
    let m = signed();
    m = approveRelease(m, { keyId: 'carol-approver', privateKeyPem: generateSigningKey().privateKeyPem, by: 'carol' }); // wrong key → bad sig
    m = approveRelease(m, { keyId: 'alice', privateKeyPem: alice.privateKeyPem, by: 'alice' });
    m = approveRelease(m, { keyId: 'alice', privateKeyPem: alice.privateKeyPem, by: 'alice' });
    m = approveRelease(m, { keyId: 'mallory', privateKeyPem: mallory.privateKeyPem, by: 'mallory' });
    const v = verifyRelease(m, bundle, trust);
    expect(v.ok).toBe(false);
    expect(v.approvals).toBe(1);
    // a properly signed approval by the author's identity (other key) is still not counted
    const carolKey = generateSigningKey();
    const t2 = { ...trust, trustedKeys: trust.trustedKeys.map((k) => (k.id === 'carol-approver' ? { ...k, publicKey: carolKey.publicKey } : k)) };
    let m2 = signed();
    m2 = approveRelease(m2, { keyId: 'carol-approver', privateKeyPem: carolKey.privateKeyPem, by: 'carol' });
    m2 = approveRelease(m2, { keyId: 'alice', privateKeyPem: alice.privateKeyPem, by: 'alice' });
    expect(verifyRelease(m2, bundle, t2)).toMatchObject({ ok: false, approvals: 1 });
    expect(verifyRelease(m2, bundle, t2).reasons.join(' ')).toMatch(/author/);
  });

  it('refuses tampered content, wrong environment, untrusted or approver-only signers, expired and replayed manifests', async () => {
    const full = () => approveRelease(approveRelease(signed(), { keyId: 'alice', privateKeyPem: alice.privateKeyPem, by: 'alice' }), { keyId: 'bob', privateKeyPem: bob.privateKeyPem, by: 'bob' });
    const tampered = { ...bundle, config: { ...bundle.config, rateLimit: { windowSeconds: 60, limit: 1 } } };
    expect(verifyRelease(full(), tampered, trust).reasons.join(' ')).toMatch(/config hash/);
    const m = full();
    expect(verifyRelease({ ...m, gitSha: 'b'.repeat(40) }, bundle, trust).reasons.join(' ')).toMatch(/signature/);
    expect(verifyRelease(m, bundle, { ...trust, environment: 'staging' }).reasons.join(' ')).toMatch(/environment/);
    const staging = await renderConfigDir(exampleTree(), 'staging');
    expect(verifyRelease(m, staging, trust).ok).toBe(false);
    const byMallory = createReleaseManifest({ bundle, gitSha: 'c'.repeat(40), author: 'mallory', keyId: 'mallory', privateKeyPem: mallory.privateKeyPem });
    expect(verifyRelease(byMallory, bundle, trust).reasons.join(' ')).toMatch(/not a trusted/);
    const byAlice = createReleaseManifest({ bundle, gitSha: 'c'.repeat(40), author: 'alice', keyId: 'alice', privateKeyPem: alice.privateKeyPem });
    expect(verifyRelease(byAlice, bundle, trust).reasons.join(' ')).toMatch(/may not author/);
    const old = signed({ createdAt: new Date(Date.now() - 40 * 86_400_000).toISOString() });
    expect(verifyRelease(old, bundle, { ...trust, requiredApprovals: 0 }).reasons.join(' ')).toMatch(/older than/);
    const exp = signed({ expiresAt: new Date(Date.now() - 1000).toISOString() });
    expect(verifyRelease(exp, bundle, { ...trust, requiredApprovals: 0 }).reasons.join(' ')).toMatch(/expired/);
    const v = verifyRelease(m, bundle, trust, { lastApplied: { createdAt: new Date(Date.now() + 1000).toISOString(), configHash: 'sha256:x' } });
    expect(v.reasons.join(' ')).toMatch(/replay|older than the release/);
    // staging needs no approvals ('*': 0)
    const sm = createReleaseManifest({ bundle: staging, gitSha: 'd'.repeat(40), author: 'carol', keyId: 'author', privateKeyPem: author.privateKeyPem });
    expect(verifyRelease(sm, staging, { ...trust, environment: 'staging' })).toMatchObject({ ok: true, required: 0 });
  });
});

describe('G4 policy simulation', () => {
  it('replays calls against the candidate and explains every changed decision', () => {
    const current = {
      servers: [{ id: 'github' }, { id: 'scratch' }],
      auth: { strategy: 'api-key', apiKeys: [{ name: 'ci', key: 'x', scope: { servers: ['github', 'scratch'] } }] },
      policy: { default: 'allow', rules: [{ name: 'no-deletes', effect: 'deny', tools: ['*delete*'] }] },
    };
    const candidate = {
      servers: [{ id: 'github' }],
      auth: { strategy: 'api-key', apiKeys: [{ name: 'ci', key: 'x', scope: { servers: ['github'], tools: ['read_*', 'list_*'] } }] },
      policy: { default: 'deny', rules: [{ name: 'no-deletes', effect: 'deny', tools: ['*delete*'] }, { name: 'reads', effect: 'allow', tools: ['read_*', 'list_*', 'search_*'] }] },
    };
    const calls = [
      { clientId: 'ops', serverId: 'github', tool: 'read_file' }, // unchanged allow
      { clientId: 'ops', serverId: 'github', tool: 'create_issue' }, // allow → deny (default)
      { clientId: 'ops', serverId: 'github', tool: 'delete_repo' }, // unchanged deny
      { clientId: 'ops', serverId: 'scratch', tool: 'read_file' }, // server removed
      { clientId: 'ci', serverId: 'github', tool: 'search_code' }, // key scope narrowed (tools)
    ];
    const r = simulateRelease(current, candidate, calls, { source: 'sample' });
    expect(r).toMatchObject({ source: 'sample', calls: 5, unchanged: 2, changed: 3, transitions: { 'allow→deny': 3 } });
    const by = (t: string, s = 'github', c = 'ops') => r.changes.find((x) => x.call.tool === t && x.call.serverId === s && x.call.clientId === c)!;
    expect(by('create_issue').before).toMatchObject({ effect: 'allow', layer: 'policy' });
    expect(by('create_issue').after).toMatchObject({ effect: 'deny', layer: 'policy', rule: '(default)' });
    expect(by('create_issue').explanation).toMatch(/no rule matches.*default.*deny/i);
    expect(by('read_file', 'scratch').after).toMatchObject({ effect: 'deny', layer: 'server' });
    expect(by('read_file', 'scratch').explanation).toMatch(/server "scratch" is removed/);
    expect(by('search_code', 'github', 'ci').after).toMatchObject({ effect: 'deny', layer: 'scope' });
    expect(by('search_code', 'github', 'ci').explanation).toMatch(/key "ci".*tools/);
    expect(r.byClient.ops).toEqual({ changed: 2, newlyDenied: 2 });
  });
});

// ── HTTP ───────────────────────────────────────────────────────────────────────

const author = generateSigningKey();
const alice = generateSigningKey();
const bob = generateSigningKey();
const gitopsCfg = (over: Record<string, unknown> = {}) => ({
  environment: 'prod',
  enforce: true,
  requiredApprovals: { prod: 2 },
  driftCheckIntervalMs: 1000,
  trustedKeys: [
    { id: 'ci', name: 'release-bot', publicKey: author.publicKey, roles: ['author'] },
    { id: 'alice', name: 'alice', publicKey: alice.publicKey, roles: ['approver'] },
    { id: 'bob', name: 'bob', publicKey: bob.publicKey, roles: ['approver'] },
  ],
  ...over,
});

/** The bundle a CI job would render for this gateway: same servers / auth, changed rate limit, gitops block kept. */
function bundleFor(g: FeatureGw, limit: number, gitops = gitopsCfg()) {
  const cfg = {
    version: 13,
    servers: [{ id: 'fake', name: 'fake', transport: 'stdio', command: process.execPath, args: [resolve(__dirname, 'fixtures', 'fake-mcp-server.mjs')], timeoutMs: 5000 }],
    auth: { strategy: 'api-key', apiKeys: ['${GITOPS_TEST_OP_KEY}', { key: '${GITOPS_TEST_SCOPED_KEY}', scope: { servers: ['fake'] } }] },
    controlPlane: { configApi: true, gitops },
    rateLimit: { windowSeconds: 60, limit },
    monitor: { requestLog: true, prometheus: true },
    policy: { default: 'allow', rules: [{ name: 'no-deletes', effect: 'deny', tools: ['*delete*'] }] },
  };
  void g;
  return { schema: 'mcp-gateway/gitops-bundle@1', env: 'prod', config: cfg, configHash: configHash(cfg), files: ['base.yml'] };
}
const sign = (b: ReturnType<typeof bundleFor>, approvers: Array<'alice' | 'bob'>, at = new Date().toISOString()) => {
  let m = createReleaseManifest({ bundle: b as never, gitSha: 'f'.repeat(40), author: 'release-bot', keyId: 'ci', privateKeyPem: author.privateKeyPem, createdAt: at });
  for (const a of approvers) m = approveRelease(m, { keyId: a, privateKeyPem: (a === 'alice' ? alice : bob).privateKeyPem, by: a });
  return m;
};

describe('G5 HTTP: plan, apply, enforcement, drift, audit, metrics', () => {
  const stops: Array<() => Promise<void>> = [];
  afterEach(async () => {
    for (const s of stops.splice(0).reverse()) await s().catch(() => undefined);
  });
  process.env.GITOPS_TEST_OP_KEY = 'op';
  process.env.GITOPS_TEST_SCOPED_KEY = 'scoped';
  const start = async (gitops: Record<string, unknown> = gitopsCfg()) => {
    const g = await startFeatureGw({ controlPlane: { configApi: true, gitops }, rateLimit: { windowSeconds: 60, limit: 100 }, monitor: { requestLog: true, prometheus: true } } as unknown as Partial<GatewayConfig>);
    stops.push(g.stop);
    return g;
  };

  it('enforced: unsigned and under-approved bundles are refused (audited); the unmanaged config paths are closed', async () => {
    const g = await start();
    const st = await g.admin('gitops/status');
    expect(st.status).toBe(200);
    expect(st.body).toMatchObject({ configured: true, environment: 'prod', enforce: true, managed: false, release: null, requiredApprovals: 2 });

    const b = bundleFor(g, 200);
    const r1 = await g.admin('gitops/apply', { bundle: b });
    expect(r1.status, JSON.stringify(r1.body)).toBe(403);
    expect(r1.body.reason).toMatch(/unsigned/);
    const r2 = await g.admin('gitops/apply', { bundle: b, manifest: sign(b, ['alice']) });
    expect(r2.status).toBe(403);
    expect(r2.body.reason).toMatch(/1 of 2 approvals/);
    expect((g.gw as any).config.rateLimit).toMatchObject({ limit: 100 });

    const put = await g.admin('config', { ...b.config }, 'PUT');
    expect(put.status).toBe(409);
    expect(put.body.message).toMatch(/gitops/i);
    const dry = await g.admin('config?dryRun=true', { ...b.config }, 'PUT');
    expect(dry.status).toBe(200); // a dry run changes nothing and stays available
    const rl = await g.admin('reload', {}, 'POST');
    expect(rl.status).toBe(409);

    const hist = (await g.admin('gitops/status')).body.history as Array<{ action: string; result: string; reason?: string }>;
    expect(hist.filter((h) => h.action === 'apply' && h.result === 'refused')).toHaveLength(2);
  });

  it('plan shows changes, verification and policy simulation; a fully approved bundle applies; drift is detected', async () => {
    const g = await start();
    const b = bundleFor(g, 200);
    b.config.policy = { default: 'allow', rules: [{ name: 'no-deletes', effect: 'deny', tools: ['*delete*'] }, { name: 'no-echo', effect: 'deny', tools: ['echo'] }] };
    b.configHash = configHash(b.config);
    const m = sign(b, ['alice', 'bob']);
    const plan = await g.admin('gitops/plan', { bundle: b, manifest: m, calls: [{ clientId: 'op', serverId: 'fake', tool: 'echo' }, { clientId: 'op', serverId: 'fake', tool: 'add' }] });
    expect(plan.status).toBe(200);
    expect(plan.body.environment).toBe('prod');
    expect(plan.body.changes.map((c: { path: string }) => c.path)).toEqual(expect.arrayContaining(['rateLimit', 'policy']));
    expect(plan.body.verification).toMatchObject({ ok: true, approvals: 2, required: 2 });
    expect(plan.body.wouldApply).toBe(true);
    expect(plan.body.simulation).toMatchObject({ source: 'request', calls: 2, changed: 1, transitions: { 'allow→deny': 1 } });
    expect(plan.body.simulation.changes[0].explanation).toMatch(/no-echo/);

    const ap = await g.admin('gitops/apply', { bundle: b, manifest: m });
    expect(ap.status, JSON.stringify(ap.body)).toBe(200);
    expect(ap.body).toMatchObject({ applied: true, release: { env: 'prod', gitSha: 'f'.repeat(40), author: 'release-bot', approvers: ['alice', 'bob'], configHash: b.configHash } });
    expect((g.gw as any).config.rateLimit).toMatchObject({ limit: 200 });
    let st = (await g.admin('gitops/status')).body;
    expect(st).toMatchObject({ managed: true, drift: { drifted: false }, release: { gitSha: 'f'.repeat(40) } });

    // the same manifest again is a replay
    const again = await g.admin('gitops/apply', { bundle: b, manifest: m });
    expect(again.status).toBe(403);
    expect(again.body.reason).toMatch(/replay|older than the release/);

    // an out-of-band change (a file reload, a restart with another file) is drift
    await g.gw.reload({ ...(g.gw as any).config, rateLimit: { windowSeconds: 60, limit: 999 } } as GatewayConfig);
    st = (await g.admin('gitops/status')).body;
    expect(st.drift.drifted).toBe(true);
    expect(st.drift.changes.map((c: { path: string }) => c.path)).toContain('rateLimit');
    expect(st.history.some((h: { action: string }) => h.action === 'drift')).toBe(true);

    const metrics = await (await fetch(`${g.base}/metrics`, { headers: op })).text();
    expect(metrics).toMatch(/mcp_gateway_gitops_drift 1/);
    expect(metrics).toMatch(/mcp_gateway_gitops_applies_total\{result="applied"\} 1/);
    expect(metrics).toMatch(/mcp_gateway_gitops_applies_total\{result="refused"\} 1/);
    expect(metrics).toMatch(/mcp_gateway_gitops_release_info\{env="prod",git_sha="f{40}"\} 1/);

    // audit trail: apply + refusal + drift recorded as audit entries
    const recent = (g.gw as any).metrics.getRecent(100).filter((x) => x.serverId === '_gitops');
    expect(recent.map((x) => `${x.toolName}:${x.decision}`)).toEqual(expect.arrayContaining(['gitops.apply:applied', 'gitops.apply:refused', 'gitops.drift:drift']));
    expect(recent.find((x) => x.decision === 'applied')!.clientId).toBeTruthy();
  });

  it('refuses a bundle for another environment, secret literals and redacted placeholders', async () => {
    const g = await start(gitopsCfg({ enforce: false }));
    const b = bundleFor(g, 300, gitopsCfg({ enforce: false }));
    const other = { ...b, env: 'staging' };
    expect((await g.admin('gitops/apply', { bundle: other })).status).toBe(400);
    const lit = bundleFor(g, 300, gitopsCfg({ enforce: false }));
    (lit.config.auth.apiKeys as unknown[])[0] = 'op';
    lit.configHash = configHash(lit.config);
    const r = await g.admin('gitops/apply', { bundle: lit });
    expect(r.status).toBe(400);
    expect(r.body.message).toMatch(/secret.*auth\.apiKeys\.0/);
    const red = bundleFor(g, 300, gitopsCfg({ enforce: false }));
    (red.config as Record<string, unknown>).rateLimit = '<redacted>';
    red.configHash = configHash(red.config);
    expect((await g.admin('gitops/apply', { bundle: red })).status).toBe(400);
    const badHash = { ...bundleFor(g, 300, gitopsCfg({ enforce: false })), configHash: 'sha256:' + '0'.repeat(64) };
    expect((await g.admin('gitops/apply', { bundle: badHash })).status).toBe(400);
  });

  it('not enforced: unsigned bundles apply (marked unsigned); a manifest that is present must still verify', async () => {
    const g = await start(gitopsCfg({ enforce: false }));
    const b = bundleFor(g, 300, gitopsCfg({ enforce: false }));
    const r = await g.admin('gitops/apply', { bundle: b });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ applied: true, release: { signed: false } });
    const b2 = bundleFor(g, 400, gitopsCfg({ enforce: false }));
    const forged = { ...sign(b2, ['alice', 'bob']), configHash: 'sha256:' + '1'.repeat(64) };
    expect((await g.admin('gitops/apply', { bundle: b2, manifest: forged })).status).toBe(403);
    expect((g.gw as any).config.rateLimit).toMatchObject({ limit: 300 });
    // PUT /admin/config works when not enforced
    expect((await g.admin('config', { ...b2.config }, 'PUT')).status).toBe(200);
  });

  it('gitops routes are operator-only and say when gitops is not configured', async () => {
    const g = await startFeatureGw({ controlPlane: { configApi: true } } as unknown as Partial<GatewayConfig>);
    stops.push(g.stop);
    expect((await g.admin('gitops/status')).body).toMatchObject({ configured: false });
    expect((await g.admin('gitops/apply', { bundle: {} })).status).toBe(409);
    const scoped = await fetch(`${g.base}/api/v1/admin/gitops/status`, { headers: { authorization: 'Bearer scoped' } });
    expect(scoped.status).toBe(403);
  });
});

describe('G6 config + schema', () => {
  it('validates controlPlane.gitops', () => {
    const ok = validateConfig({ controlPlane: { gitops: gitopsCfg() } });
    expect(ok.controlPlane?.gitops).toMatchObject({ environment: 'prod', enforce: true });
    expect(() => validateConfig({ controlPlane: { gitops: { environment: 'prod', enforce: true } } })).toThrow(/trustedKeys/);
    expect(() => validateConfig({ controlPlane: { gitops: { environment: 'prod', trustedKeys: [{ id: 'a', name: 'a', publicKey: 'nope' }] } } })).toThrow(/publicKey/);
    expect(() => validateConfig({ controlPlane: { role: 'data', url: 'http://cp:4000', token: 't', gitops: { environment: 'prod' } } })).toThrow(/control/);
    const d = validateConfig({ controlPlane: { gitops: { environment: 'production' } } });
    expect(d.controlPlane?.gitops).toMatchObject({ enforce: false });
  });
  it('schema v12 describes controlPlane.gitops', () => {
    const s = buildV12ConfigSchema() as any; // eslint-disable-line @typescript-eslint/no-explicit-any
    const cp = JSON.stringify(s);
    expect(cp.includes('NEW in 14.7'), 'schema v12 mentions 14.7').toBe(true);
    expect(cp.includes('requiredApprovals')).toBe(true);
    const committed = JSON.parse(readFileSync(resolve(__dirname, '..', 'schema', 'v12', 'config.schema.json'), 'utf8'));
    expect(JSON.stringify(committed).includes('trustedKeys'), 'committed schema regenerated').toBe(true);
  });
});

const cli = (args: string[], env: Record<string, string> = {}) =>
  new Promise<{ code: number | null; out: string; err: string }>((res) => {
    const p = spawn(process.execPath, ['--import', 'tsx', CLI, ...args], { cwd: resolve(__dirname, '..'), env: { ...process.env, MCP_GATEWAY_URL: '', MCP_GATEWAY_ADMIN_KEY: '', ...env } });
    let out = '';
    let err = '';
    p.stdout.on('data', (c) => (out += c));
    p.stderr.on('data', (c) => (err += c));
    p.on('close', (code) => res({ code, out, err }));
  });

describe('G7 CLI', () => {
  const stops: Array<() => Promise<void>> = [];
  afterEach(async () => {
    for (const s of stops.splice(0).reverse()) await s().catch(() => undefined);
  });

  it('render, diff between environments, keygen, sign, approve, verify', async () => {
    const d = exampleTree();
    const r = await cli(['gitops', 'render', '-d', d, '-e', 'prod', '--json']);
    expect(r.code, r.err).toBe(0);
    expect(JSON.parse(r.out)).toMatchObject({ env: 'prod', configHash: (await renderConfigDir(d, 'prod')).configHash });
    const df = await cli(['gitops', 'diff', '-d', d, '-e', 'staging', '--against-env', 'prod']);
    expect(df.code, df.err).toBe(3);
    expect(df.out).toMatch(/- servers\.scratch/);
    const dj = await cli(['gitops', 'diff', '-d', d, '-e', 'prod', '--against-env', 'prod', '--json']);
    expect(dj.code).toBe(0);
    expect(JSON.parse(dj.out).changes).toEqual([]);

    const keys = mkdtempSync(join(tmpdir(), 'gitops-keys-'));
    const kg = await cli(['gitops', 'keygen', '--out', join(keys, 'author'), '--json']);
    expect(kg.code, kg.err).toBe(0);
    const pub = JSON.parse(kg.out);
    expect(pub.publicKey).toMatch(/^ed25519:/);
    expect(statSync(join(keys, 'author.key')).mode & 0o777).toBe(0o600);
    const ap = await cli(['gitops', 'keygen', '--out', join(keys, 'alice'), '--json']);
    const apub = JSON.parse(ap.out);
    const man = join(keys, 'release.json');
    const s = await cli(['gitops', 'sign', '-d', d, '-e', 'prod', '--key', join(keys, 'author.key'), '--key-id', 'author', '--author', 'carol', '--git-sha', 'e'.repeat(40), '-o', man]);
    expect(s.code, s.err).toBe(0);
    expect(JSON.parse(readFileSync(man, 'utf8'))).toMatchObject({ env: 'prod', author: 'carol', gitSha: 'e'.repeat(40) });
    const a = await cli(['gitops', 'approve', man, '--key', join(keys, 'alice.key'), '--key-id', 'alice', '--by', 'alice']);
    expect(a.code, a.err).toBe(0);
    const trust = join(keys, 'gateway.yml');
    writeFileSync(trust, `controlPlane:\n  gitops:\n    environment: prod\n    enforce: true\n    requiredApprovals: { prod: 1 }\n    trustedKeys:\n      - { id: author, name: carol, publicKey: "${pub.publicKey}", roles: [author] }\n      - { id: alice, name: alice, publicKey: "${apub.publicKey}", roles: [approver] }\n`);
    const v = await cli(['gitops', 'verify', man, '-d', d, '-e', 'prod', '--trust', trust]);
    expect(v.code, v.out + v.err).toBe(0);
    expect(v.out).toMatch(/✓ .*1\/1 approvals/);
    writeFileSync(trust, readFileSync(trust, 'utf8').replace('prod: 1', 'prod: 2'));
    const v2 = await cli(['gitops', 'verify', man, '-d', d, '-e', 'prod', '--trust', trust, '--json']);
    expect(v2.code).toBe(1);
    expect(JSON.parse(v2.out)).toMatchObject({ ok: false, approvals: 1, required: 2 });
  }, 60_000);

  it('plan, apply and status against a running gateway', async () => {
    process.env.GITOPS_TEST_OP_KEY = 'op';
    process.env.GITOPS_TEST_SCOPED_KEY = 'scoped';
    const g = await startFeatureGw({ controlPlane: { configApi: true, gitops: gitopsCfg({ requiredApprovals: { prod: 1 } }) }, rateLimit: { windowSeconds: 60, limit: 100 } } as unknown as Partial<GatewayConfig>);
    stops.push(g.stop);
    const fakePath = resolve(__dirname, 'fixtures', 'fake-mcp-server.mjs');
    const d = tree({
      'base.yml': `version: 13\nservers:\n  - { id: fake, name: fake, transport: stdio, command: "${process.execPath}", args: ["${fakePath}"], timeoutMs: 5000 }\nauth:\n  strategy: api-key\n  apiKeys: ["\${GITOPS_TEST_OP_KEY}", { key: "\${GITOPS_TEST_SCOPED_KEY}", scope: { servers: [fake] } }]\nrateLimit: { windowSeconds: 60, limit: 50 }\n`,
      'environments/prod.yml': `controlPlane:\n  configApi: true\n  gitops:\n    environment: prod\n    enforce: true\n    requiredApprovals: { prod: 1 }\n    driftCheckIntervalMs: 1000\n    trustedKeys:\n${gitopsCfg().trustedKeys.map((k) => `      - { id: ${k.id}, name: ${k.name}, publicKey: "${k.publicKey}", roles: [${k.roles.join(', ')}] }`).join('\n')}\n`,
    });
    const keys = mkdtempSync(join(tmpdir(), 'gitops-k-'));
    writeFileSync(join(keys, 'ci.key'), author.privateKeyPem, { mode: 0o600 });
    writeFileSync(join(keys, 'alice.key'), alice.privateKeyPem, { mode: 0o600 });
    const remote = ['--url', g.base, '--key', 'op'];
    const plan = await cli(['gitops', 'plan', '-d', d, '-e', 'prod', ...remote]);
    expect(plan.code, plan.err).toBe(3);
    expect(plan.out).toMatch(/~ rateLimit/);
    expect(plan.out).toMatch(/unsigned/i);
    const unsigned = await cli(['gitops', 'apply', '-d', d, '-e', 'prod', ...remote]);
    expect(unsigned.code).toBe(1);
    expect(unsigned.err + unsigned.out).toMatch(/unsigned/);
    const man = join(keys, 'm.json');
    expect((await cli(['gitops', 'sign', '-d', d, '-e', 'prod', '--key', join(keys, 'ci.key'), '--key-id', 'ci', '--author', 'release-bot', '--git-sha', '1'.repeat(40), '-o', man])).code).toBe(0);
    expect((await cli(['gitops', 'approve', man, '--key', join(keys, 'alice.key'), '--key-id', 'alice', '--by', 'alice'])).code).toBe(0);
    const pj = await cli(['gitops', 'plan', '-d', d, '-e', 'prod', '--manifest', man, '--json', ...remote]);
    expect(JSON.parse(pj.out)).toMatchObject({ wouldApply: true, verification: { ok: true } });
    const ap = await cli(['gitops', 'apply', '-d', d, '-e', 'prod', '--manifest', man, ...remote]);
    expect(ap.code, ap.err + ap.out).toBe(0);
    expect(ap.out).toMatch(/✓ Applied release 1{40}/);
    expect((g.gw as any).config.rateLimit).toMatchObject({ limit: 50 });
    const st = await cli(['gitops', 'status', ...remote]);
    expect(st.code, st.out).toBe(0);
    expect(st.out).toMatch(/in sync/);
    await g.gw.reload({ ...(g.gw as any).config, rateLimit: { windowSeconds: 60, limit: 51 } } as GatewayConfig);
    const st2 = await cli(['gitops', 'status', '--json', ...remote]);
    expect(st2.code).toBe(2);
    expect(JSON.parse(st2.out).drift.drifted).toBe(true);
  }, 90_000);
});

describe('G8 examples/gitops', () => {
  const ex = resolve(__dirname, '..', 'examples', 'gitops');
  it('the example config directory renders for staging and prod without secret literals', async () => {
    expect(existsSync(join(ex, 'config', 'base.yml'))).toBe(true);
    const envs = await listEnvironments(join(ex, 'config'));
    expect(envs).toEqual(expect.arrayContaining(['staging', 'prod']));
    for (const e of envs) {
      const b = await renderConfigDir(join(ex, 'config'), e);
      expect(findSecretLiterals(b.config)).toEqual([]);
      const placeholder = JSON.parse(JSON.stringify(b.config).replace(/\$\{([A-Z0-9_]+)\}/g, (_m, n: string) => `placeholder-${n.toLowerCase()}-0123456789abcdef`));
      expect(() => validateConfig(placeholder)).not.toThrow();
    }
  });
  it('the GitHub Actions workflow plans on pull requests and applies signed releases on main', () => {
    const wf = parseYaml(readFileSync(join(ex, 'workflow.yml'), 'utf8'));
    const text = readFileSync(join(ex, 'workflow.yml'), 'utf8');
    expect(Object.keys(wf.on)).toEqual(expect.arrayContaining(['pull_request', 'push']));
    expect(text).toMatch(/mcp-gateway gitops plan/);
    expect(text).toMatch(/mcp-gateway gitops apply/);
    expect(text).toMatch(/mcp-gateway gitops verify/);
    expect(text).toMatch(/secrets\.MCP_GATEWAY_ADMIN_KEY/);
    expect(text).not.toMatch(/BEGIN PRIVATE KEY/);
  });
});
