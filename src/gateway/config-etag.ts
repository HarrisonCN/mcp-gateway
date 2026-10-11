/** Order-independent config ETag (shared by the control plane and the rollout coordinator). @module gateway/config-etag */
import { createHash } from 'node:crypto';

export const stable = (v: unknown): string =>
  Array.isArray(v)
    ? `[${v.map(stable).join(',')}]`
    : v && typeof v === 'object'
      ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stable((v as Record<string, unknown>)[k])}`).join(',')}}`
      : JSON.stringify(v) ?? 'null';

/** Strong ETag of a config object (order independent). */
export const configEtag = (config: unknown) => `"${createHash('sha256').update(stable(config)).digest('hex').slice(0, 32)}"`;
