/**
 * Multimodal tools (9.1): policy, limits and streaming for binary tool content — `image`, `audio` and embedded
 * `resource` blobs in MCP tool results.
 *
 * ```yaml
 * multimodal:
 *   allowedTypes: ["image/*", "audio/mpeg", "audio/wav"]   # MIME globs (default: image/* and audio/*)
 *   maxItemBytes: 10485760        # per content item (decoded); larger items are refused or dropped
 *   maxTotalBytes: 33554432       # per tool result
 *   onViolation: refuse           # refuse (JSON-RPC -32022) | strip (drop the item, add a text note)
 *   offloadAboveBytes: 262144     # larger allowed items are kept by the gateway and streamed from a link
 *   blobTtlSeconds: 600
 *   servers: ["*"]                # server globs the policy applies to
 *   maxStoredBytes: 268435456     # 11.2: global budget for held blobs (LRU eviction, then refuse/strip)
 *   maxTenantStoredBytes: 67108864  # 11.2: per-tenant (or per-client without tenant) budget
 *   storage: { type: memory }     # 11.2: memory | filesystem ({ dir }) — a shared volume for several instances
 *   signedLinks: { key: ${BLOB_LINK_KEY}, ttlSeconds: 300 }  # 11.2: HMAC links bound to the owner, with expiry
 * ```
 *
 * 11.2 security: each held blob is bound to its owner (client id, tenant) and the `server/tool` that produced it. A read
 * is re-authorized through the central authorizer (the reader must still be allowed to call that tool) and allowed only
 * for the same client or a member of the owning tenant; anyone else gets `404`. Ids are 192-bit random.
 *
 * Offloaded items are replaced by a `resource_link` whose `uri` is `/api/v1/features/multimodal/blobs/<id>`; the
 * blob is streamed in 64 KiB chunks with its `Content-Type`, `Content-Length` and `Range` support, so clients do not
 * have to hold multi-megabyte base64 strings inside JSON-RPC messages.
 *
 * - `GET /admin/multimodal` — policy, counters (items, bytes, refused, stripped, offloaded) and held blobs.
 * - `DELETE /admin/multimodal/blobs` — drop every held blob.
 * - `GET /api/v1/features/multimodal/blobs/:id` — stream a held blob (any authenticated client).
 *
 * @module features/multimodal
 */

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import { registerFeature, principalOf } from '../gateway/features.js';
import { authorize, type Principal } from '../auth/authorizer.js';
import { registerMetricSource } from '../monitor/index.js';
import { registerCallHook } from '../gateway/hooks.js';
import { globToRegExp } from '../utils/tool-filter.js';
import type { GatewayConfig, ProxyResponse } from '../utils/types.js';

/** JSON-RPC error when a tool result breaks the multimodal policy (9.1). */
export const ERR_MEDIA_REFUSED = -32022;
const CHUNK = 64 * 1024;

export const MultimodalSchema = z
  .object({
    enabled: z.boolean().default(true),
    allowedTypes: z.array(z.string().min(1)).default(['image/*', 'audio/*']),
    maxItemBytes: z.number().int().min(1).default(10 * 1024 * 1024),
    maxTotalBytes: z.number().int().min(1).default(32 * 1024 * 1024),
    onViolation: z.enum(['refuse', 'strip']).default('refuse'),
    offloadAboveBytes: z.number().int().min(1).optional(),
    blobTtlSeconds: z.number().int().min(1).max(86_400).default(600),
    maxBlobs: z.number().int().min(1).default(256),
    servers: z.array(z.string().min(1)).default(['*']),
    maxStoredBytes: z.number().int().min(1).default(256 * 1024 * 1024),
    maxTenantStoredBytes: z.number().int().min(1).default(64 * 1024 * 1024),
    storage: z
      .discriminatedUnion('type', [z.object({ type: z.literal('memory') }).strict(), z.object({ type: z.literal('filesystem'), dir: z.string().min(1) }).strict()])
      .default({ type: 'memory' }),
    signedLinks: z.object({ key: z.string().min(32, 'signedLinks.key must be at least 32 characters'), ttlSeconds: z.number().int().min(10).max(86_400).default(300) }).strict().optional(),
  })
  .strict()
  .refine((c) => c.maxItemBytes <= c.maxTotalBytes, { message: 'maxItemBytes must not exceed maxTotalBytes', path: ['maxItemBytes'] });
export type MultimodalConfig = z.input<typeof MultimodalSchema>;
type Mm = z.output<typeof MultimodalSchema>;

/** Owner of a held blob (11.2). */
export interface BlobOwner {
  /** Principal id (`key:alice`, `jwt:…`, `system:…`). */
  clientId: string;
  /** Tenant of the caller, when tenants are configured. */
  tenant?: string;
}

interface Blob {
  /** In memory, or undefined when the bytes live in `storage.dir`. */
  data?: Buffer;
  size: number;
  mimeType: string;
  serverId: string;
  tool: string;
  expires: number;
  owner?: BlobOwner;
  /** Budget bucket: `tenant:<id>` or `client:<id>`. */
  bucket: string;
  lastAccess: number;
}

const emptyStats = () => ({ results: 0, items: 0, bytes: 0, refused: 0, stripped: 0, offloaded: 0, evicted: 0, overBudget: 0, deniedReads: 0, heldBytes: 0 });
/** Runtime state; exported for tests. */
export const multimodalState = {
  blobs: new Map<string, Blob>(),
  stats: emptyStats(),
  dir: undefined as string | undefined,
  reset() {
    for (const id of [...this.blobs.keys()]) dropBlob(id);
    this.blobs.clear();
    this.stats = emptyStats();
  },
};

const heldBytes = () => {
  let n = 0;
  for (const b of multimodalState.blobs.values()) n += b.size;
  return n;
};
function dropBlob(id: string): void {
  const b = multimodalState.blobs.get(id);
  multimodalState.blobs.delete(id);
  if (b && !b.data && multimodalState.dir) rmSync(join(multimodalState.dir, `${id}.bin`), { force: true });
  multimodalState.stats.heldBytes = heldBytes();
}
function blobBytes(id: string, b: Blob): Buffer | undefined {
  if (b.data) return b.data;
  if (!multimodalState.dir) return undefined;
  try {
    return readFileSync(join(multimodalState.dir, `${id}.bin`));
  } catch {
    return undefined;
  }
}
const bucketOf = (o: BlobOwner | undefined) => (o?.tenant ? `tenant:${o.tenant}` : `client:${o?.clientId ?? 'unknown'}`);

/**
 * Make room for `size` bytes in `bucket` (11.2): drop expired blobs, then least-recently-used blobs of the bucket
 * (tenant budget) and of everyone (global budget / maxBlobs). Returns false when the item cannot fit at all.
 */
function reserve(p: Mm, bucket: string, size: number, now: number): boolean {
  if (size > p.maxStoredBytes || size > p.maxTenantStoredBytes) return false;
  sweep(now);
  const lru = (filter?: string) =>
    [...multimodalState.blobs].filter(([, b]) => !filter || b.bucket === filter).sort((a, b) => a[1].lastAccess - b[1].lastAccess);
  let inBucket = 0;
  for (const b of multimodalState.blobs.values()) if (b.bucket === bucket) inBucket += b.size;
  for (const [id, b] of lru(bucket)) {
    if (inBucket + size <= p.maxTenantStoredBytes) break;
    inBucket -= b.size;
    dropBlob(id);
    multimodalState.stats.evicted++;
  }
  let total = heldBytes();
  for (const [id, b] of lru()) {
    if (total + size <= p.maxStoredBytes && multimodalState.blobs.size < p.maxBlobs) break;
    total -= b.size;
    dropBlob(id);
    multimodalState.stats.evicted++;
  }
  return true;
}

/** HMAC signature of a blob link (11.2): bound to the blob id, its owner and an expiry. */
export function signBlobLink(key: string, id: string, owner: string, exp: number): string {
  return createHmac('sha256', key).update(`${id}|${owner}|${exp}`).digest('base64url');
}
const safeEq = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

/** Whether `reader` may read a blob owned by `b.owner` (11.2). Unowned blobs are readable by nobody. */
export function mayRead(reader: Principal, b: { owner?: BlobOwner; serverId: string; tool: string }): boolean {
  if (!b.owner) return false;
  const same = reader.id === b.owner.clientId;
  const tenantMate = !!b.owner.tenant && !!reader.scope?.tenants?.some((t) => t.id === b.owner!.tenant);
  if (!same && !tenantMate) return false;
  return !authorize(reader, { serverId: b.serverId, name: b.tool, kind: 'tool' });
}

registerMetricSource('multimodal', () => {
  const s = multimodalState.stats;
  return [
    '# HELP mcp_gateway_multimodal_held_bytes Bytes of offloaded blobs currently held',
    '# TYPE mcp_gateway_multimodal_held_bytes gauge',
    `mcp_gateway_multimodal_held_bytes ${s.heldBytes}`,
    '# TYPE mcp_gateway_multimodal_evicted_total counter',
    `mcp_gateway_multimodal_evicted_total ${s.evicted}`,
    '# TYPE mcp_gateway_multimodal_over_budget_total counter',
    `mcp_gateway_multimodal_over_budget_total ${s.overBudget}`,
    '# TYPE mcp_gateway_multimodal_denied_reads_total counter',
    `mcp_gateway_multimodal_denied_reads_total ${s.deniedReads}`,
  ];
});

const policy = (cfg: GatewayConfig): Mm | undefined => {
  if (!cfg.multimodal) return undefined;
  const c = MultimodalSchema.parse(cfg.multimodal);
  return c.enabled ? c : undefined;
};
const glob = (gs: string[], s: string) => gs.some((g) => globToRegExp(g).test(s));
/** Decoded size of a base64 string without decoding it. */
export const base64Bytes = (b64: string): number => {
  const s = b64.replace(/\s/g, '');
  return Math.floor((s.length * 3) / 4) - (s.endsWith('==') ? 2 : s.endsWith('=') ? 1 : 0);
};

type Item = Record<string, unknown>;
/** The binary payload of a content item, when it has one. */
function binary(it: Item): { b64: string; mimeType: string } | undefined {
  if ((it.type === 'image' || it.type === 'audio') && typeof it.data === 'string') {
    return { b64: it.data, mimeType: String(it.mimeType ?? 'application/octet-stream') };
  }
  const r = it.resource as Item | undefined;
  if (it.type === 'resource' && r && typeof r.blob === 'string') {
    return { b64: r.blob, mimeType: String(r.mimeType ?? 'application/octet-stream') };
  }
  return undefined;
}

function sweep(now = Date.now()): void {
  for (const [id, b] of multimodalState.blobs) if (b.expires <= now) dropBlob(id);
}

/** Point the store at `storage` (memory, or a directory shared between instances). */
function useStorage(p: Mm, baseDir: string): void {
  const dir = p.storage.type === 'filesystem' ? resolve(baseDir, p.storage.dir) : undefined;
  if (dir === multimodalState.dir) return;
  multimodalState.dir = dir;
  if (dir) mkdirSync(dir, { recursive: true, mode: 0o700 });
}

/** Blob metadata from the shared directory (another instance offloaded it). */
function fromDisk(id: string): Blob | undefined {
  const dir = multimodalState.dir;
  if (!dir || !/^[A-Za-z0-9_-]{16,64}$/.test(id) || !existsSync(join(dir, `${id}.json`))) return undefined;
  try {
    const m = JSON.parse(readFileSync(join(dir, `${id}.json`), 'utf8')) as Omit<Blob, 'data' | 'lastAccess'>;
    return { ...m, lastAccess: Date.now() };
  } catch {
    return undefined;
  }
}
/** Number of blob files in the shared directory (for tests / admin). */
export const storedFiles = (): number => (multimodalState.dir && existsSync(multimodalState.dir) ? readdirSync(multimodalState.dir).filter((f) => f.endsWith('.bin')).length : 0);

/** Apply the multimodal policy to one tool result (exported for tests). */
export function applyMultimodal(result: ProxyResponse, serverId: string, tool: string, cfg: GatewayConfig, now = Date.now(), owner?: BlobOwner): ProxyResponse | undefined {
  const p = policy(cfg);
  if (!p || !result.success || !glob(p.servers, serverId)) return undefined;
  const res = result.result as { content?: unknown } | undefined;
  if (!res || !Array.isArray(res.content)) return undefined;
  const st = multimodalState.stats;
  let total = 0;
  let changed = false;
  const out: Item[] = [];
  for (const raw of res.content as Item[]) {
    const bin = raw && typeof raw === 'object' ? binary(raw) : undefined;
    if (!bin) {
      out.push(raw);
      continue;
    }
    const size = base64Bytes(bin.b64);
    st.items++;
    let why: string | undefined;
    if (!glob(p.allowedTypes, bin.mimeType)) why = `content type ${bin.mimeType} is not allowed`;
    else if (size > p.maxItemBytes) why = `${raw.type} item of ${size} bytes exceeds maxItemBytes ${p.maxItemBytes}`;
    else if (total + size > p.maxTotalBytes) why = `result exceeds maxTotalBytes ${p.maxTotalBytes}`;
    if (why) {
      if (p.onViolation === 'refuse') {
        st.refused++;
        return { success: false, error: { code: ERR_MEDIA_REFUSED, message: `multimodal: ${why}`, data: { serverId, tool, mimeType: bin.mimeType, bytes: size } }, durationMs: result.durationMs };
      }
      st.stripped++;
      changed = true;
      out.push({ type: 'text', text: `[mcp-gateway: ${raw.type} removed — ${why}]` });
      continue;
    }
    total += size;
    st.bytes += size;
    if (p.offloadAboveBytes !== undefined && size > p.offloadAboveBytes) {
      useStorage(p, cfg.configDir ?? process.cwd());
      const bucket = bucketOf(owner);
      if (!reserve(p, bucket, size, now)) {
        st.overBudget++;
        const why2 = `${raw.type} item of ${size} bytes does not fit the blob budget (maxStoredBytes ${p.maxStoredBytes}, maxTenantStoredBytes ${p.maxTenantStoredBytes})`;
        if (p.onViolation === 'refuse') {
          st.refused++;
          return { success: false, error: { code: ERR_MEDIA_REFUSED, message: `multimodal: ${why2}`, data: { serverId, tool, mimeType: bin.mimeType, bytes: size } }, durationMs: result.durationMs };
        }
        st.stripped++;
        changed = true;
        out.push({ type: 'text', text: `[mcp-gateway: ${raw.type} removed — ${why2}]` });
        continue;
      }
      const id = randomBytes(24).toString('base64url');
      const expires = now + p.blobTtlSeconds * 1000;
      const data = Buffer.from(bin.b64, 'base64');
      const meta: Blob = { size: data.length, mimeType: bin.mimeType, serverId, tool, expires, owner, bucket, lastAccess: now };
      if (multimodalState.dir) {
        writeFileSync(join(multimodalState.dir, `${id}.bin`), data, { mode: 0o600 });
        writeFileSync(join(multimodalState.dir, `${id}.json`), JSON.stringify(meta), { mode: 0o600 });
        multimodalState.blobs.set(id, meta);
      } else multimodalState.blobs.set(id, { ...meta, data });
      st.heldBytes = heldBytes();
      st.offloaded++;
      changed = true;
      let uri = `/api/v1/features/multimodal/blobs/${id}`;
      if (p.signedLinks) {
        const exp = Math.floor(Math.min(expires, now + p.signedLinks.ttlSeconds * 1000) / 1000);
        uri += `?exp=${exp}&sig=${signBlobLink(p.signedLinks.key, id, owner?.clientId ?? '', exp)}`;
      }
      out.push({ type: 'resource_link', uri, name: `${tool}-${raw.type}`, mimeType: bin.mimeType, size, _meta: { 'mcp-gateway/offloaded': true, expiresAt: new Date(expires).toISOString() } });
      continue;
    }
    out.push(raw);
  }
  st.results++;
  return changed ? { ...result, result: { ...(res as object), content: out } } : undefined;
}

registerCallHook({
  id: 'multimodal',
  after(call, result, cfg) {
    return applyMultimodal(result, call.serverId, call.tool, cfg, Date.now(), { clientId: call.principal?.id ?? call.clientId ?? 'anonymous', ...(call.tenant ? { tenant: call.tenant } : {}) });
  },
});

registerFeature({
  id: 'multimodal',
  since: '9.1.0',
  summary: 'Multimodal tools: content-type policy and size limits for image / audio / blob results, offloaded and streamed in chunks',
  mount(router, ctx) {
    router.get('/', (_req, res) => {
      sweep();
      const p = policy(ctx.config());
      res.json({
        enabled: !!p,
        policy: p ?? null,
        stats: multimodalState.stats,
        storage: p?.storage.type ?? 'memory',
        blobs: [...multimodalState.blobs].map(([id, b]) => ({ id, mimeType: b.mimeType, bytes: b.size, serverId: b.serverId, tool: b.tool, owner: b.owner?.clientId ?? null, tenant: b.owner?.tenant ?? null, expiresAt: new Date(b.expires).toISOString() })),
      });
    });
    router.delete('/blobs', (_req, res) => {
      const dropped = multimodalState.blobs.size;
      for (const id of [...multimodalState.blobs.keys()]) dropBlob(id);
      res.json({ dropped });
    });
  },
  mountClient(router, ctx) {
    router.get('/blobs/:id', (req, res) => {
      const now = Date.now();
      sweep(now);
      const p = policy(ctx.config());
      if (p) useStorage(p, ctx.config().configDir ?? process.cwd());
      const id = String(req.params.id);
      const notFound = () => void res.status(404).json({ error: 'Not Found', message: 'blob expired or unknown' });
      const b = multimodalState.blobs.get(id) ?? fromDisk(id);
      if (!b || b.expires <= now) return notFound();
      // 11.2: ownership + re-authorization; non-owners get the same 404 as unknown ids.
      if (!mayRead(principalOf(req), b)) {
        multimodalState.stats.deniedReads++;
        return notFound();
      }
      if (p?.signedLinks) {
        const exp = Number(req.query.exp);
        const sig = typeof req.query.sig === 'string' ? req.query.sig : '';
        if (!Number.isFinite(exp) || exp * 1000 <= now || !safeEq(sig, signBlobLink(p.signedLinks.key, id, b.owner?.clientId ?? '', exp))) {
          multimodalState.stats.deniedReads++;
          return notFound();
        }
      }
      const data = blobBytes(id, b);
      if (!data) return notFound();
      b.lastAccess = now;
      let start = 0;
      let end = data.length - 1;
      const range = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range ?? ''));
      if (range && (range[1] || range[2])) {
        if (range[1]) {
          start = Number(range[1]);
          if (range[2]) end = Math.min(Number(range[2]), end);
        } else start = Math.max(0, data.length - Number(range[2]));
        if (start > end || start >= data.length) return void res.status(416).setHeader('Content-Range', `bytes */${data.length}`).end();
        res.status(206).setHeader('Content-Range', `bytes ${start}-${end}/${data.length}`);
      }
      res.setHeader('Content-Type', b.mimeType);
      res.setHeader('Content-Length', String(end - start + 1));
      res.setHeader('Accept-Ranges', 'bytes');
      res.setHeader('Cache-Control', 'private, no-store');
      let off = start;
      const pump = () => {
        while (off <= end) {
          const chunk = data.subarray(off, Math.min(off + CHUNK, end + 1));
          off += chunk.length;
          if (!res.write(chunk)) return void res.once('drain', pump);
        }
        res.end();
      };
      pump();
    });
  },
});
