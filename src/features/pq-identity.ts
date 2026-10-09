/**
 * Post-quantum identity (10.8, EXPERIMENTAL): Ed25519 + ML-DSA hybrid signatures for the gateway's identity, its tool
 * manifest and a tamper-evident audit log. (Plugin artifacts: `pluginTrust.keys[].mldsa` — see `plugins/trust.ts`.)
 *
 * ```yaml
 * features:
 *   pqIdentity:
 *     keyFile: keys/gateway.hybrid.json   # from `mcp-gateway pq keygen` (relative to the config file; keep it secret)
 *     keyId: gw-2026
 *     gatewayId: gateway.example.com      # subject of the identity document (default: the key id)
 *     validityDays: 90
 *     toolManifest: true                  # GET /api/v1/features/pq-identity/tool-manifest (signed)
 *     auditLog:
 *       dir: .mcp-gateway/pq-audit        # hash-chained JSONL (omit = memory only)
 *       checkpointEvery: 100              # sign the chain head every N entries …
 *       checkpointSeconds: 300            # … and at least this often when there were new entries
 * ```
 *
 * - **Identity document** — `{ subject, keyId, publicKey: { ed25519, mldsa }, notBefore, notAfter }` signed with the
 *   hybrid key (self-signed). It is a JSON document, **not an X.509 certificate**: TLS stacks cannot use it; clients and
 *   peer gateways that pin `keyId` / the public keys can.
 * - **Tool manifest** — the tools this gateway exposes (server, name, description, SHA-256 of the input schema), signed,
 *   so an agent can detect a tampered or swapped tool list.
 * - **Audit chain** — every tool call (also refused ones) is appended as `{ seq, at, client, server, tool, outcome,
 *   argsSha256, prev, hash }` with `hash = sha256(prev ‖ entry)`; checkpoints sign `seq:hash` with the hybrid key.
 *   `POST /admin/pq-identity/audit/verify` recomputes the chain and checks every checkpoint signature.
 *
 * A hybrid signature verifies only if both the Ed25519 and the ML-DSA signature verify. ML-DSA runs on Node's crypto
 * when the runtime has it (self-tested), else on `@noble/post-quantum` (`GET /admin/pq-identity` shows which).
 *
 * @module features/pq-identity
 */

import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import { registerFeature, objectBody, badRequest } from '../gateway/features.js';
import { registerCallHook, type HookCall } from '../gateway/hooks.js';
import { hybridSign, hybridVerify, parseMlDsaKey, pqBackend, publicPart, type HybridPrivateKey, type HybridPublicKey, type HybridSignature, type MlDsaKey } from '../security/pq.js';
import { createPrivateKey, createPublicKey } from 'node:crypto';
import type { GatewayConfig } from '../utils/types.js';
import { isToolInScope } from '../auth/scopes.js';
import type { AuthedRequest } from '../auth/middleware.js';
import { logger } from '../utils/logger.js';
import { PqIdentityConfig, PqIdentitySchema } from './schemas/pq-identity.js';
export { PqIdentityConfig, PqIdentitySchema } from './schemas/pq-identity.js';
type Parsed = z.output<typeof PqIdentitySchema>;

/** Canonical JSON (sorted keys) — what gets hashed and signed. */
export function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v as object).sort().filter((k) => (v as Record<string, unknown>)[k] !== undefined).map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`).join(',')}}`;
  return JSON.stringify(v ?? null);
}
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

/** Load and validate a hybrid private key file `{ ed25519: PEM, mldsa: { kty, alg, pub, seed } }`. */
export function loadHybridKey(file: string): { privateKey: HybridPrivateKey; publicKey: HybridPublicKey } {
  const raw = JSON.parse(readFileSync(file, 'utf8')) as { ed25519?: unknown; mldsa?: unknown };
  if (typeof raw.ed25519 !== 'string') throw new Error(`${file}: "ed25519" must be a PKCS#8 PEM private key`);
  const ed = createPrivateKey(raw.ed25519);
  if (ed.asymmetricKeyType !== 'ed25519') throw new Error(`${file}: "ed25519" is a ${ed.asymmetricKeyType} key`);
  const ml = parseMlDsaKey(raw.mldsa, true) as MlDsaKey;
  return {
    privateKey: { ed25519: raw.ed25519, mldsa: ml },
    publicKey: { ed25519: createPublicKey(ed).export({ type: 'spki', format: 'pem' }).toString(), mldsa: publicPart(ml) },
  };
}

export interface SignedDocument<T> {
  payload: T;
  keyId: string;
  signature: HybridSignature;
}

export function signDocument<T>(payload: T, keyId: string, key: HybridPrivateKey, domain: string): SignedDocument<T> {
  return { payload, keyId, signature: hybridSign(key, `${domain}\n${canonical(payload)}`) };
}

export function verifyDocument(doc: unknown, key: HybridPublicKey, domain: string): { ok: true } | { ok: false; reason: string } {
  const d = doc as Partial<SignedDocument<unknown>> | null;
  if (!d || d.payload === undefined || !d.signature) return { ok: false, reason: 'not a signed document ({ payload, keyId, signature })' };
  return hybridVerify(key, `${domain}\n${canonical(d.payload)}`, d.signature);
}

export const DOMAIN = { identity: 'mcp-gateway-identity:v1', manifest: 'mcp-gateway-tool-manifest:v1', audit: 'mcp-gateway-audit:v1' } as const;

// ─── audit chain ────────────────────────────────────────────────────────────

export interface AuditEntry {
  type: 'call';
  seq: number;
  at: string;
  client?: string;
  server: string;
  tool: string;
  outcome: 'success' | 'error' | 'refused';
  code?: number;
  argsSha256: string;
  prev: string;
  hash: string;
}
export interface AuditCheckpoint {
  type: 'checkpoint';
  seq: number;
  hash: string;
  at: string;
  keyId: string;
  signature: HybridSignature;
}
export type AuditRecord = AuditEntry | AuditCheckpoint;
const GENESIS = '0'.repeat(64);

export const entryHash = (e: Omit<AuditEntry, 'hash'>) => sha256(`${e.prev}${canonical({ ...e, hash: undefined })}`);
export const checkpointMessage = (seq: number, hash: string) => `${DOMAIN.audit}\n${seq}:${hash}`;

export class AuditChain {
  records: AuditRecord[] = [];
  seq = 0;
  head = GENESIS;
  private sinceCheckpoint = 0;
  private lastCheckpointAt = Date.now();
  private loaded?: string;

  constructor(private readonly opts: () => { dir?: string; maxEntries: number; checkpointEvery: number; keyId: string; key: HybridPrivateKey }) {}

  load(): void {
    const dir = this.opts().dir;
    if (!dir || this.loaded === dir) return;
    this.loaded = dir;
    if (!existsSync(dir)) return;
    for (const f of readdirSync(dir).filter((x) => /^audit-\d{4}-\d{2}-\d{2}\.jsonl$/.test(x)).sort()) {
      for (const line of readFileSync(join(dir, f), 'utf8').split('\n')) {
        if (!line.trim()) continue;
        try {
          this.records.push(JSON.parse(line) as AuditRecord);
        } catch {
          logger.warn(`pq-identity: unreadable audit line in ${f} (kept out of the chain; verify will report the gap)`);
        }
      }
    }
    const last = [...this.records].reverse().find((r): r is AuditEntry => r.type === 'call');
    if (last) {
      this.seq = last.seq;
      this.head = last.hash;
    }
    this.trim();
  }

  private write(r: AuditRecord): void {
    this.records.push(r);
    this.trim();
    const dir = this.opts().dir;
    if (!dir) return;
    try {
      mkdirSync(dir, { recursive: true });
      appendFileSync(join(dir, `audit-${r.at.slice(0, 10)}.jsonl`), JSON.stringify(r) + '\n');
    } catch (e) {
      logger.warn(`pq-identity: audit write failed: ${(e as Error).message}`);
    }
  }

  private trim(): void {
    const max = this.opts().maxEntries;
    if (this.records.length > max) this.records.splice(0, this.records.length - max);
  }

  append(call: HookCall, outcome: AuditEntry['outcome'], code?: number, now = new Date()): AuditEntry {
    this.load();
    const base = { type: 'call' as const, seq: ++this.seq, at: now.toISOString(), client: call.clientId, server: call.serverId, tool: call.tool, outcome, ...(code !== undefined ? { code } : {}), argsSha256: sha256(canonical(call.args ?? {})), prev: this.head };
    const e: AuditEntry = { ...base, hash: entryHash(base) };
    this.head = e.hash;
    this.write(e);
    if (++this.sinceCheckpoint >= this.opts().checkpointEvery) this.checkpoint(now);
    return e;
  }

  /** Sign the chain head (no-op without new entries). */
  checkpoint(now = new Date()): AuditCheckpoint | undefined {
    if (this.sinceCheckpoint === 0) return undefined;
    const o = this.opts();
    const c: AuditCheckpoint = { type: 'checkpoint', seq: this.seq, hash: this.head, at: now.toISOString(), keyId: o.keyId, signature: hybridSign(o.key, checkpointMessage(this.seq, this.head)) };
    this.sinceCheckpoint = 0;
    this.lastCheckpointAt = now.getTime();
    this.write(c);
    return c;
  }

  due(seconds: number, now = Date.now()): boolean {
    return this.sinceCheckpoint > 0 && now - this.lastCheckpointAt >= seconds * 1000;
  }
}

/** Recompute the chain and check every checkpoint. The first kept entry anchors the chain when older ones were trimmed. */
export function verifyAudit(records: readonly AuditRecord[], key: HybridPublicKey): { ok: boolean; entries: number; checkpoints: number; verifiedThrough: number; unsignedTail: number; problems: string[] } {
  const problems: string[] = [];
  let prev: string | undefined;
  let lastSeq: number | undefined;
  let entries = 0;
  let checkpoints = 0;
  let verifiedThrough = 0;
  const hashes = new Map<number, string>();
  for (const r of records) {
    if (r.type === 'call') {
      entries++;
      if (prev !== undefined && r.prev !== prev) problems.push(`seq ${r.seq}: prev does not match the hash of seq ${lastSeq}`);
      if (lastSeq !== undefined && r.seq !== lastSeq + 1) problems.push(`seq ${r.seq}: gap after seq ${lastSeq}`);
      const { hash, ...rest } = r;
      if (entryHash(rest) !== hash) problems.push(`seq ${r.seq}: entry was modified (hash mismatch)`);
      prev = hash;
      lastSeq = r.seq;
      hashes.set(r.seq, hash);
    } else {
      checkpoints++;
      if (hashes.has(r.seq) && hashes.get(r.seq) !== r.hash) problems.push(`checkpoint ${r.seq}: does not match the chain`);
      const v = hybridVerify(key, checkpointMessage(r.seq, r.hash), r.signature);
      if (!v.ok) problems.push(`checkpoint ${r.seq}: ${v.reason}`);
      else if (hashes.get(r.seq) === r.hash) verifiedThrough = r.seq;
    }
  }
  return { ok: problems.length === 0, entries, checkpoints, verifiedThrough, unsignedTail: lastSeq !== undefined ? lastSeq - verifiedThrough : 0, problems };
}

// ─── runtime ────────────────────────────────────────────────────────────────

interface Runtime {
  cfgKey: string;
  c: Parsed;
  keys: { privateKey: HybridPrivateKey; publicKey: HybridPublicKey };
  chain: AuditChain;
}
let rt: Runtime | undefined;

export function pqIdentityOf(cfg: GatewayConfig): Runtime | undefined {
  if (!cfg.pqIdentity) return undefined;
  const c = PqIdentitySchema.parse(cfg.pqIdentity);
  if (!c.enabled) return undefined;
  const base = cfg.configDir ?? process.cwd();
  const keyFile = resolve(base, c.keyFile);
  const cfgKey = JSON.stringify([keyFile, c.keyId, c.auditLog]);
  if (rt?.cfgKey === cfgKey) {
    rt.c = c;
    return rt;
  }
  const keys = loadHybridKey(keyFile);
  const dir = c.auditLog.dir ? resolve(base, c.auditLog.dir) : undefined;
  const chain = rt && rt.chain && JSON.stringify(rt.c.auditLog) === JSON.stringify(c.auditLog) ? rt.chain : undefined;
  const next: Runtime = { cfgKey, c, keys, chain: chain ?? (undefined as unknown as AuditChain) };
  next.chain = chain ?? new AuditChain(() => ({ dir, maxEntries: next.c.auditLog.maxEntries, checkpointEvery: next.c.auditLog.checkpointEvery, keyId: next.c.keyId, key: next.keys.privateKey }));
  rt = next;
  return rt;
}

/** Test helper. */
export function resetPqIdentity(): void {
  rt = undefined;
}

export function identityDocument(r: Runtime, now = new Date()): SignedDocument<Record<string, unknown>> {
  const notBefore = new Date(Math.floor(now.getTime() / 86_400_000) * 86_400_000);
  const payload = {
    type: 'mcp-gateway-identity',
    subject: r.c.gatewayId ?? r.c.keyId,
    keyId: r.c.keyId,
    publicKey: r.keys.publicKey,
    algorithms: { classical: 'Ed25519', postQuantum: r.keys.publicKey.mldsa.alg.toUpperCase(), composition: 'both must verify' },
    notBefore: notBefore.toISOString(),
    notAfter: new Date(notBefore.getTime() + r.c.validityDays * 86_400_000).toISOString(),
  };
  return signDocument(payload, r.c.keyId, r.keys.privateKey, DOMAIN.identity);
}

const audit = (call: HookCall, cfg: GatewayConfig, outcome: AuditEntry['outcome'], code?: number) => {
  try {
    const r = pqIdentityOf(cfg);
    if (r?.c.auditLog.enabled) r.chain.append(call, outcome, code);
  } catch (e) {
    logger.warn(`pq-identity: audit append failed: ${(e as Error).message}`);
  }
};

registerCallHook({
  id: 'pq-identity',
  after: (call, result, cfg) => audit(call, cfg, result.success ? 'success' : 'error', result.success ? undefined : result.error?.code),
  refused: (call, error, cfg) => audit(call, cfg, 'refused', error.code),
});

registerFeature({
  id: 'pq-identity',
  since: '10.8.0',
  summary: 'Post-quantum identity (EXPERIMENTAL): Ed25519 + ML-DSA hybrid signed identity document, tool manifest and audit-log checkpoints',
  mount: (router, ctx) => {
    let timer: NodeJS.Timeout | undefined;
    const tick = () => {
      try {
        const r = pqIdentityOf(ctx.config());
        if (r?.c.auditLog.enabled && r.chain.due(r.c.auditLog.checkpointSeconds)) r.chain.checkpoint();
      } catch {
        /* reported by the routes */
      }
    };
    timer = setInterval(tick, 1000);
    timer.unref?.();
    ctx.onStop?.(() => {
      if (timer) clearInterval(timer);
      timer = undefined;
      try {
        pqIdentityOf(ctx.config())?.chain.checkpoint();
      } catch {
        /* ignore */
      }
    });
    const need = (res: import('express').Response): Runtime | undefined => {
      try {
        const r = pqIdentityOf(ctx.config());
        if (!r) badRequest(res, 'features.pqIdentity is not configured');
        else r.chain.load();
        return r;
      } catch (e) {
        res.status(500).json({ error: 'Internal Server Error', message: `pq-identity key: ${(e as Error).message}` });
        return undefined;
      }
    };
    router.get('/', (_req, res) => {
      const r = need(res);
      if (!r) return;
      const calls = r.chain.records.filter((x) => x.type === 'call').length;
      res.json({ experimental: true, ...pqBackend(), keyId: r.c.keyId, publicKey: r.keys.publicKey, identity: identityDocument(r), audit: { enabled: r.c.auditLog.enabled, persisted: !!r.c.auditLog.dir, seq: r.chain.seq, head: r.chain.head, inMemory: calls } });
    });
    router.get('/audit', (req, res) => {
      const r = need(res);
      if (!r) return;
      const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 1000);
      res.json({ records: r.chain.records.slice(-limit).reverse() });
    });
    router.post('/audit/checkpoint', (_req, res) => {
      const r = need(res);
      if (!r) return;
      res.json({ checkpoint: r.chain.checkpoint() ?? null });
    });
    router.post('/audit/verify', (req, res) => {
      const r = need(res);
      if (!r) return;
      const b = (req.body ?? {}) as { records?: unknown };
      if (b.records !== undefined && !Array.isArray(b.records)) return badRequest(res, '"records" must be an array of audit records');
      res.json(verifyAudit((b.records as AuditRecord[] | undefined) ?? r.chain.records, r.keys.publicKey));
    });
    router.post('/verify', (req, res) => {
      const b = objectBody(req, res);
      if (!b) return;
      const r = need(res);
      if (!r) return;
      const domain = typeof b.domain === 'string' && b.domain in DOMAIN ? DOMAIN[b.domain as keyof typeof DOMAIN] : undefined;
      if (!domain) return badRequest(res, `"domain" must be one of ${Object.keys(DOMAIN).join(', ')}`);
      res.json(verifyDocument(b.document, r.keys.publicKey, domain));
    });
  },
  mountClient: (router, ctx) => {
    const need = (res: import('express').Response): Runtime | undefined => {
      try {
        const r = pqIdentityOf(ctx.config());
        if (!r) res.status(404).json({ error: 'Not Found', message: 'features.pqIdentity is not configured' });
        return r;
      } catch {
        res.status(500).json({ error: 'Internal Server Error', message: 'pq-identity key unavailable' });
        return undefined;
      }
    };
    router.get('/identity', (_req, res) => {
      const r = need(res);
      if (r) res.json(identityDocument(r));
    });
    router.get('/tool-manifest', (req, res) => {
      const r = need(res);
      if (!r) return;
      if (!r.c.toolManifest) return void res.status(404).json({ error: 'Not Found', message: 'toolManifest is disabled' });
      const tools = ctx
        .tools()
        .filter((t) => isToolInScope((req as AuthedRequest).scope, t.serverId, t.name)) // a scoped key sees (and gets signed) only its tools
        .map((t) => ({ server: t.serverId, name: t.name, description: t.description ?? '', inputSchemaSha256: sha256(canonical(t.inputSchema ?? {})) }))
        .sort((a, b) => `${a.server}/${a.name}`.localeCompare(`${b.server}/${b.name}`));
      res.json(signDocument({ type: 'mcp-gateway-tool-manifest', subject: r.c.gatewayId ?? r.c.keyId, issuedAt: new Date().toISOString(), tools }, r.c.keyId, r.keys.privateKey, DOMAIN.manifest));
    });
  },
});
