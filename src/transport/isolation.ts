/**
 * Runtime isolation of stdio MCP servers (12.0): third-party server processes get a minimal environment, may run as
 * another uid/gid, in a fixed working directory, and optionally inside a sandbox wrapper (bubblewrap, firejail, a
 * container runtime or a custom command template) with networking off.
 *
 * ```yaml
 * servers:
 *   - id: files
 *     transport: stdio
 *     command: npx
 *     args: ["-y", "@modelcontextprotocol/server-filesystem", "/data"]
 *     env: { LOG_LEVEL: info }            # explicit values
 *     envPassthrough: [NODE_EXTRA_CA_CERTS] # names (or NAME_* globs) copied from the gateway's environment
 *     isolation:
 *       uid: 1001                          # needs a privileged gateway (POSIX only)
 *       gid: 1001
 *       cwd: /srv/mcp/files                # absolute, or relative to the config file
 *       sandbox: { type: bubblewrap, network: none, writable: [/data] }
 * ```
 *
 * Environment (12.0, breaking): an ALLOWLIST replaces the 10.1 exclusion policy. A child sees only
 * {@link DEFAULT_ENV_ALLOWLIST} (+ `security.stdioEnvPassthrough`, + the server's `envPassthrough`) from the gateway's
 * environment, then the server's explicit `env`. `AWS_SECRET_ACCESS_KEY`, `OPENAI_API_KEY`, database URLs … are no
 * longer inherited.
 *
 * @module transport/isolation
 */

import { isAbsolute, resolve } from 'node:path';
import { globToRegExp } from '../utils/tool-filter.js';
import type { McpServerConfig } from '../utils/types.js';

/** Variables every stdio child inherits (POSIX). `LC_*` covers the locale categories. */
export const DEFAULT_ENV_ALLOWLIST: readonly string[] = ['PATH', 'HOME', 'LANG', 'LANGUAGE', 'LC_*', 'TZ', 'TMPDIR', 'TERM'];
/** Additional variables on Windows (processes fail to start without SystemRoot / ComSpec). */
export const WINDOWS_ENV_ALLOWLIST: readonly string[] = ['SystemRoot', 'SYSTEMROOT', 'ComSpec', 'COMSPEC', 'PATHEXT', 'TEMP', 'TMP', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'Path', 'windir', 'WINDIR'];

/** Names that look like credentials: passing them through is allowed but flagged by `securityWarnings`. */
export const SECRET_LIKE_ENV = /(SECRET|TOKEN|PASSW(OR)?D|PASSPHRASE|API_?KEY|ACCESS_?KEY|PRIVATE|CREDENTIAL|SESSION|AUTH|COOKIE|DSN|DATABASE_URL|_URL$)/i;

export interface SandboxConfig {
  /** `bubblewrap` (bwrap), `firejail`, `container` (docker / podman run) or `custom` (`command` template). */
  type: 'bubblewrap' | 'firejail' | 'container' | 'custom';
  /** `none` (default): no network inside the sandbox; `host`: share the host network. */
  network?: 'none' | 'host';
  /** Extra paths the server may write (bind-mounted read-write; the working directory always is). */
  writable?: string[];
  /** Extra read-only paths. */
  readable?: string[];
  /** `container`: image to run (required) and runtime (default `docker`). */
  image?: string;
  runtime?: string;
  /**
   * `custom`: argv template. Placeholders: `{command}`, `{args}` (expands to every argument), `{cwd}`, `{network}`
   * (`none` | `host`). Example: `["nsjail", "-Mo", "--cwd", "{cwd}", "--", "{command}", "{args}"]`.
   */
  command?: string[];
}

export interface IsolationConfig {
  uid?: number;
  gid?: number;
  cwd?: string;
  sandbox?: SandboxConfig;
}

const isWin = (platform: NodeJS.Platform) => platform === 'win32';

/** Whether `name` is matched by an allowlist entry (exact, or a `PREFIX_*` glob; case-insensitive on Windows). */
export function envAllowed(name: string, list: readonly string[], platform: NodeJS.Platform = process.platform): boolean {
  const n = isWin(platform) ? name.toUpperCase() : name;
  return list.some((p) => {
    const q = isWin(platform) ? p.toUpperCase() : p;
    return q.includes('*') || q.includes('?') ? globToRegExp(q).test(n) : q === n;
  });
}

/**
 * Environment for a stdio child (12.0): the allowlisted subset of `base`, then `extra` (the server's explicit `env`,
 * already `${VAR}`-expanded). Nothing else of the gateway's environment is inherited.
 */
export function childEnv(base: NodeJS.ProcessEnv, extra: Record<string, string>, passthrough: readonly string[] = [], platform: NodeJS.Platform = process.platform): NodeJS.ProcessEnv {
  const allow = [...DEFAULT_ENV_ALLOWLIST, ...(isWin(platform) ? WINDOWS_ENV_ALLOWLIST : []), ...passthrough];
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(base)) if (v !== undefined && envAllowed(k, allow, platform)) env[k] = v;
  return { ...env, ...extra };
}

/** Passthrough entries that look like secrets (for posture warnings). */
export const secretLikePassthrough = (names: readonly string[] = []): string[] => names.filter((n) => SECRET_LIKE_ENV.test(n.replace(/[*?]/g, '')));

export interface SpawnPlan {
  command: string;
  args: string[];
  cwd?: string;
  uid?: number;
  gid?: number;
  env: NodeJS.ProcessEnv;
}

/**
 * Turn a server's command into what is actually spawned (12.0): working directory, uid/gid and the sandbox wrapper.
 * Pure (no I/O) so it is unit-testable; throws on an invalid combination.
 */
export function planSpawn(
  config: Pick<McpServerConfig, 'id' | 'command' | 'args'> & { isolation?: IsolationConfig },
  env: NodeJS.ProcessEnv,
  opts: { baseDir?: string; platform?: NodeJS.Platform } = {},
): SpawnPlan {
  const platform = opts.platform ?? process.platform;
  const iso = config.isolation ?? {};
  const command = config.command!;
  const args = config.args ?? [];
  const cwd = iso.cwd ? (isAbsolute(iso.cwd) ? iso.cwd : resolve(opts.baseDir ?? process.cwd(), iso.cwd)) : undefined;
  if ((iso.uid !== undefined || iso.gid !== undefined) && isWin(platform)) throw new Error(`Server "${config.id}": isolation.uid / gid are POSIX-only`);
  const plan: SpawnPlan = { command, args, env, ...(cwd ? { cwd } : {}), ...(iso.uid !== undefined ? { uid: iso.uid } : {}), ...(iso.gid !== undefined ? { gid: iso.gid } : {}) };
  const sb = iso.sandbox;
  if (!sb) return plan;
  const net = sb.network ?? 'none';
  const work = cwd ?? opts.baseDir ?? process.cwd();
  switch (sb.type) {
    case 'bubblewrap': {
      const a = ['--die-with-parent', '--new-session', '--unshare-all', ...(net === 'host' ? ['--share-net'] : []), '--clearenv'];
      for (const [k, v] of Object.entries(env)) if (v !== undefined) a.push('--setenv', k, v);
      for (const p of ['/usr', '/bin', '/sbin', '/lib', '/lib64', '/etc/ssl', '/etc/ca-certificates', '/etc/resolv.conf', '/etc/hosts', '/etc/passwd', '/etc/group', '/etc/alternatives', '/opt']) a.push('--ro-bind-try', p, p);
      for (const p of sb.readable ?? []) a.push('--ro-bind', p, p);
      a.push('--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp');
      for (const p of [work, ...(sb.writable ?? [])]) a.push('--bind', p, p);
      a.push('--chdir', work, '--', command, ...args);
      return { ...plan, command: 'bwrap', args: a };
    }
    case 'firejail': {
      const a = ['--quiet', '--noprofile', '--private-tmp', '--caps.drop=all', '--nonewprivs', '--seccomp', ...(net === 'none' ? ['--net=none'] : [])];
      for (const p of [work, ...(sb.writable ?? []), ...(sb.readable ?? [])]) a.push(`--whitelist=${p}`);
      for (const p of sb.readable ?? []) a.push(`--read-only=${p}`);
      a.push('--', command, ...args);
      return { ...plan, command: 'firejail', args: a };
    }
    case 'container': {
      if (!sb.image) throw new Error(`Server "${config.id}": isolation.sandbox.image is required for type "container"`);
      const a = ['run', '--rm', '-i', '--network', net, '--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges', '--tmpfs', '/tmp', '-w', work, '-v', `${work}:${work}`];
      for (const p of sb.writable ?? []) a.push('-v', `${p}:${p}`);
      for (const p of sb.readable ?? []) a.push('-v', `${p}:${p}:ro`);
      if (iso.uid !== undefined) a.push('--user', `${iso.uid}${iso.gid !== undefined ? `:${iso.gid}` : ''}`);
      for (const k of Object.keys(env)) if (k !== 'PATH' && k !== 'HOME') a.push('-e', k); // values travel in the runtime's env, not argv
      a.push(sb.image, command, ...args);
      // uid/gid apply inside the container; the runtime client itself runs as the gateway user.
      const { uid: _u, gid: _g, ...rest } = plan;
      return { ...rest, command: sb.runtime ?? 'docker', args: a };
    }
    case 'custom': {
      if (!sb.command?.length) throw new Error(`Server "${config.id}": isolation.sandbox.command is required for type "custom"`);
      const out: string[] = [];
      for (const t of sb.command) {
        if (t === '{args}') out.push(...args);
        else out.push(t.replaceAll('{command}', command).replaceAll('{cwd}', work).replaceAll('{network}', net));
      }
      if (!sb.command.some((t) => t.includes('{command}'))) throw new Error(`Server "${config.id}": isolation.sandbox.command must contain "{command}"`);
      return { ...plan, command: out[0]!, args: out.slice(1) };
    }
  }
}
