/**
 * Plugin marketplace (5.4): signed plugin distribution with supply-chain checks.
 *
 * A marketplace index is a JSON document `{ plugins: [{ name, version, description?, url, sha256, signature, keyId,
 * kind?: "module" | "wasm" }] }`. Installing downloads the artifact, checks its sha256 and Ed25519 signature
 * against `pluginTrust.keys`, and writes `<dir>/<name>-<version>.<mjs|wasm>` plus its `.sig`. The response carries
 * the `plugins:` entry to add to the config — nothing is loaded without an explicit config change.
 *
 * ```yaml
 * marketplace:
 *   dir: ./plugins            # relative to the config file
 *   indexes: [https://plugins.example.com/index.json]
 * ```
 *
 * - `GET  /admin/marketplace` — merged index entries (`trusted`: signed by a configured key) and per-index errors.
 * - `POST /admin/marketplace/install` — `{ name, version? }` (newest version when omitted).
 *
 * @module features/marketplace
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { z } from 'zod';
import { registerFeature, objectBody, badRequest } from '../gateway/features.js';
import { PluginTrustSchema, verifyArtifact, sha256Hex } from '../plugins/trust.js';

export const MarketplaceSchema = z
  .object({
    dir: z.string().min(1).default('plugins'),
    indexes: z.array(z.string().url()).default([]),
    /** Max artifact size (default 5 MiB). */
    maxBytes: z.number().int().positive().default(5 * 1024 * 1024),
  })
  .strict();
export type MarketplaceConfig = z.input<typeof MarketplaceSchema>;

export interface MarketplaceEntry {
  name: string;
  version: string;
  description?: string;
  url: string;
  sha256: string;
  signature: string;
  keyId: string;
  kind?: 'module' | 'wasm';
}

const NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

/** Validate index entries (drops malformed ones). */
export function parseIndex(doc: unknown): MarketplaceEntry[] {
  const list = (doc as { plugins?: unknown })?.plugins;
  if (!Array.isArray(list)) return [];
  return list.filter((e): e is MarketplaceEntry => {
    const x = e as Partial<MarketplaceEntry>;
    return !!x && typeof x.name === 'string' && NAME.test(x.name) && typeof x.version === 'string' && VERSION.test(x.version) && typeof x.url === 'string' && /^https?:\/\//.test(x.url) &&
      typeof x.sha256 === 'string' && /^[0-9a-f]{64}$/.test(x.sha256) && typeof x.signature === 'string' && typeof x.keyId === 'string' && (x.kind === undefined || x.kind === 'module' || x.kind === 'wasm');
  });
}

/** Compare semver-ish versions (pre-releases sort before releases). */
export function compareVersions(a: string, b: string): number {
  const [ma, pa] = a.split('-', 2) as [string, string | undefined];
  const [mb, pb] = b.split('-', 2) as [string, string | undefined];
  const x = ma.split('.').map(Number);
  const y = mb.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return (x[i] ?? 0) - (y[i] ?? 0);
  if (pa === pb) return 0;
  if (pa === undefined) return 1;
  if (pb === undefined) return -1;
  return pa < pb ? -1 : 1;
}

export async function fetchIndexes(urls: string[], f: typeof fetch = fetch): Promise<{ entries: Array<MarketplaceEntry & { index: string }>; errors: Record<string, string> }> {
  const errors: Record<string, string> = {};
  const per = await Promise.all(
    urls.map(async (u) => {
      try {
        const r = await f(u, { signal: AbortSignal.timeout(10_000) });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return parseIndex(await r.json()).map((e) => ({ ...e, index: u }));
      } catch (e) {
        errors[u] = (e as Error).message;
        return [];
      }
    }),
  );
  return { entries: per.flat(), errors };
}

export interface InstallResult {
  name: string;
  version: string;
  file: string;
  keyId: string;
  /** Config entry to add under `plugins:` (paths relative to the config dir when inside it). */
  plugin: Record<string, string>;
}

/** Download, verify and write one entry. Throws with a reason on any supply-chain failure. */
export async function installEntry(entry: MarketplaceEntry, opts: { dir: string; keys: Array<{ id: string; publicKey: string }>; maxBytes: number; fetch?: typeof fetch; relativeTo?: string }): Promise<InstallResult> {
  const f = opts.fetch ?? fetch;
  const r = await f(entry.url, { signal: AbortSignal.timeout(30_000) });
  if (!r.ok) throw new Error(`download failed: HTTP ${r.status}`);
  const bytes = new Uint8Array(await r.arrayBuffer());
  if (bytes.byteLength > opts.maxBytes) throw new Error(`artifact is ${bytes.byteLength} bytes (max ${opts.maxBytes})`);
  const digest = sha256Hex(bytes);
  if (digest !== entry.sha256) throw new Error(`sha256 mismatch: index ${entry.sha256.slice(0, 12)}…, download ${digest.slice(0, 12)}…`);
  const sig = { keyId: entry.keyId, sha256: entry.sha256, signature: entry.signature };
  const v = verifyArtifact(bytes, sig, opts.keys);
  if (!v.ok) throw new Error(`signature check failed: ${v.reason}`);
  await mkdir(opts.dir, { recursive: true });
  const kind = entry.kind ?? (entry.url.endsWith('.wasm') ? 'wasm' : 'module');
  const file = join(opts.dir, `${entry.name}-${entry.version}.${kind === 'wasm' ? 'wasm' : 'mjs'}`);
  await writeFile(file, bytes);
  await writeFile(`${file}.sig`, JSON.stringify(sig, null, 2) + '\n');
  const rel = opts.relativeTo && file.startsWith(opts.relativeTo + '/') ? './' + file.slice(opts.relativeTo.length + 1) : file;
  return { name: entry.name, version: entry.version, file, keyId: v.keyId, plugin: { [kind]: rel, name: entry.name } };
}

registerFeature({
  id: 'marketplace',
  since: '5.4.0',
  summary: 'Signed plugin marketplace: browse indexes, verified install',
  mount: (router, ctx) => {
    const cfg = () => MarketplaceSchema.parse(ctx.config().marketplace ?? {});
    const keys = () => PluginTrustSchema.parse(ctx.config().pluginTrust ?? {}).keys;
    router.get('/', async (_req, res) => {
      const c = cfg();
      const { entries, errors } = await fetchIndexes(c.indexes);
      const trusted = new Set(keys().map((k) => k.id));
      res.json({ dir: c.dir, plugins: entries.map((e) => ({ ...e, trusted: trusted.has(e.keyId) })), errors });
    });
    router.post('/install', async (req, res) => {
      const b = objectBody(req, res);
      if (!b) return;
      if (typeof b.name !== 'string') return badRequest(res, '"name" is required');
      const c = cfg();
      if (!c.indexes.length) return void res.status(404).json({ error: 'Not Found', message: 'no marketplace indexes configured (`marketplace.indexes`)' });
      if (!keys().length) return void res.status(409).json({ error: 'Conflict', message: 'no trusted keys (`pluginTrust.keys`) — refusing to install unverifiable plugins' });
      const { entries } = await fetchIndexes(c.indexes);
      const candidates = entries.filter((e) => e.name === b.name && (b.version === undefined || e.version === b.version)).sort((x, y) => compareVersions(y.version, x.version));
      const entry = candidates[0];
      if (!entry) return void res.status(404).json({ error: 'Not Found', message: `no plugin "${b.name}"${b.version ? `@${String(b.version)}` : ''} in the marketplace` });
      const base = ctx.config().configDir ?? process.cwd();
      try {
        res.json(await installEntry(entry, { dir: resolve(base, c.dir), keys: keys(), maxBytes: c.maxBytes, relativeTo: resolve(base) }));
      } catch (e) {
        res.status(422).json({ error: 'Unprocessable Entity', message: (e as Error).message });
      }
    });
  },
});
