/**
 * Config schema of the `tool-registry` feature module (13.0: split from the module so validating a config never
 * evaluates the module itself).
 *
 * @module features/schemas/tool-registry
 */

import { createPublicKey } from 'node:crypto';
import { z } from 'zod';

export const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;
export const ID = /^[a-z0-9][a-z0-9._-]*$/;

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

export type V = [number, number, number, string | undefined];
export const parseV = (s: string): V | undefined => {
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
export function parseRange(r: string): ((v: string) => boolean) | undefined {
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
