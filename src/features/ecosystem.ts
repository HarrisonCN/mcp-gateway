/**
 * Ecosystem marketplace GA (9.8): the plugin marketplace (5.4) and tool registry (9.4) become a moderated, rated
 * catalogue with verified publishers.
 *
 * ```yaml
 * ecosystem:
 *   file: ./data/ecosystem.json         # optional persistence
 *   autoApproveVerified: false          # listings of verified publishers skip the review queue
 *   publishers:
 *     - id: acme
 *       name: ACME Corp
 *       domain: acme.example            # verified via https://acme.example/.well-known/mcp-gateway-publisher.json
 *       keyIds: [acme-2026]             # signing keys (pluginTrust / toolRegistry) that belong to the publisher
 * ```
 *
 * Lifecycle: a client submits a listing (`POST /api/v1/features/ecosystem/submissions`) → it waits in the review
 * queue (`pending`) → an operator approves or rejects it with a reason → approved listings appear in the public
 * catalogue with ratings. Each client rates a listing once (1–5 stars, optional comment; re-rating replaces it);
 * operators can hide abusive reviews. Publisher verification fetches the domain's well-known file and checks that it
 * names the publisher and its key ids.
 *
 * - Clients: `GET /api/v1/features/ecosystem/catalog?q=&kind=&tag=` · `POST …/submissions` ·
 *   `POST …/listings/:id/ratings` `{ stars, comment? }` · `GET …/listings/:id`.
 * - Operators: `GET /admin/ecosystem` (queue, stats) · `POST /admin/ecosystem/listings/:id/approve` ·
 *   `…/reject` `{ reason }` · `POST /admin/ecosystem/reviews/:listing/:client/hide` ·
 *   `POST /admin/ecosystem/publishers/:id/verify`.
 *
 * @module features/ecosystem
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { z } from 'zod';
import { registerFeature, objectBody, badRequest, clientIdOf } from '../gateway/features.js';
import { logger } from '../utils/logger.js';
import type { GatewayConfig } from '../utils/types.js';
import { type EcosystemConfig, EcosystemSchema, ID } from './schemas/ecosystem.js';
export { type EcosystemConfig, EcosystemSchema } from './schemas/ecosystem.js';
const ListingInput = z
  .object({
    name: z.string().regex(ID),
    version: z.string().regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/),
    kind: z.enum(['plugin', 'tool', 'wasm-tool']),
    publisher: z.string().regex(ID),
    description: z.string().max(2000).default(''),
    url: z.string().url(),
    sha256: z.string().regex(/^[0-9a-f]{64}$/).optional(),
    keyId: z.string().optional(),
    tags: z.array(z.string().regex(/^[a-z0-9-]{1,32}$/)).max(10).default([]),
    homepage: z.string().url().optional(),
  })
  .strict();

export interface Review {
  client: string;
  stars: number;
  comment: string;
  at: string;
  hidden: boolean;
}
export interface Listing extends z.output<typeof ListingInput> {
  id: string;
  status: 'pending' | 'approved' | 'rejected';
  reason: string | null;
  submittedBy: string;
  submittedAt: string;
  reviewedAt: string | null;
  reviews: Review[];
}

/** Runtime state; exported for tests. */
export const ecosystemState = {
  listings: new Map<string, Listing>(),
  verified: new Map<string, { at: string; domain: string }>(),
  loadedFrom: undefined as string | undefined,
  reset() {
    this.listings.clear();
    this.verified.clear();
    this.loadedFrom = undefined;
  },
};

const settings = (cfg: GatewayConfig) => {
  if (!cfg.ecosystem) return undefined;
  const c = EcosystemSchema.parse(cfg.ecosystem);
  return c.enabled ? c : undefined;
};
type S = NonNullable<ReturnType<typeof settings>>;
function load(s: S) {
  if (!s.file || ecosystemState.loadedFrom === s.file) return;
  ecosystemState.loadedFrom = s.file;
  if (!existsSync(s.file)) return;
  try {
    const d = JSON.parse(readFileSync(s.file, 'utf8')) as { listings?: Listing[]; verified?: Array<[string, { at: string; domain: string }]> };
    for (const l of d.listings ?? []) ecosystemState.listings.set(l.id, l);
    for (const [k, v] of d.verified ?? []) ecosystemState.verified.set(k, v);
  } catch (e) {
    logger.error(`ecosystem: cannot read ${s.file}: ${(e as Error).message}`);
  }
}
function save(s: S) {
  if (!s.file) return;
  mkdirSync(dirname(s.file), { recursive: true });
  writeFileSync(s.file, JSON.stringify({ listings: [...ecosystemState.listings.values()], verified: [...ecosystemState.verified] }, null, 1));
}

const visibleReviews = (l: Listing) => l.reviews.filter((r) => !r.hidden);
export function rating(l: Listing): { average: number | null; count: number } {
  const rs = visibleReviews(l);
  return { average: rs.length ? Math.round((rs.reduce((a, r) => a + r.stars, 0) / rs.length) * 100) / 100 : null, count: rs.length };
}
const publisherOf = (s: S, id: string) => {
  const p = s.publishers.find((x) => x.id === id);
  return { id, name: p?.name ?? id, verified: !!p && ecosystemState.verified.has(id) };
};
const publicView = (s: S, l: Listing) => ({
  id: l.id, name: l.name, version: l.version, kind: l.kind, description: l.description, url: l.url, sha256: l.sha256 ?? null, keyId: l.keyId ?? null, tags: l.tags, homepage: l.homepage ?? null,
  publisher: publisherOf(s, l.publisher), rating: rating(l),
});

/** Verify a publisher's domain via its well-known file (exported for tests). */
export async function verifyPublisher(cfg: GatewayConfig, id: string): Promise<{ ok: true } | { ok: false; reason: string }> {
  const s = settings(cfg);
  const p = s?.publishers.find((x) => x.id === id);
  if (!s || !p) return { ok: false, reason: `unknown publisher "${id}"` };
  if (!p.domain && !p.wellKnownUrl) return { ok: false, reason: 'publisher has no domain' };
  const url = p.wellKnownUrl ?? `https://${p.domain}/.well-known/mcp-gateway-publisher.json`;
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(10_000), redirect: 'error' });
    if (!r.ok) return { ok: false, reason: `${url}: HTTP ${r.status}` };
    const d = (await r.json()) as { publisher?: unknown; keyIds?: unknown };
    if (d.publisher !== p.id) return { ok: false, reason: `${url} names publisher ${JSON.stringify(d.publisher)}, not "${p.id}"` };
    const keys = Array.isArray(d.keyIds) ? d.keyIds.map(String) : [];
    const missing = p.keyIds.filter((k) => !keys.includes(k));
    if (missing.length) return { ok: false, reason: `${url} does not list key ids ${missing.join(', ')}` };
    ecosystemState.verified.set(p.id, { at: new Date().toISOString(), domain: p.domain ?? new URL(url).host });
    save(s);
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: `${url}: ${(e as Error).message}` };
  }
}

registerFeature({
  id: 'ecosystem',
  since: '9.8.0',
  summary: 'Ecosystem marketplace GA: moderated catalogue of plugins and tools, ratings and reviews, verified publishers',
  mount(router, ctx) {
    const st = () => {
      const s = settings(ctx.config());
      if (s) load(s);
      return s;
    };
    router.get('/', (_req, res) => {
      const s = st();
      const all = [...ecosystemState.listings.values()];
      res.json({
        enabled: !!s,
        stats: { listings: all.length, pending: all.filter((l) => l.status === 'pending').length, approved: all.filter((l) => l.status === 'approved').length, rejected: all.filter((l) => l.status === 'rejected').length, reviews: all.reduce((a, l) => a + l.reviews.length, 0) },
        queue: all.filter((l) => l.status === 'pending').map((l) => ({ id: l.id, name: l.name, version: l.version, kind: l.kind, publisher: s ? publisherOf(s, l.publisher) : { id: l.publisher }, submittedBy: l.submittedBy, submittedAt: l.submittedAt })),
        publishers: (s?.publishers ?? []).map((p) => ({ id: p.id, name: p.name, domain: p.domain ?? null, keyIds: p.keyIds, verified: ecosystemState.verified.has(p.id), verifiedAt: ecosystemState.verified.get(p.id)?.at ?? null })),
        listings: all.map((l) => ({ id: l.id, status: l.status, reason: l.reason, rating: rating(l), hiddenReviews: l.reviews.filter((r) => r.hidden).length })),
      });
    });
    const decide = (status: 'approved' | 'rejected') => (req: import('express').Request, res: import('express').Response) => {
      const s = st();
      const l = ecosystemState.listings.get(String(req.params.id));
      if (!s || !l) return void res.status(404).json({ error: 'Not Found', message: `no listing "${req.params.id}"` });
      const reason = req.body && typeof req.body === 'object' && typeof (req.body as { reason?: unknown }).reason === 'string' ? (req.body as { reason: string }).reason : null;
      if (status === 'rejected' && !reason) return badRequest(res, 'a rejection needs a "reason"');
      Object.assign(l, { status, reason, reviewedAt: new Date().toISOString() });
      save(s);
      res.json({ id: l.id, status: l.status, reason: l.reason });
    };
    router.post('/listings/:id/approve', decide('approved'));
    router.post('/listings/:id/reject', decide('rejected'));
    router.post('/reviews/:listing/:client/hide', (req, res) => {
      const s = st();
      const l = ecosystemState.listings.get(String(req.params.listing));
      const r = l?.reviews.find((x) => x.client === req.params.client);
      if (!s || !l || !r) return void res.status(404).json({ error: 'Not Found', message: 'no such review' });
      r.hidden = true;
      save(s);
      res.json({ listing: l.id, client: r.client, hidden: true, rating: rating(l) });
    });
    router.post('/publishers/:id/verify', async (req, res) => {
      if (!st()) return badRequest(res, 'ecosystem is not enabled');
      const r = await verifyPublisher(ctx.config(), String(req.params.id));
      if (!r.ok) return badRequest(res, `verification failed: ${r.reason}`);
      res.json({ id: req.params.id, verified: true });
    });
  },
  mountClient(router, ctx) {
    const st = () => {
      const s = settings(ctx.config());
      if (s) load(s);
      return s;
    };
    router.get('/catalog', (req, res) => {
      const s = st();
      if (!s) return void res.json({ count: 0, listings: [] });
      const q = String(req.query.q ?? '').toLowerCase();
      const list = [...ecosystemState.listings.values()]
        .filter((l) => l.status === 'approved')
        .filter((l) => !q || `${l.name} ${l.description} ${l.publisher}`.toLowerCase().includes(q))
        .filter((l) => !req.query.kind || l.kind === req.query.kind)
        .filter((l) => !req.query.tag || l.tags.includes(String(req.query.tag)))
        .map((l) => publicView(s, l))
        .sort((a, b) => Number(b.publisher.verified) - Number(a.publisher.verified) || (b.rating.average ?? 0) - (a.rating.average ?? 0) || a.name.localeCompare(b.name));
      res.json({ count: list.length, listings: list });
    });
    router.get('/listings/:id', (req, res) => {
      const s = st();
      const l = ecosystemState.listings.get(String(req.params.id));
      if (!s || !l || l.status !== 'approved') return void res.status(404).json({ error: 'Not Found', message: `no listing "${req.params.id}"` });
      res.json({ ...publicView(s, l), reviews: visibleReviews(l).map((r) => ({ stars: r.stars, comment: r.comment, at: r.at })) });
    });
    router.post('/submissions', (req, res) => {
      const s = st();
      if (!s) return badRequest(res, 'ecosystem is not enabled');
      const b = objectBody(req, res);
      if (!b) return;
      const p = ListingInput.safeParse(b);
      if (!p.success) return badRequest(res, p.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
      const id = `${p.data.publisher}.${p.data.name}@${p.data.version}`;
      if (ecosystemState.listings.has(id)) return void res.status(409).json({ error: 'Conflict', message: `${id} was already submitted` });
      const auto = s.autoApproveVerified && publisherOf(s, p.data.publisher).verified;
      const l: Listing = { ...p.data, id, status: auto ? 'approved' : 'pending', reason: auto ? 'auto-approved (verified publisher)' : null, submittedBy: clientIdOf(req) ?? 'anonymous', submittedAt: new Date().toISOString(), reviewedAt: auto ? new Date().toISOString() : null, reviews: [] };
      ecosystemState.listings.set(id, l);
      save(s);
      res.status(202).json({ id, status: l.status });
    });
    router.post('/listings/:id/ratings', (req, res) => {
      const s = st();
      const l = ecosystemState.listings.get(String(req.params.id));
      if (!s || !l || l.status !== 'approved') return void res.status(404).json({ error: 'Not Found', message: `no listing "${req.params.id}"` });
      const b = objectBody(req, res);
      if (!b) return;
      const stars = b.stars;
      if (typeof stars !== 'number' || !Number.isInteger(stars) || stars < 1 || stars > 5) return badRequest(res, '"stars" must be an integer 1..5');
      const comment = typeof b.comment === 'string' ? b.comment.slice(0, 1000) : '';
      const client = clientIdOf(req) ?? 'anonymous';
      const prev = l.reviews.find((r) => r.client === client);
      if (prev) Object.assign(prev, { stars, comment, at: new Date().toISOString() });
      else l.reviews.push({ client, stars, comment, at: new Date().toISOString(), hidden: false });
      save(s);
      res.json({ id: l.id, rating: rating(l) });
    });
  },
});
