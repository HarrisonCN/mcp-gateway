/**
 * Developer portal (3.8): self-serve API keys, usage, interactive tool docs.
 *
 * With `portal.enabled` (requires `auth.strategy: api-key`) developers sign up at `/portal` with a name and e-mail
 * and receive an API key — immediately (`signup: open`), after an operator approves it (`approval`), or never
 * (`closed`, operators issue keys). Keys are stored hashed (`sha256:`), optionally persisted to
 * `portal.keysFile`, and join the configured `auth.apiKeys` as `portal-<id>` with the `portal.defaults` scope
 * (servers, tools, rate limit, TTL). A key holder can see its usage, rotate or revoke its key, and browse the tools
 * it may call with generated example arguments and copy-paste snippets.
 *
 * @module portal
 */

import { createHash, randomBytes, randomUUID } from 'crypto';
import { readFileSync, writeFileSync, existsSync, renameSync } from 'fs';
import { isAbsolute, resolve } from 'path';
import type { ApiKeyConfig, PortalConfig } from '../utils/types.js';
import { logger } from '../utils/logger.js';

export type PortalKeyStatus = 'active' | 'pending' | 'revoked' | 'denied';

export interface PortalKey {
  id: string;
  name: string;
  email: string;
  /** SHA-256 hex of the key; the key itself is shown once. */
  hash: string;
  /** First characters of the key, for recognising it. */
  prefix: string;
  status: PortalKeyStatus;
  createdAt: string;
  expiresAt?: string;
  decidedAt?: string;
  servers?: string[];
  tools?: string[];
  rateLimit?: { limit: number; windowSeconds: number };
}

export class PortalError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,255}\.[A-Za-z]{2,}$/;

export const clientIdOf = (k: PortalKey) => `key:portal-${k.id}`;

export class PortalStore {
  private keys = new Map<string, PortalKey>();

  constructor(
    private readonly config: () => PortalConfig | undefined,
    private readonly opts: { baseDir?: () => string | undefined; onChange?: () => void; now?: () => number } = {},
  ) {
    this.load();
  }

  get enabled(): boolean {
    return this.config()?.enabled === true;
  }

  private now(): number {
    return this.opts.now?.() ?? Date.now();
  }

  private file(): string | undefined {
    const f = this.config()?.keysFile;
    if (!f) return undefined;
    return isAbsolute(f) ? f : resolve(this.opts.baseDir?.() ?? process.cwd(), f);
  }

  load(): void {
    const f = this.file();
    if (!f || !existsSync(f)) return;
    try {
      const list = JSON.parse(readFileSync(f, 'utf8')) as PortalKey[];
      this.keys = new Map(list.map((k) => [k.id, k]));
    } catch (err) {
      logger.error(`Portal keys file ${f} is unreadable: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private save(): void {
    const f = this.file();
    if (f) {
      const tmp = `${f}.tmp`;
      writeFileSync(tmp, JSON.stringify([...this.keys.values()], null, 2) + '\n', { mode: 0o600 });
      renameSync(tmp, f);
    }
    this.opts.onChange?.();
  }

  private newSecret(): { key: string; hash: string; prefix: string } {
    const key = `mgw_${randomBytes(24).toString('base64url')}`;
    return { key, hash: createHash('sha256').update(key).digest('hex'), prefix: key.slice(0, 10) };
  }

  private defaults() {
    const d = this.config()?.defaults ?? {};
    const ttl = d.keyTtlDays;
    return {
      ...(d.servers ? { servers: d.servers } : {}),
      ...(d.tools ? { tools: d.tools } : {}),
      ...(d.rateLimit ? { rateLimit: d.rateLimit } : {}),
      ...(ttl ? { expiresAt: new Date(this.now() + ttl * 86_400_000).toISOString() } : {}),
    };
  }

  /** Self-serve signup. Returns the key only when it is issued right away. */
  signup(input: { name?: unknown; email?: unknown }): { record: PortalKey; key?: string } {
    const cfg = this.config();
    if (!cfg?.enabled) throw new PortalError(404, 'The developer portal is not enabled');
    const mode = cfg.signup ?? 'approval';
    if (mode === 'closed') throw new PortalError(403, 'Self-service signup is closed; ask an operator for a key');
    const name = typeof input.name === 'string' ? input.name.trim() : '';
    const email = typeof input.email === 'string' ? input.email.trim().toLowerCase() : '';
    if (!name || name.length > 80) throw new PortalError(400, '"name" is required (max 80 characters)');
    if (!EMAIL_RE.test(email)) throw new PortalError(400, '"email" must be an e-mail address');
    const domains = cfg.allowedEmailDomains;
    if (domains?.length && !domains.some((d) => email.endsWith(`@${d.toLowerCase()}`))) {
      throw new PortalError(403, `Signup is limited to ${domains.map((d) => `@${d}`).join(', ')} addresses`);
    }
    const open = [...this.keys.values()].filter((k) => k.email === email && (k.status === 'active' || k.status === 'pending'));
    if (open.length >= (cfg.maxKeysPerEmail ?? 3)) throw new PortalError(409, 'This e-mail address already has the maximum number of keys');
    const s = this.newSecret();
    const record: PortalKey = {
      id: randomUUID().slice(0, 8),
      name,
      email,
      hash: s.hash,
      prefix: s.prefix,
      status: mode === 'open' ? 'active' : 'pending',
      createdAt: new Date(this.now()).toISOString(),
      ...this.defaults(),
    };
    this.keys.set(record.id, record);
    this.save();
    logger.info(`Portal signup: ${name} <${email}> (${record.status})`);
    // A pending key is kept so approval can activate it; the holder gets the secret once, now.
    return { record, key: s.key };
  }

  /** Operator decision on a pending key. */
  decide(id: string, approve: boolean): PortalKey {
    const k = this.keys.get(id);
    if (!k) throw new PortalError(404, `No portal key "${id}"`);
    if (k.status !== 'pending') throw new PortalError(409, `Key "${id}" is ${k.status}`);
    k.status = approve ? 'active' : 'denied';
    k.decidedAt = new Date(this.now()).toISOString();
    this.save();
    return k;
  }

  revoke(id: string): PortalKey {
    const k = this.keys.get(id);
    if (!k) throw new PortalError(404, `No portal key "${id}"`);
    k.status = 'revoked';
    k.decidedAt = new Date(this.now()).toISOString();
    this.save();
    return k;
  }

  /** Replace a key's secret (the old one stops working immediately). */
  rotate(id: string): { record: PortalKey; key: string } {
    const k = this.keys.get(id);
    if (!k || k.status !== 'active') throw new PortalError(404, `No active portal key "${id}"`);
    const s = this.newSecret();
    k.hash = s.hash;
    k.prefix = s.prefix;
    this.save();
    return { record: k, key: s.key };
  }

  get(id: string): PortalKey | undefined {
    return this.keys.get(id);
  }

  /** Portal key behind a client id (`key:portal-<id>`). */
  byClientId(clientId: string | undefined): PortalKey | undefined {
    const m = /^key:portal-([A-Za-z0-9-]+)$/.exec(clientId ?? '');
    return m ? this.keys.get(m[1]!) : undefined;
  }

  list(): PortalKey[] {
    return [...this.keys.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  /** Active keys in `auth.apiKeys` form. */
  apiKeys(): ApiKeyConfig[] {
    return this.list()
      .filter((k) => k.status === 'active')
      .map((k) => ({
        key: `sha256:${k.hash}`,
        name: `portal-${k.id}`,
        ...(k.servers ? { servers: k.servers } : {}),
        ...(k.tools ? { tools: k.tools } : {}),
        ...(k.rateLimit ? { rateLimit: k.rateLimit } : {}),
        ...(k.expiresAt ? { expiresAt: k.expiresAt } : {}),
      }));
  }
}

/** Public view of a key record (no hash). */
export function publicKey(k: PortalKey): Omit<PortalKey, 'hash'> & { clientId: string } {
  const { hash: _h, ...rest } = k;
  void _h;
  return { ...rest, clientId: clientIdOf(k) };
}

/** Example arguments from a JSON schema (defaults, enums, examples, then type placeholders). */
export function exampleArgs(schema: unknown, depth = 0): unknown {
  const s = (schema ?? {}) as Record<string, unknown>;
  if (depth > 4) return null;
  if (s.default !== undefined) return s.default;
  if (Array.isArray(s.examples) && s.examples.length) return s.examples[0];
  if (Array.isArray(s.enum) && s.enum.length) return s.enum[0];
  const type = Array.isArray(s.type) ? s.type[0] : s.type;
  switch (type) {
    case 'object': {
      const props = (s.properties ?? {}) as Record<string, unknown>;
      const req = new Set((s.required as string[] | undefined) ?? Object.keys(props));
      return Object.fromEntries(Object.entries(props).filter(([k]) => req.has(k)).map(([k, v]) => [k, exampleArgs(v, depth + 1)]));
    }
    case 'array':
      return [exampleArgs(s.items, depth + 1)];
    case 'integer':
    case 'number':
      return typeof s.minimum === 'number' ? s.minimum : 1;
    case 'boolean':
      return true;
    case 'string':
      return typeof s.description === 'string' && /path|file/i.test(s.description) ? '/path/to/file' : 'example';
    default:
      return s.properties ? exampleArgs({ ...s, type: 'object' }, depth) : null;
  }
}

/** Copy-paste snippets for one tool. */
export function toolSnippets(baseUrl: string, server: string, tool: string, args: unknown): { curl: string; javascript: string; python: string } {
  const body = JSON.stringify({ server, tool, arguments: args });
  return {
    curl: `curl -s ${baseUrl}/api/v1/tools/call \\\n  -H "Authorization: Bearer $MCP_GATEWAY_KEY" -H "Content-Type: application/json" \\\n  -d '${body.replace(/'/g, "'\\''")}'`,
    javascript: `const res = await fetch('${baseUrl}/api/v1/tools/call', {\n  method: 'POST',\n  headers: { Authorization: \`Bearer \${process.env.MCP_GATEWAY_KEY}\`, 'Content-Type': 'application/json' },\n  body: JSON.stringify(${JSON.stringify({ server, tool, arguments: args })}),\n});\nconsole.log((await res.json()).result);`,
    python: `import os, requests\nr = requests.post("${baseUrl}/api/v1/tools/call",\n    headers={"Authorization": f"Bearer {os.environ['MCP_GATEWAY_KEY']}"},\n    json=${JSON.stringify({ server, tool, arguments: args }).replace(/true/g, 'True').replace(/false/g, 'False').replace(/null/g, 'None')})\nprint(r.json()["result"])`,
  };
}
