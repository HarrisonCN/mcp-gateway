/**
 * GitOps (14.7.0): declarative config directories, environment diffs, signed release manifests and release
 * policy simulation. Pure functions — no gateway needed — shared by the CLI (`mcp-gateway gitops …`) and the gateway's
 * `/api/v1/admin/gitops` routes ({@link module:gateway/gitops}).
 *
 * **Config directory.**
 *
 * ```
 * config/
 *   base.yml                 # shared by every environment (required)
 *   servers.yml              # pulled in with `include: [servers.yml]`
 *   environments/
 *     staging.yml            # overlay for `staging`
 *     prod.yml               # overlay for `prod`
 *     _prod-policy.yml       # a partial (leading `_`): never an environment, only included
 * ```
 *
 * `render(dir, env)` = base.yml (its includes first, then the file) merged with environments/<env>.yml (its includes
 * first, then the file). Mappings merge deeply; lists whose entries all carry an `id` (servers, peers, …) merge by id
 * — an overlay entry `{ id: x, $delete: true }` removes it — and any other list is replaced; `key: null` removes a key.
 * Includes are relative to the including file and must stay inside the directory (symlinks resolved); cycles are refused.
 * `policy.files` are inlined so the rendered bundle is self-contained.
 *
 * **Secrets by reference only.** A secret field (`apiKeys`, `key`, `token`, `password`, `authorization`, …, secret-named
 * `env` / `headers` entries, URLs with credentials) must hold a `${ENV_VAR}` or `secret://provider/path` reference, or
 * a `sha256:` key hash — a literal is refused (its path is reported, never its value).
 *
 * **Release manifest** (`mcp-gateway/release-manifest@1`): environment, config hash, git sha, author and the author's
 * ed25519 signature, plus approvals (each an ed25519 signature by an approver over the same release). A gateway trusts
 * keys listed in `controlPlane.gitops.trustedKeys` and requires `requiredApprovals` distinct approvers (never the author).
 *
 * @module config/gitops
 */

import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign as edSign, verify as edVerify, type KeyObject } from 'crypto';
import { existsSync, realpathSync } from 'fs';
import { readFile, readdir } from 'fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'path';
import { z } from 'zod';
import { diffConfigs, urlHasSecret, type ConfigChange } from './diff.js';
import { yaml } from '../utils/lazy.js';
import { evaluatePolicy } from '../policy/tool-policy.js';
import { globMatch } from '../utils/tool-filter.js';
import type { ToolPolicyConfig } from '../utils/types.js';

export const BUNDLE_SCHEMA = 'mcp-gateway/gitops-bundle@1';
export const MANIFEST_SCHEMA = 'mcp-gateway/release-manifest@1';

/** A config error that lists the offending paths (`issues`). */
export class GitopsError extends Error {
  constructor(
    message: string,
    readonly issues: string[] = [],
  ) {
    super(message);
    this.name = 'GitopsError';
  }
}

export interface GitopsBundle {
  schema: typeof BUNDLE_SCHEMA;
  env: string;
  /** The rendered config (schema form, secrets as references). */
  config: Record<string, unknown>;
  /** `sha256:<hex>` of the canonical JSON of `config`. */
  configHash: string;
  /** Files read, relative to the directory, in merge order. */
  files: string[];
}

// ── canonical JSON + hash ──────────────────────────────────────────────────────

/** Canonical JSON: object keys sorted recursively, arrays in order, no whitespace. */
export function canonicalJson(v: unknown): string {
  return JSON.stringify(v, (_k, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.entries(x as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) : x));
}

/** `sha256:<hex>` of the canonical JSON of a config. */
export function configHash(config: unknown): string {
  return `sha256:${createHash('sha256').update(canonicalJson(config)).digest('hex')}`;
}

// ── merge ──────────────────────────────────────────────────────────────────────

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const hasId = (v: unknown): v is Record<string, unknown> & { id: unknown } => isObj(v) && v.id !== undefined;
const stripDelete = (v: unknown): unknown => {
  if (Array.isArray(v)) return v.filter((x) => !(isObj(x) && x.$delete === true)).map(stripDelete);
  if (isObj(v)) return Object.fromEntries(Object.entries(v).filter(([k, x]) => k !== '$delete' && x !== null).map(([k, x]) => [k, stripDelete(x)]));
  return v;
};

/**
 * Overlay `over` on `base` (see the module doc for the rules). `keep` composes two overlays: deletions (`null`,
 * `$delete`) are kept as markers so they still apply to the layer below; the final merge resolves and strips them.
 */
export function mergeConfig(base: unknown, over: unknown, keep = false): unknown {
  if (over === undefined) return base;
  const fin = (v: unknown) => (keep ? v : stripDelete(v));
  if (isObj(base) && isObj(over)) {
    const out: Record<string, unknown> = { ...base };
    for (const [k, v] of Object.entries(over)) {
      if (k === '$delete') continue;
      if (v === null) {
        if (keep) out[k] = null;
        else delete out[k];
      } else out[k] = k in out && out[k] !== null ? mergeConfig(out[k], v, keep) : fin(v);
    }
    return out;
  }
  if (Array.isArray(base) && Array.isArray(over) && over.length > 0 && over.every(hasId) && base.every(hasId)) {
    const out = base.map((x) => x as Record<string, unknown>);
    for (const o of over) {
      const i = out.findIndex((b) => b.id === o.id);
      if (o.$delete === true && !keep) {
        if (i >= 0) out.splice(i, 1);
      } else if (o.$delete === true) {
        if (i >= 0) out[i] = o;
        else out.push(o);
      } else if (i >= 0) out[i] = mergeConfig(out[i], o, keep) as Record<string, unknown>;
      else out.push(fin(o) as Record<string, unknown>);
    }
    return out;
  }
  return fin(over);
}

// ── secrets by reference ───────────────────────────────────────────────────────

const SECRET_KEY = /^(apiKeys?|key|secret|password|passwd|token|clientSecret|signingKey|authorization|webhookSecret|jwtSecret|privateKey|accessToken|refreshToken|bearerToken|cookie)$/i;
const SECRET_SUFFIX = /(secret|password|passwd|token)$/i;
/** `env` / `headers` entries whose name looks secret. */
const SECRET_ENTRY = /(token|secret|passw|pwd|key|auth|credential|cookie|session|signature)/i;
const REF = /\$\{[A-Za-z_][A-Za-z0-9_]*\}|secret:\/\/[A-Za-z0-9_-]+\/\S+/;
const KEY_HASH = /^sha256:[0-9a-fA-F]{64}$/;

/** Whether a string is a secret reference (or a key hash) rather than a secret value. */
export const isSecretReference = (s: string): boolean => REF.test(s) || KEY_HASH.test(s);

/** Paths of literal secrets in a config (servers and other id lists by id, other lists by index). */
export function findSecretLiterals(config: unknown): string[] {
  const out: string[] = [];
  const bad = (v: unknown) => typeof v === 'string' && v.length > 0 && !isSecretReference(v);
  const walk = (v: unknown, path: string[], secretIn: boolean) => {
    let secret = secretIn;
    const p = path.join('.');
    if (typeof v === 'string') {
      const key = path[path.length - 1] ?? '';
      if ((secret || (/url$/i.test(key) && urlHasSecret(v))) && bad(v)) out.push(p);
      return;
    }
    if (Array.isArray(v)) {
      v.forEach((x, i) => walk(x, [...path, hasId(x) ? String(x.id) : String(i)], secret));
      return;
    }
    if (!isObj(v)) return;
    // a secret key marks its string values (and lists of strings) — an object under it (apiKeys: [{ name, key }]) is
    // checked field by field
    secret = false;
    const parent = path[path.length - 1] ?? '';
    const isMap = /^(env|headers)$/.test(parent);
    for (const [k, x] of Object.entries(v)) {
      const s = secret || (isMap ? SECRET_ENTRY.test(k) : SECRET_KEY.test(k) || (SECRET_SUFFIX.test(k) && typeof x === 'string'));
      walk(x, [...path, k], s);
    }
  };
  walk(config, [], false);
  return out;
}

// ── config directory ───────────────────────────────────────────────────────────

const ENV_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const YAML_EXT = ['.yml', '.yaml'];

async function readDoc(path: string, label: string): Promise<Record<string, unknown>> {
  const text = await readFile(path, 'utf8');
  let doc: unknown;
  try {
    doc = path.endsWith('.json') ? JSON.parse(text) : (await yaml()).parse(text);
  } catch (err) {
    throw new GitopsError(`${label}: ${err instanceof Error ? err.message : String(err)}`, [label]);
  }
  if (doc === null || doc === undefined) return {};
  if (!isObj(doc)) throw new GitopsError(`${label} must contain a mapping at the top level`, [label]);
  return doc;
}

/** Environment names of a config directory (`environments/<name>.yml`, partials starting with `_` excluded). */
export async function listEnvironments(dir: string): Promise<string[]> {
  const envDir = join(dir, 'environments');
  if (!existsSync(envDir)) return [];
  const names = (await readdir(envDir)).filter((f) => YAML_EXT.some((e) => f.endsWith(e)) && !f.startsWith('_') && !f.startsWith('.'));
  return [...new Set(names.map((f) => f.replace(/\.ya?ml$/, '')).filter((n) => ENV_NAME.test(n)))].sort();
}

const findFile = (base: string): string | undefined => YAML_EXT.map((e) => base + e).find((p) => existsSync(p));

/** Render `<dir>` for one environment into a self-contained bundle (see the module doc). */
export async function renderConfigDir(dir: string, env: string): Promise<GitopsBundle> {
  const root = realpathSync(resolve(dir));
  if (!ENV_NAME.test(env)) throw new GitopsError(`invalid environment name "${env}"`);
  const basePath = findFile(join(root, 'base'));
  if (!basePath) throw new GitopsError(`${dir}: no base.yml (the shared config every environment starts from)`);
  const overlayPath = findFile(join(root, 'environments', env));
  if (!overlayPath) {
    const envs = await listEnvironments(root);
    throw new GitopsError(`unknown environment "${env}" (environments/${env}.yml not found; known: ${envs.join(', ') || 'none'})`);
  }
  const files: string[] = [];
  const rel = (p: string) => relative(root, p).split(sep).join('/');
  const load = async (path: string, stack: string[]): Promise<Record<string, unknown>> => {
    const real = realpathSync(path);
    if (real !== root && !real.startsWith(root + sep)) throw new GitopsError(`${rel(path)} resolves outside the config directory`, [rel(path)]);
    if (stack.includes(real)) throw new GitopsError(`include cycle: ${[...stack, real].map(rel).join(' → ')}`, [rel(path)]);
    const doc = await readDoc(real, rel(real));
    const inc = doc.include;
    delete doc.include;
    let acc: unknown = {};
    if (inc !== undefined) {
      const list = typeof inc === 'string' ? [inc] : inc;
      if (!Array.isArray(list) || !list.every((x) => typeof x === 'string' && x.length > 0)) throw new GitopsError(`${rel(real)}: include must be a file name or a list of file names`, [rel(real)]);
      for (const f of list as string[]) {
        if (isAbsolute(f)) throw new GitopsError(`${rel(real)}: include "${f}" must be relative (it is outside the config directory)`, [rel(real)]);
        const target = resolve(dirname(real), f);
        if (target !== root && !target.startsWith(root + sep)) throw new GitopsError(`${rel(real)}: include "${f}" is outside the config directory`, [rel(real)]);
        if (!existsSync(target)) throw new GitopsError(`${rel(real)}: include "${f}" not found`, [rel(real)]);
        acc = mergeConfig(acc, await load(target, [...stack, real]), true);
      }
    }
    files.push(rel(real));
    return mergeConfig(acc, doc, true) as Record<string, unknown>;
  };
  let config = mergeConfig(await load(basePath, []), await load(overlayPath, [])) as Record<string, unknown>;
  config = stripDelete(config) as Record<string, unknown>;
  // policy.files are inlined: the bundle carries everything the gateway needs
  const pol = config.policy;
  if (isObj(pol) && Array.isArray(pol.files) && pol.files.length) {
    const rules = [...((pol.rules as unknown[]) ?? [])];
    const tests = [...((pol.tests as unknown[]) ?? [])];
    let def = pol.default;
    for (const f of pol.files as unknown[]) {
      if (typeof f !== 'string' || isAbsolute(f)) throw new GitopsError(`policy.files: "${String(f)}" must be a relative path`, ['policy.files']);
      const target = resolve(root, f);
      if (!existsSync(target) || !realpathSync(target).startsWith(root + sep)) throw new GitopsError(`policy.files: "${f}" is missing or outside the config directory`, ['policy.files']);
      const doc = await readDoc(realpathSync(target), f);
      rules.push(...((doc.rules as unknown[]) ?? []));
      tests.push(...((doc.tests as unknown[]) ?? []));
      if (pol.default === undefined && doc.default !== undefined) def = doc.default;
      files.push(rel(realpathSync(target)));
    }
    const { files: _f, ...rest } = pol;
    config.policy = { ...rest, rules, ...(tests.length ? { tests } : {}), ...(def !== undefined ? { default: def } : {}) };
  }
  const literals = findSecretLiterals(config);
  if (literals.length) throw new GitopsError(`secrets must be references (\${ENV_VAR} or secret://…), literal secret at: ${literals.join(', ')}`, literals);
  return { schema: BUNDLE_SCHEMA, env, config, configHash: configHash(config), files };
}

/** Structural diff between two rendered environments (`a` → `b`), secret fields redacted like the admin diff. */
export function diffEnvironments(a: Pick<GitopsBundle, 'config'>, b: Pick<GitopsBundle, 'config'>): ConfigChange[] {
  return diffConfigs(a.config as never, b.config as never);
}

// ── keys + signatures ──────────────────────────────────────────────────────────

export interface SigningKey {
  /** `ed25519:<base64 raw public key>` — put it in `trustedKeys[].publicKey`. */
  publicKey: string;
  /** PKCS#8 PEM. Keep it secret (CI secret, KMS, hardware key). */
  privateKeyPem: string;
  /** Fingerprint: first 16 hex chars of sha256(raw public key). */
  keyId: string;
}

const rawPublic = (k: KeyObject): Buffer => Buffer.from((k.export({ format: 'jwk' }) as { x: string }).x, 'base64url');

export function generateSigningKey(): SigningKey {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const raw = rawPublic(publicKey);
  return { publicKey: `ed25519:${raw.toString('base64')}`, privateKeyPem: privateKey.export({ format: 'pem', type: 'pkcs8' }) as string, keyId: createHash('sha256').update(raw).digest('hex').slice(0, 16) };
}

/** Parse `ed25519:<base64>` or an SPKI PEM; throws when it is not an ed25519 public key. */
export function parsePublicKey(s: string): KeyObject {
  let k: KeyObject;
  if (s.startsWith('ed25519:')) {
    const raw = Buffer.from(s.slice(8), 'base64');
    if (raw.length !== 32) throw new Error('an ed25519 public key is 32 bytes');
    k = createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: raw.toString('base64url') }, format: 'jwk' });
  } else k = createPublicKey(s);
  if (k.asymmetricKeyType !== 'ed25519') throw new Error(`not an ed25519 key (${k.asymmetricKeyType})`);
  return k;
}

/** Public key (`ed25519:<base64>`) of a private key PEM. */
export const publicKeyOf = (privateKeyPem: string): string => `ed25519:${rawPublic(createPublicKey(createPrivateKey(privateKeyPem))).toString('base64')}`;

// ── release manifest ───────────────────────────────────────────────────────────

export interface ReleaseApproval {
  keyId: string;
  by: string;
  at: string;
  signature: string;
}

export interface ReleaseManifest {
  schema: typeof MANIFEST_SCHEMA;
  env: string;
  configHash: string;
  gitSha: string;
  author: string;
  keyId: string;
  createdAt: string;
  expiresAt?: string;
  files?: string[];
  signature: string;
  approvals: ReleaseApproval[];
}

const signedFields = (m: Pick<ReleaseManifest, 'env' | 'configHash' | 'gitSha' | 'author' | 'keyId' | 'createdAt' | 'expiresAt'>) =>
  canonicalJson({ schema: MANIFEST_SCHEMA, env: m.env, configHash: m.configHash, gitSha: m.gitSha, author: m.author, keyId: m.keyId, createdAt: m.createdAt, ...(m.expiresAt ? { expiresAt: m.expiresAt } : {}) });
const releaseMessage = (m: Parameters<typeof signedFields>[0]) => Buffer.from(`mcp-gateway-release\n${signedFields(m)}`);
const approvalMessage = (m: Parameters<typeof signedFields>[0], a: Pick<ReleaseApproval, 'keyId' | 'by' | 'at'>) => Buffer.from(`mcp-gateway-approve\n${signedFields(m)}\n${canonicalJson({ keyId: a.keyId, by: a.by, at: a.at })}`);

export interface CreateReleaseOptions {
  bundle: Pick<GitopsBundle, 'env' | 'config' | 'files'>;
  gitSha: string;
  author: string;
  keyId: string;
  privateKeyPem: string;
  createdAt?: string;
  expiresAt?: string;
}

/** A release manifest for a rendered bundle, signed by its author. */
export function createReleaseManifest(o: CreateReleaseOptions): ReleaseManifest {
  const base = { env: o.bundle.env, configHash: configHash(o.bundle.config), gitSha: o.gitSha, author: o.author, keyId: o.keyId, createdAt: o.createdAt ?? new Date().toISOString(), ...(o.expiresAt ? { expiresAt: o.expiresAt } : {}) };
  const signature = edSign(null, releaseMessage(base), createPrivateKey(o.privateKeyPem)).toString('base64');
  return { schema: MANIFEST_SCHEMA, ...base, ...(o.bundle.files ? { files: o.bundle.files } : {}), signature, approvals: [] };
}

/** Add an approval (ed25519 signature over the release) to a manifest; returns a new manifest. */
export function approveRelease(m: ReleaseManifest, o: { keyId: string; privateKeyPem: string; by: string; at?: string }): ReleaseManifest {
  const a = { keyId: o.keyId, by: o.by, at: o.at ?? new Date().toISOString() };
  const signature = edSign(null, approvalMessage(m, a), createPrivateKey(o.privateKeyPem)).toString('base64');
  return { ...m, approvals: [...(m.approvals ?? []), { ...a, signature }] };
}

// ── trust config (controlPlane.gitops) ─────────────────────────────────────────

export const TrustedKeySchema = z
  .object({
    id: z.string().min(1).max(128),
    name: z.string().min(1).max(200),
    publicKey: z.string().min(1).refine(
      (s) => {
        try {
          parsePublicKey(s);
          return true;
        } catch {
          return false;
        }
      },
      { message: 'publicKey must be an ed25519 public key (ed25519:<base64> or SPKI PEM)' },
    ),
    roles: z.array(z.enum(['author', 'approver'])).min(1).default(['author', 'approver']),
  })
  .strict();

export const GitopsSchema = z
  .object({
    environment: z.string().regex(ENV_NAME, 'letters, digits, - and _'),
    enforce: z.boolean().default(false),
    trustedKeys: z.array(TrustedKeySchema).max(100).default([]),
    requiredApprovals: z.union([z.number().int().min(0).max(20), z.record(z.string(), z.number().int().min(0).max(20))]).optional(),
    maxManifestAgeSeconds: z.number().int().min(60).max(31_536_000).default(2_592_000),
    driftCheckIntervalMs: z.number().int().min(1000).max(86_400_000).default(60_000),
    recordFile: z.string().min(1).optional(),
  })
  .strict()
  .superRefine((g, ctx) => {
    if (g.enforce && g.trustedKeys.length === 0) ctx.addIssue({ code: 'custom', path: ['trustedKeys'], message: 'enforce: true needs at least one trusted key (trustedKeys)' });
    const ids = new Set<string>();
    g.trustedKeys.forEach((k, i) => {
      if (ids.has(k.id)) ctx.addIssue({ code: 'custom', path: ['trustedKeys', i, 'id'], message: `duplicate key id "${k.id}"` });
      ids.add(k.id);
    });
  });

export type GitopsConfig = z.input<typeof GitopsSchema>;
export type TrustedKey = z.input<typeof TrustedKeySchema>;

/** Approvals required for an environment: `requiredApprovals` (number, or per environment with `*` as fallback); default 2 for prod / production, else 0. */
export function requiredApprovalsFor(trust: Pick<GitopsConfig, 'requiredApprovals'>, env: string): number {
  const r = trust.requiredApprovals;
  if (typeof r === 'number') return r;
  if (r && r[env] !== undefined) return r[env]!;
  if (r && r['*'] !== undefined) return r['*']!;
  return /^prod(uction)?$/i.test(env) ? 2 : 0;
}

export interface VerifyResult {
  ok: boolean;
  /** Why it does not verify (empty when ok), plus approvals that were ignored. */
  reasons: string[];
  approvals: number;
  required: number;
  /** Trusted name of the author key. */
  author?: string;
  approvers: string[];
  env: string;
  configHash: string;
  gitSha: string;
}

/**
 * Verify a release manifest for a bundle against a trust config: schema, environment, config hash, the author's key
 * (trusted, role `author`) and signature, age / expiry, replay (must be newer than `lastApplied`), and the approvals
 * (trusted `approver` keys, valid signatures, distinct identities, never the author's identity) against
 * {@link requiredApprovalsFor}.
 */
export function verifyRelease(
  m: ReleaseManifest,
  bundle: Pick<GitopsBundle, 'env' | 'config'>,
  trust: GitopsConfig,
  opts: { now?: number; lastApplied?: { createdAt: string; configHash: string } } = {},
): VerifyResult {
  const now = opts.now ?? Date.now();
  const block: string[] = [];
  const ignored: string[] = [];
  const env = typeof m?.env === 'string' ? m.env : '';
  const required = requiredApprovalsFor(trust, env || trust.environment);
  const res = (author?: string, approvers: string[] = []): VerifyResult => ({ ok: block.length === 0, reasons: [...block, ...ignored], approvals: approvers.length, required, author, approvers, env, configHash: String(m?.configHash ?? ''), gitSha: String(m?.gitSha ?? '') });
  if (!m || typeof m !== 'object' || m.schema !== MANIFEST_SCHEMA) {
    block.push(`not a release manifest (schema ${MANIFEST_SCHEMA})`);
    return res();
  }
  for (const f of ['env', 'configHash', 'gitSha', 'author', 'keyId', 'createdAt', 'signature'] as const) if (typeof m[f] !== 'string' || !m[f]) block.push(`manifest field "${f}" is missing`);
  if (block.length) return res();
  if (trust.environment && m.env !== trust.environment) block.push(`the manifest is for environment "${m.env}", this gateway is "${trust.environment}"`);
  if (bundle.env !== m.env) block.push(`the bundle is for environment "${bundle.env}", the manifest for "${m.env}"`);
  const actual = configHash(bundle.config);
  if (actual !== m.configHash) block.push(`config hash mismatch: the bundle is ${actual}, the manifest signs ${m.configHash}`);
  const keys = new Map((trust.trustedKeys ?? []).map((k) => [k.id, k]));
  const check = (k: TrustedKey, msg: Buffer, sig: string): boolean => {
    try {
      return edVerify(null, msg, parsePublicKey(k.publicKey), Buffer.from(sig, 'base64'));
    } catch {
      return false;
    }
  };
  const ak = keys.get(m.keyId);
  let author: string | undefined;
  if (!ak) block.push(`signing key "${m.keyId}" is not a trusted key`);
  else if (!(ak.roles ?? ['author', 'approver']).includes('author')) block.push(`key "${m.keyId}" (${ak.name}) may not author releases (roles: ${(ak.roles ?? []).join(', ')})`);
  else if (!check(ak, releaseMessage(m), m.signature)) block.push(`the author signature is invalid (key "${m.keyId}")`);
  else author = ak.name;
  const created = Date.parse(m.createdAt);
  const maxAge = (trust.maxManifestAgeSeconds ?? 2_592_000) * 1000;
  if (!Number.isFinite(created)) block.push('createdAt is not a date');
  else {
    if (now - created > maxAge) block.push(`the manifest is older than ${Math.round(maxAge / 86_400_000)} days (maxManifestAgeSeconds)`);
    if (created - now > 5 * 60_000) block.push('the manifest was created in the future (clock skew > 5 min)');
    if (opts.lastApplied && created <= Date.parse(opts.lastApplied.createdAt)) block.push(`replay: the manifest (${m.createdAt}) is not newer than the release applied last (${opts.lastApplied.createdAt}) — sign a new release, also to roll back`);
  }
  if (m.expiresAt !== undefined && (!Number.isFinite(Date.parse(m.expiresAt)) || Date.parse(m.expiresAt) <= now)) block.push(`the manifest expired at ${m.expiresAt}`);
  const approvers: string[] = [];
  for (const a of Array.isArray(m.approvals) ? m.approvals : []) {
    const k = a && typeof a === 'object' ? keys.get(a.keyId) : undefined;
    if (!k) {
      ignored.push(`approval by "${String(a?.by)}" ignored: key "${String(a?.keyId)}" is not trusted`);
      continue;
    }
    if (!(k.roles ?? ['author', 'approver']).includes('approver')) {
      ignored.push(`approval with key "${k.id}" ignored: not an approver key`);
      continue;
    }
    if (typeof a.signature !== 'string' || typeof a.at !== 'string' || typeof a.by !== 'string' || !check(k, approvalMessage(m, a), a.signature)) {
      ignored.push(`approval with key "${k.id}" ignored: invalid signature`);
      continue;
    }
    if (author !== undefined && k.name === author) {
      ignored.push(`approval by ${k.name} ignored: the author cannot approve their own release`);
      continue;
    }
    if (approvers.includes(k.name)) continue;
    approvers.push(k.name);
  }
  if (approvers.length < required) block.push(`${approvers.length} of ${required} approvals (environment "${m.env}")`);
  return res(author, approvers);
}

/** Whether only signed, approved releases may change this gateway's config (`controlPlane.gitops.enforce`). */
export const gitopsEnforced = (cfg: { controlPlane?: { gitops?: { enforce?: boolean } } }): boolean => cfg.controlPlane?.gitops?.enforce === true;
export const GITOPS_ENFORCED_MESSAGE = 'GitOps enforcement is on (controlPlane.gitops.enforce): config changes must be signed, approved releases — use `mcp-gateway gitops apply` (POST /api/v1/admin/gitops/apply)';

// ── release simulation ─────────────────────────────────────────────────────────

export interface SimulatedCall {
  clientId?: string;
  serverId: string;
  tool: string;
  args?: Record<string, unknown>;
}

export interface SimDecision {
  effect: 'allow' | 'deny' | 'approve';
  /** Which layer decided: `server` (not configured), `scope` (API key scope), `policy` (tool policy). */
  layer: 'server' | 'scope' | 'policy';
  rule?: string;
  reason: string;
}

export interface ReleaseSimulation {
  source: string;
  calls: number;
  withArguments: number;
  unchanged: number;
  changed: number;
  transitions: Record<string, number>;
  byClient: Record<string, { changed: number; newlyDenied: number }>;
  byTool: Record<string, { changed: number; newlyDenied: number }>;
  changes: Array<{ call: SimulatedCall; before: SimDecision; after: SimDecision; explanation: string }>;
}

type AnyCfg = Record<string, unknown>;

const namedKeys = (cfg: AnyCfg): Map<string, { servers?: string[]; tools?: string[] }> => {
  const auth = isObj(cfg.auth) ? cfg.auth : {};
  const out = new Map<string, { servers?: string[]; tools?: string[] }>();
  for (const k of Array.isArray(auth.apiKeys) ? auth.apiKeys : []) {
    if (!isObj(k) || typeof k.name !== 'string') continue;
    const sc = isObj(k.scope) ? k.scope : k;
    out.set(k.name, { servers: Array.isArray(sc.servers) ? (sc.servers as string[]) : undefined, tools: Array.isArray(sc.tools) ? (sc.tools as string[]) : undefined });
  }
  return out;
};

function decide(cfg: AnyCfg, other: AnyCfg, c: SimulatedCall): SimDecision {
  const servers = Array.isArray(cfg.servers) ? (cfg.servers as Array<{ id?: unknown }>) : undefined;
  if (servers && !servers.some((s) => s?.id === c.serverId)) {
    const existed = Array.isArray(other.servers) && (other.servers as Array<{ id?: unknown }>).some((s) => s?.id === c.serverId);
    return { effect: 'deny', layer: 'server', reason: existed ? `server "${c.serverId}" is removed` : `server "${c.serverId}" is not configured` };
  }
  const keys = namedKeys(cfg);
  if (c.clientId) {
    const k = keys.get(c.clientId);
    if (!k && namedKeys(other).has(c.clientId)) return { effect: 'deny', layer: 'scope', reason: `key "${c.clientId}" is removed` };
    if (k?.servers && !k.servers.some((g) => globMatch(g, c.serverId))) return { effect: 'deny', layer: 'scope', reason: `key "${c.clientId}" may not use server "${c.serverId}" (servers: ${k.servers.join(', ')})` };
    if (k?.tools && !k.tools.some((g) => globMatch(g, c.tool) || globMatch(g, `${c.serverId}/${c.tool}`))) return { effect: 'deny', layer: 'scope', reason: `key "${c.clientId}" may not call ${c.tool} (tools: ${k.tools.join(', ')})` };
  }
  const pol = isObj(cfg.policy) ? (cfg.policy as unknown as ToolPolicyConfig) : undefined;
  const d = evaluatePolicy(pol, { clientId: c.clientId, serverId: c.serverId, tool: c.tool, args: c.args ?? {} });
  const verb = d.effect === 'allow' ? 'allows' : d.effect === 'deny' ? 'denies' : 'holds for approval';
  if (d.rule) return { effect: d.effect, layer: 'policy', rule: d.rule, reason: `rule "${d.rule}" ${verb} ${c.serverId}/${c.tool}${d.message ? ` (${d.message})` : ''}` };
  return { effect: d.effect, layer: 'policy', rule: '(default)', reason: `no rule matches ${c.serverId}/${c.tool}; the default is ${d.effect}${pol ? '' : ' (no policy)'}` };
}

/**
 * Replay calls against the running config and a candidate: which decisions change (server presence, API key scope,
 * tool policy — in the order the gateway applies them) and why.
 */
export function simulateRelease(current: AnyCfg, candidate: AnyCfg, calls: readonly SimulatedCall[], opts: { source?: string; maxChanges?: number } = {}): ReleaseSimulation {
  const r: ReleaseSimulation = { source: opts.source ?? 'calls', calls: calls.length, withArguments: 0, unchanged: 0, changed: 0, transitions: {}, byClient: {}, byTool: {}, changes: [] };
  // client ids and tool names come from requests/recorded calls: count in Maps (no prototype keys), convert at the end
  type Tally = { changed: number; newlyDenied: number };
  const byClient = new Map<string, Tally>();
  const byTool = new Map<string, Tally>();
  const bump = (m: Map<string, Tally>, k: string, denied: number) => {
    const cur = m.get(k) ?? { changed: 0, newlyDenied: 0 };
    m.set(k, { changed: cur.changed + 1, newlyDenied: cur.newlyDenied + denied });
  };
  for (const c of calls) {
    if (c.args && Object.keys(c.args).length) r.withArguments++;
    const before = decide(current, candidate, c);
    const after = decide(candidate, current, c);
    if (before.effect === after.effect) {
      r.unchanged++;
      continue;
    }
    r.changed++;
    const t = `${before.effect}→${after.effect}`;
    r.transitions[t] = (r.transitions[t] ?? 0) + 1;
    const denied = after.effect === 'deny' ? 1 : 0;
    const client = c.clientId ?? 'anonymous';
    const tool = `${c.serverId}/${c.tool}`;
    bump(byClient, client, denied);
    bump(byTool, tool, denied);
    if (r.changes.length < (opts.maxChanges ?? 200)) r.changes.push({ call: c, before, after, explanation: `${t}: ${after.reason} (was: ${before.reason})` });
  }
  r.byClient = Object.fromEntries(byClient);
  r.byTool = Object.fromEntries(byTool);
  return r;
}
