/**
 * Environment of stdio MCP servers (10.9.1 LTS security backport of the 12.0 allowlist): third-party server processes
 * get a minimal environment instead of the gateway's whole environment.
 *
 * ```yaml
 * servers:
 *   - id: files
 *     transport: stdio
 *     command: npx
 *     args: ["-y", "@modelcontextprotocol/server-filesystem", "/data"]
 *     env: { LOG_LEVEL: info }            # explicit values
 *     envPassthrough: [NODE_EXTRA_CA_CERTS] # names (or NAME_* globs) copied from the gateway's environment
 * ```
 *
 * An ALLOWLIST replaces the 10.1 exclusion policy. A child sees only {@link DEFAULT_ENV_ALLOWLIST}
 * (+ `security.stdioEnvPassthrough`, + the server's `envPassthrough`) from the gateway's environment, then the
 * server's explicit `env`. `AWS_SECRET_ACCESS_KEY`, `OPENAI_API_KEY`, database URLs … are no longer inherited.
 * (uid/gid, working directory and sandbox wrappers are 12.x-only features.)
 *
 * @module transport/isolation
 */

import { globToRegExp } from '../utils/tool-filter.js';

/** Variables every stdio child inherits (POSIX). `LC_*` covers the locale categories. */
export const DEFAULT_ENV_ALLOWLIST: readonly string[] = ['PATH', 'HOME', 'LANG', 'LANGUAGE', 'LC_*', 'TZ', 'TMPDIR', 'TERM'];
/** Additional variables on Windows (processes fail to start without SystemRoot / ComSpec). */
export const WINDOWS_ENV_ALLOWLIST: readonly string[] = ['SystemRoot', 'SYSTEMROOT', 'ComSpec', 'COMSPEC', 'PATHEXT', 'TEMP', 'TMP', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'Path', 'windir', 'WINDIR'];

/** Names that look like credentials: passing them through is allowed but flagged by `securityWarnings`. */
export const SECRET_LIKE_ENV = /(SECRET|TOKEN|PASSW(OR)?D|PASSPHRASE|API_?KEY|ACCESS_?KEY|PRIVATE|CREDENTIAL|SESSION|AUTH|COOKIE|DSN|DATABASE_URL|_URL$)/i;

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
