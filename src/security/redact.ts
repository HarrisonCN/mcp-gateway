/**
 * Secret redaction for logs, the request / audit log and API output.
 *
 * Two layers:
 *  - value patterns: well-known token shapes (Bearer tokens, JWTs, OpenAI /
 *    Anthropic / GitHub / Slack / AWS / Google keys, `password=…` style pairs,
 *    credentials in URLs) are masked wherever they appear in a string;
 *  - key names: in objects, values under keys that look secret
 *    (`authorization`, `token`, `password`, `api_key`, `cookie`, …) are masked.
 *
 * Extra patterns come from `security.redactPatterns` (`configureRedaction`).
 *
 * @module security/redact
 */

export const REDACTED = '***';

/** Object keys whose values are always masked. */
export const SECRET_KEY_RE =
  /^(?:authorization|proxy-authorization|cookie|set-cookie|x-api-key|api[-_]?key|apikey|access[-_]?token|refresh[-_]?token|id[-_]?token|token|secret|client[-_]?secret|password|passwd|pwd|private[-_]?key|credentials?|session[-_]?token|mcp-session-id)$|(?:token|secret|password|api[-_]?key)$/i;

const BUILTIN_PATTERNS: Array<[RegExp, (m: string, ...g: string[]) => string]> = [
  // Authorization header values
  [/\b(Bearer|Basic|Token)\s+[A-Za-z0-9._~+/=-]{8,}/gi, (_m, scheme) => `${scheme} ${REDACTED}`],
  // JWTs
  [/\beyJ[A-Za-z0-9_-]{5,}\.eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]*/g, () => REDACTED],
  // Provider API keys
  [/\b(?:sk|pk|rk)-(?:ant-|proj-|live-|test-)?[A-Za-z0-9_-]{16,}/g, () => REDACTED],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}/g, () => REDACTED],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/g, () => REDACTED],
  [/\bxox[abposr]-[A-Za-z0-9-]{10,}/g, () => REDACTED],
  [/\bAKIA[0-9A-Z]{16}\b/g, () => REDACTED],
  [/\bAIza[0-9A-Za-z_-]{35}\b/g, () => REDACTED],
  [/\bglpat-[A-Za-z0-9_-]{20,}/g, () => REDACTED],
  [/\bmgw_[A-Za-z0-9_-]{16,}/g, () => REDACTED],
  // key=value / key: value pairs (query strings, CLI flags, error messages)
  [
    /\b((?:access[_-]?|refresh[_-]?|id[_-]?|auth[_-]?)?token|api[_-]?key|apikey|secret|client[_-]?secret|password|passwd|pwd)(["']?\s*[:=]\s*["']?)([^\s"'&,;}]{3,})/gi,
    (_m, k, sep) => `${k}${sep}${REDACTED}`,
  ],
  // user:password@ in URLs
  [/(\b[a-z][a-z0-9+.-]*:\/\/)([^\s/:@]+):([^\s/@]+)@/gi, (_m, scheme) => `${scheme}${REDACTED}@`],
];

let extraPatterns: RegExp[] = [];

/** Set the extra patterns from `security.redactPatterns` (invalid ones throw). */
export function configureRedaction(patterns: readonly string[] | undefined): void {
  extraPatterns = (patterns ?? []).map((p) => new RegExp(p, 'g'));
}

/** Validate a list of patterns; returns the first error message, if any. */
export function invalidRedactPattern(patterns: readonly string[] | undefined): string | undefined {
  for (const p of patterns ?? []) {
    try {
      new RegExp(p, 'g');
    } catch (err) {
      return `${p}: ${err instanceof Error ? err.message : String(err)}`;
    }
  }
  return undefined;
}

/** Mask secrets inside a string. */
export function redactString(value: string): string {
  let out = value;
  for (const [re, fn] of BUILTIN_PATTERNS) {
    re.lastIndex = 0;
    out = out.replace(re, fn as (m: string, ...args: unknown[]) => string);
  }
  for (const re of extraPatterns) {
    re.lastIndex = 0;
    out = out.replace(re, REDACTED);
  }
  return out;
}

/** Whether an object key names a secret. */
export function isSecretKey(key: string): boolean {
  return SECRET_KEY_RE.test(key);
}

/** Deep copy of `value` with secret keys masked and secret-looking strings redacted. */
export function redactValue<T>(value: T, depth = 0, seen: WeakSet<object> = new WeakSet()): T {
  // 10.2: past the depth limit nothing is returned unredacted (deeply nested secrets leaked before).
  if (depth > 20) return (typeof value === 'object' && value !== null ? REDACTED : typeof value === 'string' ? redactString(value) : value) as T;
  if (typeof value === 'string') return redactString(value) as T;
  if (value && typeof value === 'object' && !(value instanceof Date)) {
    if (seen.has(value)) return '[Circular]' as T;
    seen.add(value);
    try {
      if (Array.isArray(value)) return value.map((v) => redactValue(v, depth + 1, seen)) as T;
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        out[k] = isSecretKey(k) && v !== undefined && v !== null && v !== '' ? REDACTED : redactValue(v, depth + 1, seen);
      }
      return out as T;
    } finally {
      seen.delete(value);
    }
  }
  return value;
}

const SECRET_FLAG_RE = /^--?(?:[a-z0-9-]*?(?:token|secret|password|passwd|api[-_]?key|apikey|auth|credential)s?)$/i;
const SECRET_FLAG_ASSIGN_RE = /^(--?[a-z0-9-]*?(?:token|secret|password|passwd|api[-_]?key|apikey|auth|credential)s?)=(.+)$/i;

/**
 * Mask secrets in a command line (stdio server `args`): values following
 * `--token`, `--api-key`, … flags, `--token=…` assignments and anything that
 * matches a value pattern.
 */
export function redactArgs(args: readonly string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    const assign = SECRET_FLAG_ASSIGN_RE.exec(a);
    if (assign) {
      out.push(`${assign[1]}=${REDACTED}`);
      continue;
    }
    out.push(redactString(a));
    if (SECRET_FLAG_RE.test(a) && i + 1 < args.length && !args[i + 1]!.startsWith('-')) {
      out.push(REDACTED);
      i++;
    }
  }
  return out;
}
