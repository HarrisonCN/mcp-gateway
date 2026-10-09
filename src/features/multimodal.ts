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
 * ```
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

import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { registerFeature } from '../gateway/features.js';
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
  })
  .strict()
  .refine((c) => c.maxItemBytes <= c.maxTotalBytes, { message: 'maxItemBytes must not exceed maxTotalBytes', path: ['maxItemBytes'] });
export type MultimodalConfig = z.input<typeof MultimodalSchema>;
type Mm = z.output<typeof MultimodalSchema>;

interface Blob {
  data: Buffer;
  mimeType: string;
  serverId: string;
  tool: string;
  expires: number;
}

/** Runtime state; exported for tests. */
export const multimodalState = {
  blobs: new Map<string, Blob>(),
  stats: { results: 0, items: 0, bytes: 0, refused: 0, stripped: 0, offloaded: 0 },
  reset() {
    this.blobs.clear();
    this.stats = { results: 0, items: 0, bytes: 0, refused: 0, stripped: 0, offloaded: 0 };
  },
};

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
  for (const [id, b] of multimodalState.blobs) if (b.expires <= now) multimodalState.blobs.delete(id);
}

/** Apply the multimodal policy to one tool result (exported for tests). */
export function applyMultimodal(result: ProxyResponse, serverId: string, tool: string, cfg: GatewayConfig, now = Date.now()): ProxyResponse | undefined {
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
      sweep(now);
      while (multimodalState.blobs.size >= p.maxBlobs) multimodalState.blobs.delete(multimodalState.blobs.keys().next().value as string);
      const id = randomUUID();
      multimodalState.blobs.set(id, { data: Buffer.from(bin.b64, 'base64'), mimeType: bin.mimeType, serverId, tool, expires: now + p.blobTtlSeconds * 1000 });
      st.offloaded++;
      changed = true;
      out.push({ type: 'resource_link', uri: `/api/v1/features/multimodal/blobs/${id}`, name: `${tool}-${raw.type}`, mimeType: bin.mimeType, size, _meta: { 'mcp-gateway/offloaded': true, expiresAt: new Date(now + p.blobTtlSeconds * 1000).toISOString() } });
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
    return applyMultimodal(result, call.serverId, call.tool, cfg);
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
        blobs: [...multimodalState.blobs].map(([id, b]) => ({ id, mimeType: b.mimeType, bytes: b.data.length, serverId: b.serverId, tool: b.tool, expiresAt: new Date(b.expires).toISOString() })),
      });
    });
    router.delete('/blobs', (_req, res) => {
      const dropped = multimodalState.blobs.size;
      multimodalState.blobs.clear();
      res.json({ dropped });
    });
  },
  mountClient(router) {
    router.get('/blobs/:id', (req, res) => {
      sweep();
      const b = multimodalState.blobs.get(String(req.params.id));
      if (!b) return void res.status(404).json({ error: 'Not Found', message: 'blob expired or unknown' });
      let start = 0;
      let end = b.data.length - 1;
      const range = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range ?? ''));
      if (range && (range[1] || range[2])) {
        if (range[1]) {
          start = Number(range[1]);
          if (range[2]) end = Math.min(Number(range[2]), end);
        } else start = Math.max(0, b.data.length - Number(range[2]));
        if (start > end || start >= b.data.length) return void res.status(416).setHeader('Content-Range', `bytes */${b.data.length}`).end();
        res.status(206).setHeader('Content-Range', `bytes ${start}-${end}/${b.data.length}`);
      }
      res.setHeader('Content-Type', b.mimeType);
      res.setHeader('Content-Length', String(end - start + 1));
      res.setHeader('Accept-Ranges', 'bytes');
      res.setHeader('Cache-Control', 'private, no-store');
      let off = start;
      const pump = () => {
        while (off <= end) {
          const chunk = b.data.subarray(off, Math.min(off + CHUNK, end + 1));
          off += chunk.length;
          if (!res.write(chunk)) return void res.once('drain', pump);
        }
        res.end();
      };
      pump();
    });
  },
});
