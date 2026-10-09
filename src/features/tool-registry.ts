/**
 * Global tool registry (9.4): publish, discover and verify signed tool manifests across organisations and gateways,
 * with mirrors and version pins.
 *
 * ```yaml
 * toolRegistry:
 *   file: ./data/registry.json          # optional persistence of the local registry
 *   trustedPublishers:                  # publisher id -> Ed25519 / ECDSA / RSA public key (PEM)
 *     acme: "-----BEGIN PUBLIC KEY-----…"
 *   requireSignature: true              # unsigned / unverifiable manifests are refused
 *   mirrors:                            # other registries (any gateway exposes its index)
 *     - url: https://gw.partner.example/api/v1/features/tool-registry/index.json
 *       apiKey: ${PARTNER_KEY}
 *       everySeconds: 3600
 *   pins: { "acme/search": "^1.2.0" }   # what `resolve` returns for a tool
 * ```
 *
 * A manifest: `{ publisher, name, version (semver), description, tools: [{ name, description, inputSchema }],
 * server: { transport, command?, args?, url? }, homepage? }`; the signature is over its canonical JSON (sorted keys).
 * Versions are immutable: republishing the same version with different content is refused.
 *
 * - `GET  /admin/tool-registry?q=` — search (publisher, name, description, tool names); latest version of each entry.
 * - `GET  /admin/tool-registry/:publisher/:name` — every version, signature state and origin (local / mirror url).
 * - `GET  /admin/tool-registry/:publisher/:name/resolve?range=` — highest version matching the range or the pin.
 * - `POST /admin/tool-registry/publish` `{ manifest, signature }` · `POST /admin/tool-registry/sync` (pull mirrors now).
 * - `GET  /api/v1/features/tool-registry/index.json` — this gateway's registry for mirrors (any authenticated client).
 *
 * @module features/tool-registry
 */

import { createPublicKey, verify } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { z } from 'zod';
import { registerFeature, objectBody, badRequest } from '../gateway/features.js';
import { canonicalJson } from '../gateway/cache.js';
import { logger } from '../utils/logger.js';
import type { GatewayConfig } from '../utils/types.js';

const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;
const ID = /^[a-z0-9][a-z0-9._-]*$/;

export const ToolRegistrySchema = z
  .object({
    enabled: z.boolean().default(true),
    file: z.string().min(1).optional(),
    trustedPublishers: z.record(z.string().min(1)).default({}),
    requireSignature: z.boolean().default(true),
    mirrors: z.array(z.object({ url: z.string().url(), apiKey: z.string().optional(), everySeconds: z.number().int().min(60).default(3600) }).strict()).default([]),
    pins: z.record(z.string().min(1)).default({}),
  })
  .strict()
  .superRefine((c, ctx) => {
    for (const [p, k] of Object.entries(c.trustedPublishers)) {
      try {
        createPublicKey(k);
      } catch {
        ctx.addIssue({ code: 'custom', path: ['trustedPublishers', p], message: 'not a PEM public key' });
      }
    }
    for (const [t, r] of Object.entries(c.pins)) if (!parseRange(r)) ctx.addIssue({ code: 'custom', path: ['pins', t], message: `invalid version range "${r}"` });
  });
export type ToolRegistryConfig = z.input<typeof ToolRegistrySchema>;

export const ManifestSchema = z
  .object({
    publisher: z.string().regex(ID),
    name: z.string().regex(ID),
    version: z.string().regex(SEMVER, 'version must be semver (1.2.3)'),
    description: z.string().default(''),
    tools: z.array(z.object({ name: z.string().min(1), description: z.string().optional(), inputSchema: z.record(z.unknown()).optional() }).passthrough()).min(1),
    server: z.object({ transport: z.enum(['stdio', 'sse', 'streamable-http']), command: z.string().optional(), args: z.array(z.string()).optional(), url: z.string().optional() }).passthrough(),
    homepage: z.string().optional(),
  })
  .passthrough();
export type ToolManifest = z.infer<typeof ManifestSchema>;

export interface RegistryEntry {
  manifest: ToolManifest;
  signature: string | null;
  verified: boolean;
  origin: string;
  publishedAt: string;
}

type V = [number, number, number, string | undefined];
const parseV = (s: string): V | undefined => {
  const m = SEMVER.exec(s);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3]), m[4]] : undefined;
};
export function compareVersions(a: string, b: string): number {
  const x = parseV(a)!;
  const y = parseV(b)!;
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return (x[i] as number) - (y[i] as number);
  if (x[3] === y[3]) return 0;
  if (x[3] === undefined) return 1;
  if (y[3] === undefined) return -1;
  return x[3] < y[3] ? -1 : 1;
}
/** Version ranges: `*`, `1.2.3`, `1.2.x` / `1.x`, `^1.2.3`, `~1.2.3`, `>=1.2.3`. */
function parseRange(r: string): ((v: string) => boolean) | undefined {
  const s = r.trim();
  if (s === '*' || s === 'latest') return (v) => !parseV(v)![3];
  let m = /^(\d+)(?:\.(\d+))?\.x$/.exec(s);
  if (m) return (v) => { const p = parseV(v)!; return !p[3] && p[0] === Number(m![1]) && (m![2] === undefined || p[1] === Number(m![2])); };
  m = /^([\^~]|>=)?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/.exec(s);
  if (!m) return undefined;
  const op = m[1];
  const base = m[2];
  const b = parseV(base)!;
  return (v) => {
    const p = parseV(v)!;
    if (!op) return v === base;
    if (compareVersions(v, base) < 0 || (p[3] && !b[3])) return false;
    if (op === '>=') return true;
    if (op === '~') return p[0] === b[0] && p[1] === b[1];
    return b[0] > 0 ? p[0] === b[0] : p[0] === 0 && p[1] === b[1];
  };
}
export const satisfies = (v: string, range: string) => !!parseV(v) && !!parseRange(range)?.(v);

/** Runtime state; exported for tests. */
export const toolRegistryState = {
  entries: new Map<string, RegistryEntry[]>(),
  loadedFrom: undefined as string | undefined,
  lastSync: new Map<string, { at: number; ok: boolean; added: number; error?: string }>(),
  reset() {
    this.entries.clear();
    this.loadedFrom = undefined;
    this.lastSync.clear();
  },
};

const settings = (cfg: GatewayConfig) => {
  if (!cfg.toolRegistry) return undefined;
  const c = ToolRegistrySchema.parse(cfg.toolRegistry);
  return c.enabled ? c : undefined;
};
type S = NonNullable<ReturnType<typeof settings>>;
const keyOf = (m: { publisher: string; name: string }) => `${m.publisher}/${m.name}`;

function load(s: S): void {
  if (!s.file || toolRegistryState.loadedFrom === s.file) return;
  toolRegistryState.loadedFrom = s.file;
  if (!existsSync(s.file)) return;
  try {
    const all = JSON.parse(readFileSync(s.file, 'utf8')) as RegistryEntry[];
    for (const e of all) toolRegistryState.entries.set(keyOf(e.manifest), [...(toolRegistryState.entries.get(keyOf(e.manifest)) ?? []), e]);
  } catch (e) {
    logger.error(`tool registry: cannot read ${s.file}: ${(e as Error).message}`);
  }
}
function save(s: S): void {
  if (!s.file) return;
  mkdirSync(dirname(s.file), { recursive: true });
  writeFileSync(s.file, JSON.stringify([...toolRegistryState.entries.values()].flat(), null, 1));
}

function verifySig(s: S, m: ToolManifest, signature: unknown): boolean {
  const k = s.trustedPublishers[m.publisher];
  if (!k || typeof signature !== 'string') return false;
  try {
    const key = createPublicKey(k);
    return verify(key.asymmetricKeyType === 'ed25519' || key.asymmetricKeyType === 'ed448' ? null : 'sha256', Buffer.from(canonicalJson(m)), key, Buffer.from(signature, 'base64'));
  } catch {
    return false;
  }
}

/** Add a manifest to the local registry (publish or mirror). */
export function addEntry(cfg: GatewayConfig, raw: unknown, signature: unknown, origin = 'local'): { ok: true; entry: RegistryEntry; added: boolean } | { ok: false; reason: string } {
  const s = settings(cfg);
  if (!s) return { ok: false, reason: 'toolRegistry is not enabled' };
  load(s);
  const parsed = ManifestSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, reason: parsed.error.issues.map((i) => `${i.path.join('.') || 'manifest'}: ${i.message}`).join('; ') };
  const m = raw as ToolManifest; // signature covers the manifest as sent (no defaults added)
  const verified = verifySig(s, m, signature);
  if (s.requireSignature && !verified) return { ok: false, reason: s.trustedPublishers[m.publisher] ? 'signature does not verify' : `publisher "${m.publisher}" is not trusted` };
  const list = toolRegistryState.entries.get(keyOf(m)) ?? [];
  const same = list.find((e) => e.manifest.version === m.version);
  if (same) {
    if (canonicalJson(same.manifest) !== canonicalJson(m)) return { ok: false, reason: `${keyOf(m)}@${m.version} already exists with different content (versions are immutable)` };
    return { ok: true, entry: same, added: false };
  }
  const entry: RegistryEntry = { manifest: m, signature: typeof signature === 'string' ? signature : null, verified, origin, publishedAt: new Date().toISOString() };
  list.push(entry);
  list.sort((a, b) => compareVersions(a.manifest.version, b.manifest.version));
  toolRegistryState.entries.set(keyOf(m), list);
  save(s);
  return { ok: true, entry, added: true };
}

/** Highest version matching `range` (or the configured pin, or the latest stable). */
export function resolveVersion(cfg: GatewayConfig, id: string, range?: string): RegistryEntry | undefined {
  const s = settings(cfg);
  if (!s) return undefined;
  load(s);
  const r = range ?? s.pins[id] ?? '*';
  return [...(toolRegistryState.entries.get(id) ?? [])].reverse().find((e) => satisfies(e.manifest.version, r));
}

/** Pull every mirror once. */
export async function syncMirrors(cfg: GatewayConfig): Promise<Array<{ url: string; ok: boolean; added: number; error?: string }>> {
  const s = settings(cfg);
  if (!s) return [];
  const out = [];
  for (const m of s.mirrors) {
    let added = 0;
    try {
      const res = await fetch(m.url, { headers: m.apiKey ? { authorization: `Bearer ${m.apiKey}` } : {}, signal: AbortSignal.timeout(15_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as { entries?: Array<{ manifest: unknown; signature: unknown }> };
      for (const e of body.entries ?? []) {
        const r = addEntry(cfg, e.manifest, e.signature, m.url);
        if (r.ok && r.added) added++;
      }
      toolRegistryState.lastSync.set(m.url, { at: Date.now(), ok: true, added });
      out.push({ url: m.url, ok: true, added });
    } catch (e) {
      const error = (e as Error).message;
      toolRegistryState.lastSync.set(m.url, { at: Date.now(), ok: false, added, error });
      out.push({ url: m.url, ok: false, added, error });
    }
  }
  return out;
}

const summary = (e: RegistryEntry) => ({ id: keyOf(e.manifest), publisher: e.manifest.publisher, name: e.manifest.name, version: e.manifest.version, description: e.manifest.description ?? '', tools: e.manifest.tools.map((t) => t.name), verified: e.verified, origin: e.origin });

registerFeature({
  id: 'tool-registry',
  since: '9.4.0',
  summary: 'Global tool registry: signed tool manifests, search, cross-gateway mirrors, immutable versions and version pins',
  mount(router, ctx) {
    const timer = setInterval(() => {
      const s = settings(ctx.config());
      if (!s?.mirrors.length) return;
      const now = Date.now();
      if (s.mirrors.some((m) => now - (toolRegistryState.lastSync.get(m.url)?.at ?? 0) >= m.everySeconds * 1000)) void syncMirrors(ctx.config());
    }, 30_000);
    timer.unref();
    ctx.onStop?.(() => clearInterval(timer));
    router.get('/', (req, res) => {
      const s = settings(ctx.config());
      if (s) load(s);
      const q = String(req.query.q ?? '').toLowerCase();
      const latest = [...toolRegistryState.entries.values()].map((l) => [...l].reverse().find((e) => !parseV(e.manifest.version)![3]) ?? l[l.length - 1]);
      const hits = latest.filter((e) => !q || [keyOf(e.manifest), e.manifest.description ?? '', ...e.manifest.tools.map((t) => t.name)].some((x) => x.toLowerCase().includes(q)));
      res.json({ enabled: !!s, count: hits.length, entries: hits.map(summary), mirrors: (s?.mirrors ?? []).map((m) => { const l = toolRegistryState.lastSync.get(m.url); return { url: m.url, lastSyncAt: l ? new Date(l.at).toISOString() : null, ok: l?.ok ?? null, added: l?.added ?? 0, error: l?.error ?? null }; }), pins: s?.pins ?? {} });
    });
    router.post('/publish', (req, res) => {
      const b = objectBody(req, res);
      if (!b) return;
      const r = addEntry(ctx.config(), b.manifest, b.signature);
      if (!r.ok) return badRequest(res, r.reason);
      res.status(r.added ? 201 : 200).json({ published: r.added, ...summary(r.entry) });
    });
    router.post('/sync', async (_req, res) => {
      res.json({ mirrors: await syncMirrors(ctx.config()) });
    });
    router.get('/:publisher/:name/resolve', (req, res) => {
      const id = `${req.params.publisher}/${req.params.name}`;
      const range = typeof req.query.range === 'string' ? req.query.range : undefined;
      if (range && !parseRange(range)) return badRequest(res, `invalid version range "${range}"`);
      const e = resolveVersion(ctx.config(), id, range);
      if (!e) return void res.status(404).json({ error: 'Not Found', message: `no version of ${id} matches ${range ?? settings(ctx.config())?.pins[id] ?? '*'}` });
      res.json({ ...summary(e), range: range ?? settings(ctx.config())?.pins[id] ?? '*', manifest: e.manifest });
    });
    router.get('/:publisher/:name', (req, res) => {
      const id = `${req.params.publisher}/${req.params.name}`;
      const l = toolRegistryState.entries.get(id);
      if (!l) return void res.status(404).json({ error: 'Not Found', message: `no tool ${id}` });
      res.json({ id, pin: settings(ctx.config())?.pins[id] ?? null, versions: l.map((e) => ({ ...summary(e), publishedAt: e.publishedAt })) });
    });
  },
  mountClient(router, ctx) {
    router.get('/index.json', (_req, res) => {
      const s = settings(ctx.config());
      if (s) load(s);
      res.json({ generatedAt: new Date().toISOString(), entries: [...toolRegistryState.entries.values()].flat().map((e) => ({ manifest: e.manifest, signature: e.signature })) });
    });
  },
});
