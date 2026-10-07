/**
 * Upstream catalog / registry: templates for well-known MCP servers that an
 * operator can add with one click (dashboard) or one request
 * (`POST /api/v1/catalog/:id/install`).
 *
 * The built-in entries cover the reference servers; `catalog.sources` adds
 * entries from JSON files or URLs (`{ "entries": [...] }` or an array).
 * Installing is off unless `catalog.install: true` — it spawns processes.
 * Installed servers are kept in `catalog.serversFile` (JSON) when set, and
 * loaded again on start.
 *
 * @module catalog
 */

import { readFile, writeFile, rename } from 'fs/promises';
import { existsSync, readFileSync } from 'fs';
import { isAbsolute, resolve } from 'path';
import type { CatalogConfig, McpServerConfig } from '../utils/types.js';
import { logger } from '../utils/logger.js';

export interface CatalogEnvVar {
  name: string;
  description?: string;
  required?: boolean;
  secret?: boolean;
}

export interface CatalogEntry {
  id: string;
  name: string;
  description: string;
  homepage?: string;
  tags?: string[];
  /** Server config template (`id` / `name` come from the install request). */
  template: Omit<McpServerConfig, 'id' | 'name'>;
  /** Environment variables (stdio) or `${VAR}` placeholders the template needs. */
  env?: CatalogEnvVar[];
  /** Extra positional args the user must supply (e.g. allowed directories). */
  args?: Array<{ name: string; description?: string; required?: boolean; default?: string }>;
  source?: string;
}

const npx = (pkg: string, ...extra: string[]): Omit<McpServerConfig, 'id' | 'name'> => ({
  transport: 'stdio',
  command: 'npx',
  args: ['-y', pkg, ...extra],
});

/** Built-in catalog (reference MCP servers). */
export const BUILTIN_CATALOG: CatalogEntry[] = [
  {
    id: 'filesystem',
    name: 'Filesystem',
    description: 'Read, write and search files in allowed directories',
    homepage: 'https://github.com/modelcontextprotocol/servers/tree/main/src/filesystem',
    tags: ['files'],
    template: npx('@modelcontextprotocol/server-filesystem'),
    args: [{ name: 'directory', description: 'Allowed directory', required: true, default: '/data' }],
  },
  {
    id: 'memory',
    name: 'Memory',
    description: 'Knowledge-graph based persistent memory',
    homepage: 'https://github.com/modelcontextprotocol/servers/tree/main/src/memory',
    tags: ['memory'],
    template: npx('@modelcontextprotocol/server-memory'),
  },
  {
    id: 'everything',
    name: 'Everything (test server)',
    description: 'Reference server exercising every MCP feature',
    homepage: 'https://github.com/modelcontextprotocol/servers/tree/main/src/everything',
    tags: ['test'],
    template: npx('@modelcontextprotocol/server-everything'),
  },
  {
    id: 'sequential-thinking',
    name: 'Sequential Thinking',
    description: 'Structured step-by-step problem solving',
    homepage: 'https://github.com/modelcontextprotocol/servers/tree/main/src/sequentialthinking',
    tags: ['reasoning'],
    template: npx('@modelcontextprotocol/server-sequential-thinking'),
  },
  {
    id: 'fetch',
    name: 'Fetch',
    description: 'Fetch web pages and convert them to markdown',
    homepage: 'https://github.com/modelcontextprotocol/servers/tree/main/src/fetch',
    tags: ['web'],
    template: { transport: 'stdio', command: 'uvx', args: ['mcp-server-fetch'] },
  },
  {
    id: 'git',
    name: 'Git',
    description: 'Read, search and manipulate a Git repository',
    homepage: 'https://github.com/modelcontextprotocol/servers/tree/main/src/git',
    tags: ['code'],
    template: { transport: 'stdio', command: 'uvx', args: ['mcp-server-git', '--repository'] },
    args: [{ name: 'repository', description: 'Path of the repository', required: true }],
  },
  {
    id: 'time',
    name: 'Time',
    description: 'Current time and time-zone conversion',
    homepage: 'https://github.com/modelcontextprotocol/servers/tree/main/src/time',
    tags: ['utility'],
    template: { transport: 'stdio', command: 'uvx', args: ['mcp-server-time'] },
  },
  {
    id: 'github',
    name: 'GitHub',
    description: 'GitHub repositories, issues and pull requests (remote server)',
    homepage: 'https://github.com/github/github-mcp-server',
    tags: ['code', 'remote'],
    template: { transport: 'streamable-http', url: 'https://api.githubcopilot.com/mcp/', headers: { Authorization: 'Bearer ${GITHUB_TOKEN}' } },
    env: [{ name: 'GITHUB_TOKEN', description: 'GitHub personal access token', required: true, secret: true }],
  },
];

function validEntry(e: unknown): e is CatalogEntry {
  if (!e || typeof e !== 'object') return false;
  const x = e as Partial<CatalogEntry>;
  return typeof x.id === 'string' && /^[A-Za-z0-9._-]+$/.test(x.id) && typeof x.name === 'string' && !!x.template && typeof x.template === 'object' && typeof (x.template as { transport?: unknown }).transport === 'string';
}

/** Load entries from one source (file path relative to `baseDir`, or http(s) URL). */
export async function loadCatalogSource(source: string, baseDir = process.cwd(), fetchImpl: typeof fetch = fetch): Promise<CatalogEntry[]> {
  let raw: unknown;
  if (/^https?:\/\//.test(source)) {
    const r = await fetchImpl(source, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(10_000) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    raw = await r.json();
  } else {
    raw = JSON.parse(await readFile(isAbsolute(source) ? source : resolve(baseDir, source), 'utf8'));
  }
  const list = Array.isArray(raw) ? raw : (raw as { entries?: unknown[] })?.entries;
  if (!Array.isArray(list)) throw new Error('expected an array or { "entries": [...] }');
  const ok = list.filter(validEntry).map((e) => ({ ...e, description: e.description ?? '', source }));
  if (ok.length !== list.length) logger.warn(`Catalog ${source}: ${list.length - ok.length} invalid entries skipped`);
  return ok;
}

export class Catalog {
  private entries: CatalogEntry[] = [...BUILTIN_CATALOG];

  constructor(private config: () => CatalogConfig | undefined, private readonly baseDir: () => string | undefined = () => undefined) {}

  /** (Re)load `catalog.sources`; failures are logged and skipped. */
  async refresh(fetchImpl?: typeof fetch): Promise<void> {
    const cfg = this.config();
    const out = cfg?.builtins === false ? [] : [...BUILTIN_CATALOG];
    for (const src of cfg?.sources ?? []) {
      try {
        for (const e of await loadCatalogSource(src, this.baseDir(), fetchImpl)) {
          const i = out.findIndex((x) => x.id === e.id);
          if (i >= 0) out[i] = e;
          else out.push(e);
        }
      } catch (err) {
        logger.warn(`Catalog source ${src} failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    this.entries = out;
  }

  list(): readonly CatalogEntry[] {
    return this.entries;
  }

  get(id: string): CatalogEntry | undefined {
    return this.entries.find((e) => e.id === id);
  }

  installEnabled(): boolean {
    return this.config()?.install === true;
  }
}

export interface InstallRequest {
  /** Server id (default: the entry id). */
  serverId?: string;
  name?: string;
  /** Values for `entry.env` (stdio: process env; remote: `${VAR}` substitution). */
  env?: Record<string, string>;
  /** Values for `entry.args`, in order. */
  args?: string[];
  tags?: string[];
}

/** Build a server config from a catalog entry. Throws with a user-facing message on missing input. */
export function buildServerConfig(entry: CatalogEntry, req: InstallRequest): McpServerConfig {
  const id = req.serverId ?? entry.id;
  if (!/^[A-Za-z0-9._-]+$/.test(id)) throw new Error('serverId: letters, digits, ".", "_" and "-" only');
  const env = req.env ?? {};
  for (const v of entry.env ?? []) {
    if (v.required && !env[v.name]) throw new Error(`env.${v.name} is required (${v.description ?? 'see the catalog entry'})`);
  }
  const extra: string[] = [];
  (entry.args ?? []).forEach((a, i) => {
    const value = req.args?.[i] ?? a.default;
    if (value === undefined || value === '') {
      if (a.required) throw new Error(`args[${i}] (${a.name}) is required`);
      return;
    }
    extra.push(value);
  });
  const subst = (s: string) => s.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (m, k: string) => env[k] ?? m);
  const t = entry.template;
  const cfg: McpServerConfig = {
    timeout: 30_000,
    maxConcurrency: 10,
    enabled: true,
    ...t,
    id,
    name: req.name ?? entry.name,
    tags: [...new Set([...(t.tags ?? []), ...(entry.tags ?? []), ...(req.tags ?? []), 'catalog'])],
  } as McpServerConfig;
  if (extra.length) cfg.args = [...(t.args ?? []), ...extra];
  if (t.headers) cfg.headers = Object.fromEntries(Object.entries(t.headers).map(([k, v]) => [k, subst(v)]));
  if (t.url) cfg.url = subst(t.url);
  if (t.transport === 'stdio' && Object.keys(env).length) cfg.env = { ...(t.env ?? {}), ...env };
  return cfg;
}

/** Servers installed from the catalog, persisted in `catalog.serversFile`. */
export class InstalledServers {
  private servers: McpServerConfig[] = [];

  constructor(private readonly file: () => string | undefined) {}

  load(): McpServerConfig[] {
    const f = this.file();
    if (!f || !existsSync(f)) return (this.servers = []);
    try {
      const raw = JSON.parse(readFileSync(f, 'utf8')) as { servers?: McpServerConfig[] };
      this.servers = Array.isArray(raw.servers) ? raw.servers : [];
    } catch (err) {
      logger.error(`Cannot read catalog.serversFile ${f}: ${err instanceof Error ? err.message : String(err)}`);
      this.servers = [];
    }
    return this.servers;
  }

  list(): readonly McpServerConfig[] {
    return this.servers;
  }

  async add(s: McpServerConfig): Promise<void> {
    this.servers = [...this.servers.filter((x) => x.id !== s.id), s];
    await this.save();
  }

  async remove(id: string): Promise<boolean> {
    const before = this.servers.length;
    this.servers = this.servers.filter((x) => x.id !== id);
    if (this.servers.length === before) return false;
    await this.save();
    return true;
  }

  private async save(): Promise<void> {
    const f = this.file();
    if (!f) return;
    const tmp = `${f}.tmp`;
    await writeFile(tmp, JSON.stringify({ servers: this.servers }, null, 2) + '\n', { mode: 0o600 });
    await rename(tmp, f);
  }
}
