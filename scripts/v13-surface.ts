/**
 * 16.0.0-rc.1: the frozen surface of config schema v13 — every key path and every enum / const value the JSON
 * Schema (src/config/v13-schema.ts) accepts. `schema/v13/frozen-surface.json` records it at 16.0.0-rc.1; from then
 * until 16.0.0 ships the schema may only grow (docs/v16/freeze.md): a key path or an enum value that disappears is a
 * frozen-surface break (test/v16-freeze-16-0-0-rc1.test.ts).
 *
 *   npx tsx scripts/v13-surface.ts            # prints paths missing from the current schema (exit 1 when any)
 *   npx tsx scripts/v13-surface.ts --record [--at <version>]   # rewrites schema/v13/frozen-surface.json (only at a
 *                                                             # freeze point; default: package.json version)
 *
 * Paths: `a.b` for properties, `a[]` for array items, `a.*` for additionalProperties / patternProperties,
 * `a=value` for an enum or const value. anyOf / oneOf / allOf branches and local `$ref`s fold into the same path;
 * if / then / else conditions are cross-key constraints and are not part of the surface. Kept out of the loader's import graph (scripts only).
 *
 * @module scripts/v13-surface
 */
import { readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

type Obj = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

/** Every key path and enum / const value of a JSON Schema, sorted and de-duplicated. */
export function surfaceOf(schema: Obj): string[] {
  const out = new Set<string>();
  const resolve = (ref: string): Obj | undefined => {
    if (!ref.startsWith('#/')) return undefined;
    return ref
      .slice(2)
      .split('/')
      .reduce<Obj | undefined>((o, k) => (o && typeof o === 'object' ? o[k.replace(/~1/g, '/').replace(/~0/g, '~')] : undefined), schema);
  };
  const walk = (node: unknown, path: string, seen: Set<string>): void => {
    if (!node || typeof node !== 'object') return;
    const n = node as Obj;
    if (typeof n.$ref === 'string' && !seen.has(n.$ref)) {
      const target = resolve(n.$ref);
      if (target) walk(target, path, new Set([...seen, n.$ref]));
    }
    if (Array.isArray(n.enum)) for (const v of n.enum) out.add(`${path}=${typeof v === 'string' ? v : JSON.stringify(v)}`);
    if (n.const !== undefined) out.add(`${path}=${typeof n.const === 'string' ? n.const : JSON.stringify(n.const)}`);
    if (n.properties && typeof n.properties === 'object') {
      for (const [k, v] of Object.entries<Obj>(n.properties)) {
        const p = path ? `${path}.${k}` : k;
        out.add(p);
        walk(v, p, seen);
      }
    }
    if (n.items) for (const it of Array.isArray(n.items) ? n.items : [n.items]) walk(it, `${path}[]`, seen);
    if (n.additionalProperties && typeof n.additionalProperties === 'object') walk(n.additionalProperties, `${path}.*`, seen);
    if (n.patternProperties && typeof n.patternProperties === 'object') for (const v of Object.values(n.patternProperties)) walk(v, `${path}.*`, seen);
    for (const k of ['anyOf', 'oneOf', 'allOf'] as const) if (Array.isArray(n[k])) for (const b of n[k]) walk(b, path, seen);
    // if / then / else are constraints between keys that already exist (e.g. inline ⇒ allowInline: true), not surface
  };
  walk(schema, '', new Set());
  return [...out].filter((p) => p !== '').sort();
}

/** Entries of a frozen surface that the current surface no longer has (empty = nothing removed or narrowed). */
export function missingFromSurface(frozen: readonly string[], current: readonly string[]): string[] {
  const have = new Set(current);
  return frozen.filter((p) => !have.has(p));
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  const file = join(root, 'schema/v13/frozen-surface.json');
  const { buildV13ConfigSchema } = await import('../src/config/v13-schema.js');
  const current = surfaceOf(buildV13ConfigSchema());
  if (process.argv.includes('--record')) {
    const at = process.argv.indexOf('--at');
    const version = at > 0 && process.argv[at + 1] ? process.argv[at + 1] : JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
    const doc = {
      $comment: 'Config schema v13 frozen surface (docs/v16/freeze.md). Written by scripts/v13-surface.ts --record at a freeze point; the schema may only add to it until 16.0.0 ships.',
      recordedAt: version,
      surface: current,
    };
    writeFileSync(file, JSON.stringify(doc, null, 2) + '\n');
    console.log(`recorded ${current.length} entries at ${version}`);
  } else {
    const missing = missingFromSurface(JSON.parse(readFileSync(file, 'utf8')).surface, current);
    for (const m of missing) console.error(`frozen-surface break: ${m}`);
    process.exit(missing.length ? 1 : 0);
  }
}
