/**
 * Secrets management (3.5): upstream credentials resolved from Vault / KMS / env / files, rotated, and injected
 * per tenant.
 *
 * Any server `env`, `headers`, `url` or `args` value may contain `secret://<provider>/<path>[#field]` references.
 * They are resolved when the server connects — the registry, `GET /servers`, the audit log and config diffs only ever
 * see the reference — and re-resolved every `secrets.rotation.intervalSeconds`; a server whose resolved credentials
 * changed is reconnected with the new ones (token rotation without a restart).
 *
 * `servers[].inject` adds per-tenant / per-client credentials to each call, after plugins, policy and capture (so
 * they never reach the request log or the replay debugger): into a tool argument or into `_meta`. `{tenant}` and
 * `{client}` in the reference are replaced with the caller's first tenant / client id.
 *
 * Providers:
 *  - `vault`: HashiCorp Vault KV v2 (`GET {address}/v1/{mount}/data/{path}`), token or AppRole auth.
 *  - `aws-kms`: AWS KMS `Decrypt` (SigV4) of a base64 ciphertext; the reference path is the ciphertext.
 *  - `gcp-kms`: Google Cloud KMS `decrypt` with an access token; path is `<cryptoKey>:<base64 ciphertext>`.
 *  - `env`: environment variable; `file`: a file (trimmed), relative to the config directory.
 *
 * @module secrets
 */

import { createHash, createHmac } from 'crypto';
import { readFile } from 'fs/promises';
import { isAbsolute, resolve as resolvePath } from 'path';
import type { McpServerConfig, SecretProviderConfig, SecretsConfig } from '../utils/types.js';
import { logger } from '../utils/logger.js';

export const SECRET_REF = /secret:\/\/([A-Za-z0-9_-]+)\/([^\s"'#]+)(?:#([A-Za-z0-9_.-]+))?/g;

export interface SecretRef {
  provider: string;
  path: string;
  field?: string;
}

export function parseSecretRef(s: string): SecretRef | undefined {
  const m = /^secret:\/\/([A-Za-z0-9_-]+)\/([^\s"'#]+)(?:#([A-Za-z0-9_.-]+))?$/.exec(s);
  return m ? { provider: m[1]!, path: m[2]!, ...(m[3] ? { field: m[3] } : {}) } : undefined;
}

export const hasSecretRef = (s: string): boolean => new RegExp(SECRET_REF.source).test(s);

export interface SecretProvider {
  readonly id: string;
  readonly type: string;
  /** Raw value (string) or object of fields (KV). */
  read(path: string): Promise<string | Record<string, unknown>>;
}

type FetchFn = typeof fetch;

/** HashiCorp Vault KV v2. */
export class VaultProvider implements SecretProvider {
  readonly type = 'vault';
  private token?: string;
  constructor(
    readonly id: string,
    private readonly cfg: SecretProviderConfig,
    private readonly fetchFn: FetchFn = fetch,
  ) {
    this.token = cfg.token;
  }

  private base(): string {
    return (this.cfg.address ?? '').replace(/\/+$/, '');
  }

  private async login(): Promise<string> {
    if (this.token) return this.token;
    if (!this.cfg.roleId || !this.cfg.secretId) throw new Error(`Vault provider "${this.id}" needs token or roleId + secretId`);
    const r = await this.fetchFn(`${this.base()}/v1/auth/approle/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(this.cfg.namespace ? { 'X-Vault-Namespace': this.cfg.namespace } : {}) },
      body: JSON.stringify({ role_id: this.cfg.roleId, secret_id: this.cfg.secretId }),
    });
    if (!r.ok) throw new Error(`Vault AppRole login failed: HTTP ${r.status}`);
    const body = (await r.json()) as { auth?: { client_token?: string } };
    if (!body.auth?.client_token) throw new Error('Vault AppRole login returned no token');
    this.token = body.auth.client_token;
    return this.token;
  }

  async read(path: string): Promise<Record<string, unknown>> {
    const mount = this.cfg.mount ?? 'secret';
    const get = async () =>
      this.fetchFn(`${this.base()}/v1/${mount}/data/${path.replace(/^\/+/, '')}`, {
        headers: { 'X-Vault-Token': await this.login(), ...(this.cfg.namespace ? { 'X-Vault-Namespace': this.cfg.namespace } : {}) },
      });
    let r = await get();
    if (r.status === 403 && !this.cfg.token && this.cfg.roleId) {
      this.token = undefined; // expired AppRole token: log in again once
      r = await get();
    }
    if (r.status === 404) throw new Error(`Vault: no secret at ${mount}/${path}`);
    if (!r.ok) throw new Error(`Vault read ${mount}/${path} failed: HTTP ${r.status}`);
    const body = (await r.json()) as { data?: { data?: Record<string, unknown> } };
    return body.data?.data ?? {};
  }
}

const sha256hex = (s: string | Buffer) => createHash('sha256').update(s).digest('hex');
const hmac = (k: Buffer | string, s: string) => createHmac('sha256', k).update(s).digest();

/** AWS Signature V4 headers for a JSON POST (exported for tests). */
export function sigv4(opts: {
  method: string;
  url: string;
  body: string;
  headers: Record<string, string>;
  region: string;
  service: string;
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  now?: Date;
}): Record<string, string> {
  const u = new URL(opts.url);
  const now = opts.now ?? new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const date = amzDate.slice(0, 8);
  const headers: Record<string, string> = { ...opts.headers, host: u.host, 'x-amz-date': amzDate, ...(opts.sessionToken ? { 'x-amz-security-token': opts.sessionToken } : {}) };
  const names = Object.keys(headers).map((h) => h.toLowerCase()).sort();
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), String(v).trim()]));
  const canonical = [opts.method, u.pathname || '/', u.search.slice(1), names.map((n) => `${n}:${lower[n]}\n`).join(''), names.join(';'), sha256hex(opts.body)].join('\n');
  const scope = `${date}/${opts.region}/${opts.service}/aws4_request`;
  const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256hex(canonical)].join('\n');
  const kDate = hmac(`AWS4${opts.secretAccessKey}`, date);
  const kSigning = hmac(hmac(hmac(kDate, opts.region), opts.service), 'aws4_request');
  const signature = createHmac('sha256', kSigning).update(toSign).digest('hex');
  return { ...headers, authorization: `AWS4-HMAC-SHA256 Credential=${opts.accessKeyId}/${scope}, SignedHeaders=${names.join(';')}, Signature=${signature}` };
}

/** AWS KMS Decrypt; the reference path is the base64 ciphertext blob (URL-safe base64 accepted). */
export class AwsKmsProvider implements SecretProvider {
  readonly type = 'aws-kms';
  constructor(
    readonly id: string,
    private readonly cfg: SecretProviderConfig,
    private readonly fetchFn: FetchFn = fetch,
  ) {}

  async read(path: string): Promise<string> {
    const region = this.cfg.region ?? process.env.AWS_REGION ?? 'us-east-1';
    const accessKeyId = this.cfg.accessKeyId ?? process.env.AWS_ACCESS_KEY_ID;
    const secretAccessKey = this.cfg.secretAccessKey ?? process.env.AWS_SECRET_ACCESS_KEY;
    if (!accessKeyId || !secretAccessKey) throw new Error(`aws-kms provider "${this.id}" has no credentials`);
    const url = this.cfg.endpoint ?? `https://kms.${region}.amazonaws.com/`;
    const body = JSON.stringify({ CiphertextBlob: path.replace(/-/g, '+').replace(/_/g, '/'), ...(this.cfg.keyId ? { KeyId: this.cfg.keyId } : {}) });
    const headers = sigv4({
      method: 'POST', url, body, region, service: 'kms', accessKeyId, secretAccessKey,
      sessionToken: this.cfg.sessionToken ?? process.env.AWS_SESSION_TOKEN,
      headers: { 'content-type': 'application/x-amz-json-1.1', 'x-amz-target': 'TrentService.Decrypt' },
    });
    const r = await this.fetchFn(url, { method: 'POST', headers, body });
    if (!r.ok) throw new Error(`KMS Decrypt failed: HTTP ${r.status}`);
    const out = (await r.json()) as { Plaintext?: string };
    if (typeof out.Plaintext !== 'string') throw new Error('KMS Decrypt returned no plaintext');
    return Buffer.from(out.Plaintext, 'base64').toString('utf8');
  }
}

/** Google Cloud KMS decrypt; path `<projects/…/cryptoKeys/key>:<base64 ciphertext>`. */
export class GcpKmsProvider implements SecretProvider {
  readonly type = 'gcp-kms';
  constructor(
    readonly id: string,
    private readonly cfg: SecretProviderConfig,
    private readonly fetchFn: FetchFn = fetch,
  ) {}

  async read(path: string): Promise<string> {
    const i = path.lastIndexOf(':');
    if (i <= 0) throw new Error('gcp-kms reference must be <cryptoKey>:<ciphertext>');
    const key = path.slice(0, i);
    const ciphertext = path.slice(i + 1).replace(/-/g, '+').replace(/_/g, '/');
    const token = this.cfg.token ?? process.env.GOOGLE_OAUTH_ACCESS_TOKEN;
    if (!token) throw new Error(`gcp-kms provider "${this.id}" needs token (or GOOGLE_OAUTH_ACCESS_TOKEN)`);
    const base = (this.cfg.endpoint ?? 'https://cloudkms.googleapis.com').replace(/\/+$/, '');
    const r = await this.fetchFn(`${base}/v1/${key}:decrypt`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ ciphertext }),
    });
    if (!r.ok) throw new Error(`Cloud KMS decrypt failed: HTTP ${r.status}`);
    const out = (await r.json()) as { plaintext?: string };
    if (typeof out.plaintext !== 'string') throw new Error('Cloud KMS returned no plaintext');
    return Buffer.from(out.plaintext, 'base64').toString('utf8');
  }
}

export class EnvProvider implements SecretProvider {
  readonly type = 'env';
  constructor(readonly id: string) {}
  async read(path: string): Promise<string> {
    const v = process.env[path];
    if (v === undefined) throw new Error(`Environment variable ${path} is not set`);
    return v;
  }
}

export class FileProvider implements SecretProvider {
  readonly type = 'file';
  constructor(
    readonly id: string,
    private readonly baseDir: string,
  ) {}
  async read(path: string): Promise<string> {
    return (await readFile(isAbsolute(path) ? path : resolvePath(this.baseDir, path), 'utf8')).trim();
  }
}

export function createProvider(cfg: SecretProviderConfig, baseDir = process.cwd(), fetchFn?: FetchFn): SecretProvider {
  switch (cfg.type) {
    case 'vault':
      return new VaultProvider(cfg.id, cfg, fetchFn);
    case 'aws-kms':
      return new AwsKmsProvider(cfg.id, cfg, fetchFn);
    case 'gcp-kms':
      return new GcpKmsProvider(cfg.id, cfg, fetchFn);
    case 'env':
      return new EnvProvider(cfg.id);
    case 'file':
      return new FileProvider(cfg.id, cfg.baseDir ?? baseDir);
  }
}

interface CacheEntry {
  value: string;
  fetchedAt: number;
  version: number;
}

export interface SecretStatus {
  ref: string;
  provider: string;
  type: string;
  version: number;
  fetchedAt?: string;
  rotatedAt?: string;
  error?: string;
  usedBy: string[];
}

/** Resolves, caches and rotates secret references. Values never leave this class except into upstream configs. */
export class SecretManager {
  private providers = new Map<string, SecretProvider>();
  private readonly cache = new Map<string, CacheEntry>();
  private readonly rotated = new Map<string, number>();
  private readonly errors = new Map<string, string>();
  private readonly usedBy = new Map<string, Set<string>>();
  private timer?: NodeJS.Timeout;
  /** Hash of the resolved credentials per server id (rotation detection). */
  private readonly fingerprints = new Map<string, string>();

  constructor(
    private config: () => SecretsConfig | undefined,
    private readonly opts: { baseDir?: () => string | undefined; fetch?: FetchFn; now?: () => number } = {},
  ) {
    this.configure();
  }

  /** (Re)build providers from config (hot reload). */
  configure(): void {
    const next = new Map<string, SecretProvider>();
    for (const p of this.config()?.providers ?? []) next.set(p.id, createProvider(p, this.opts.baseDir?.() ?? process.cwd(), this.opts.fetch));
    if (!next.has('env')) next.set('env', new EnvProvider('env'));
    this.providers = next;
  }

  get enabled(): boolean {
    return (this.config()?.providers?.length ?? 0) > 0;
  }

  private now(): number {
    return this.opts.now?.() ?? Date.now();
  }

  private ttlMs(): number {
    return (this.config()?.cacheSeconds ?? 300) * 1000;
  }

  /** Resolve one reference (cached for `cacheSeconds`). */
  async get(ref: string, opts: { fresh?: boolean; user?: string } = {}): Promise<string> {
    const parsed = parseSecretRef(ref);
    if (!parsed) throw new Error(`Not a secret reference: ${ref}`);
    if (opts.user) {
      let s = this.usedBy.get(ref);
      if (!s) this.usedBy.set(ref, (s = new Set()));
      s.add(opts.user);
    }
    const hit = this.cache.get(ref);
    if (hit && !opts.fresh && this.now() - hit.fetchedAt < this.ttlMs()) return hit.value;
    const provider = this.providers.get(parsed.provider);
    if (!provider) throw new Error(`Unknown secret provider "${parsed.provider}" in ${ref}`);
    try {
      const raw = await provider.read(parsed.path);
      let value: string;
      if (typeof raw === 'string') {
        if (parsed.field) {
          const obj = JSON.parse(raw) as Record<string, unknown>;
          value = String(obj[parsed.field] ?? '');
        } else value = raw;
      } else {
        const v = parsed.field ? raw[parsed.field] : Object.keys(raw).length === 1 ? Object.values(raw)[0] : undefined;
        if (v === undefined) throw new Error(`${ref}: field ${parsed.field ? `"${parsed.field}" not found` : 'required (the secret has several keys)'}`);
        value = String(v);
      }
      const version = hit ? (hit.value === value ? hit.version : hit.version + 1) : 1;
      if (hit && hit.value !== value) this.rotated.set(ref, this.now());
      this.cache.set(ref, { value, fetchedAt: this.now(), version });
      this.errors.delete(ref);
      return value;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.errors.set(ref, msg);
      // Keep serving the last good value while the provider is down.
      if (hit) {
        logger.warn(`Secret ${ref} could not be refreshed (${msg}); keeping the cached value`);
        return hit.value;
      }
      throw err;
    }
  }

  /** Replace every `secret://` reference inside a string. */
  async interpolate(s: string, opts: { fresh?: boolean; user?: string; vars?: Record<string, string> } = {}): Promise<string> {
    let src = s;
    for (const [k, v] of Object.entries(opts.vars ?? {})) src = src.split(`{${k}}`).join(v);
    const refs = [...src.matchAll(new RegExp(SECRET_REF.source, 'g'))].map((m) => m[0]);
    let out = src;
    for (const ref of refs) out = out.split(ref).join(await this.get(ref, opts));
    return out;
  }

  /** A copy of a server config with every reference resolved (env, headers, url, args). */
  async resolveServer(s: McpServerConfig, fresh = false): Promise<McpServerConfig> {
    const user = `server:${s.replicaOf ?? s.id}`;
    const map = async (rec?: Record<string, string>) =>
      rec ? Object.fromEntries(await Promise.all(Object.entries(rec).map(async ([k, v]) => [k, hasSecretRef(v) ? await this.interpolate(v, { fresh, user }) : v] as const))) : rec;
    const out: McpServerConfig = {
      ...s,
      env: await map(s.env),
      headers: await map(s.headers),
      ...(s.url && hasSecretRef(s.url) ? { url: await this.interpolate(s.url, { fresh, user }) } : {}),
      ...(s.args ? { args: await Promise.all(s.args.map((a) => (hasSecretRef(a) ? this.interpolate(a, { fresh, user }) : a))) } : {}),
    };
    this.fingerprints.set(s.id, fingerprint(out));
    return out;
  }

  /** Whether a server config references any secret. */
  static usesSecrets(s: McpServerConfig): boolean {
    const vals = [...Object.values(s.env ?? {}), ...Object.values(s.headers ?? {}), s.url ?? '', ...(s.args ?? [])];
    return vals.some((v) => hasSecretRef(v));
  }

  /** Re-resolve a server's references bypassing the cache; returns the new config when its credentials changed. */
  async rotateServer(s: McpServerConfig): Promise<McpServerConfig | undefined> {
    const before = this.fingerprints.get(s.id);
    const next = await this.resolveServer(s, true);
    return before !== undefined && before !== this.fingerprints.get(s.id) ? next : undefined;
  }

  /** Per-call injection values for a server (`inject:`), with `{tenant}` / `{client}` filled in. */
  async injections(s: McpServerConfig | undefined, ctx: { tenant?: string; clientId?: string }): Promise<Array<{ argument?: string; meta?: string; value: string }>> {
    const out: Array<{ argument?: string; meta?: string; value: string }> = [];
    for (const inj of s?.inject ?? []) {
      if (inj.ref.includes('{tenant}') && !ctx.tenant) {
        if (inj.required !== false) throw new Error(`Server "${s!.id}" needs a tenant to inject ${inj.argument ?? inj.meta}`);
        continue;
      }
      const vars = { tenant: ctx.tenant ?? '', client: (ctx.clientId ?? 'anonymous').replace(/[^A-Za-z0-9_.-]/g, '_') };
      const value = await this.interpolate(inj.ref, { vars, user: `server:${s!.id}` });
      out.push({ ...(inj.argument ? { argument: inj.argument } : {}), ...(inj.meta ? { meta: inj.meta } : {}), value: inj.format ? inj.format.split('{value}').join(value) : value });
    }
    return out;
  }

  /** Start periodic rotation; `onRotated` reconnects a server whose credentials changed. */
  startRotation(servers: () => McpServerConfig[], onRotated: (next: McpServerConfig) => Promise<void>): void {
    this.stopRotation();
    const sec = this.config()?.rotation?.intervalSeconds;
    if (!sec) return;
    this.timer = setInterval(() => void this.rotateAll(servers(), onRotated), sec * 1000);
    this.timer.unref();
  }

  async rotateAll(servers: McpServerConfig[], onRotated: (next: McpServerConfig) => Promise<void>): Promise<string[]> {
    const changed: string[] = [];
    for (const s of servers) {
      if (s.enabled === false || !SecretManager.usesSecrets(s)) continue;
      try {
        const next = await this.rotateServer(s);
        if (next) {
          changed.push(s.id);
          logger.info(`Credentials of "${s.id}" rotated; reconnecting`);
          await onRotated(next);
        }
      } catch (err) {
        logger.warn(`Secret rotation for "${s.id}" failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return changed;
  }

  stopRotation(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** Status of every reference seen so far — never the values. */
  status(): SecretStatus[] {
    const refs = new Set([...this.cache.keys(), ...this.errors.keys(), ...this.usedBy.keys()]);
    return [...refs].sort().map((ref) => {
      const p = parseSecretRef(ref)!;
      const c = this.cache.get(ref);
      const r = this.rotated.get(ref);
      return {
        ref,
        provider: p.provider,
        type: this.providers.get(p.provider)?.type ?? 'unknown',
        version: c?.version ?? 0,
        ...(c ? { fetchedAt: new Date(c.fetchedAt).toISOString() } : {}),
        ...(r ? { rotatedAt: new Date(r).toISOString() } : {}),
        ...(this.errors.has(ref) ? { error: this.errors.get(ref) } : {}),
        usedBy: [...(this.usedBy.get(ref) ?? [])].sort(),
      };
    });
  }

  providerList(): Array<{ id: string; type: string }> {
    return [...this.providers.values()].map((p) => ({ id: p.id, type: p.type }));
  }

  /** Every resolved value (for log redaction). */
  values(): string[] {
    return [...this.cache.values()].map((c) => c.value).filter((v) => v.length >= 4);
  }
}

function fingerprint(s: McpServerConfig): string {
  return sha256hex(JSON.stringify([s.env ?? {}, s.headers ?? {}, s.url ?? '', s.args ?? []]));
}
