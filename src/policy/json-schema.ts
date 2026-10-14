/**
 * 15.3.0-canary.0: a small, dependency-free JSON Schema validator for tool schemas (MCP `inputSchema` /
 * `outputSchema`), and the canonical tool schema digest used by `policy.toolSchemas.pins`.
 *
 * Supported (draft 2020-12 / draft-07 vocabulary that tool schemas use): `type` (incl. arrays of types, `integer`),
 * `enum`, `const`, `properties`, `required`, `additionalProperties` (boolean or schema), `patternProperties`,
 * `propertyNames`, `minProperties` / `maxProperties`, `items` (schema), `prefixItems`, `minItems` / `maxItems`,
 * `uniqueItems`, `contains`, `minimum` / `maximum` / `exclusiveMinimum` / `exclusiveMaximum` (numeric) / `multipleOf`,
 * `minLength` / `maxLength` (code points) / `pattern`, `allOf` / `anyOf` / `oneOf` / `not`, `if` / `then` / `else`,
 * boolean schemas and local `$ref` (`#`, `#/$defs/…`, `#/definitions/…`). `format`, `title`, `description`,
 * `default`, `examples` and unknown keywords are annotations and never fail a value. A remote or otherwise
 * unresolvable `$ref` makes the value invalid (never silently valid). At most 20 errors are reported; recursion depth
 * is bounded.
 *
 * @module policy/json-schema
 */

import { createHash } from 'node:crypto';

export interface SchemaError {
  /** JSON Pointer of the offending value (`''` = the value itself). */
  path: string;
  message: string;
}
export interface SchemaResult {
  valid: boolean;
  errors: SchemaError[];
}

const MAX_ERRORS = 20;
const MAX_DEPTH = 64;
type Schema = boolean | Record<string, unknown>;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const typeOf = (v: unknown): string => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v);
const esc = (k: string) => k.replace(/~/g, '~0').replace(/\//g, '~1');

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null || typeof a !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) return a.length === (b as unknown[]).length && a.every((x, i) => deepEqual(x, (b as unknown[])[i]));
  const ka = Object.keys(a as object);
  const kb = Object.keys(b as object);
  return ka.length === kb.length && ka.every((k) => Object.prototype.hasOwnProperty.call(b, k) && deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
}

const regexCache = new Map<string, RegExp | null>();
function regex(p: string): RegExp | null {
  if (!regexCache.has(p)) {
    let r: RegExp | null = null;
    try {
      r = new RegExp(p, 'u');
    } catch {
      r = null;
    }
    if (regexCache.size > 500) regexCache.clear();
    regexCache.set(p, r);
  }
  return regexCache.get(p)!;
}

function resolveRef(root: Schema, ref: string): Schema | undefined {
  if (ref === '#') return root;
  if (!ref.startsWith('#/')) return undefined;
  let cur: unknown = root;
  for (const raw of ref.slice(2).split('/')) {
    const k = decodeURIComponent(raw).replace(/~1/g, '/').replace(/~0/g, '~');
    if (!isObj(cur) && !Array.isArray(cur)) return undefined;
    cur = (cur as Record<string, unknown>)[k];
    if (cur === undefined) return undefined;
  }
  return typeof cur === 'boolean' || isObj(cur) ? (cur as Schema) : undefined;
}

class Validator {
  readonly errors: SchemaError[] = [];
  constructor(private readonly root: Schema) {}

  private add(path: string, message: string): void {
    if (this.errors.length < MAX_ERRORS) this.errors.push({ path, message });
  }

  /** Validate into a scratch validator (for combinators); returns whether the value matched. */
  private probe(s: Schema, v: unknown, path: string, depth: number): boolean {
    const sub = new Validator(this.root);
    sub.check(s, v, path, depth);
    return sub.errors.length === 0;
  }

  check(s: Schema, v: unknown, path: string, depth: number): void {
    if (this.errors.length >= MAX_ERRORS) return;
    if (s === true) return;
    if (s === false) return this.add(path, 'no value is allowed here (schema false)');
    if (!isObj(s)) return;
    if (depth > MAX_DEPTH) return this.add(path, 'schema nesting too deep (recursive $ref?)');
    if (typeof s.$ref === 'string') {
      const target = resolveRef(this.root, s.$ref);
      if (target === undefined) return this.add(path, `unsupported $ref "${s.$ref}" (only local #/… references)`);
      this.check(target, v, path, depth + 1);
    }
    const t = typeOf(v);
    if (s.type !== undefined) {
      const types = (Array.isArray(s.type) ? s.type : [s.type]) as unknown[];
      const ok = types.some((x) => x === t || (x === 'integer' && t === 'number' && Number.isInteger(v)) || (x === 'number' && t === 'number'));
      if (!ok) return this.add(path, `expected ${types.join(' or ')}, got ${t === 'number' && !Number.isInteger(v) ? 'number' : t}`);
    }
    if (Array.isArray(s.enum) && !s.enum.some((e) => deepEqual(e, v))) this.add(path, `must be one of ${JSON.stringify(s.enum).slice(0, 120)}`);
    if ('const' in s && !deepEqual(s.const, v)) this.add(path, `must equal ${JSON.stringify(s.const).slice(0, 120)}`);

    if (t === 'number') {
      const n = v as number;
      if (typeof s.minimum === 'number' && n < s.minimum) this.add(path, `must be ≥ ${s.minimum}`);
      if (typeof s.maximum === 'number' && n > s.maximum) this.add(path, `must be ≤ ${s.maximum}`);
      if (typeof s.exclusiveMinimum === 'number' && n <= s.exclusiveMinimum) this.add(path, `must be > ${s.exclusiveMinimum}`);
      if (typeof s.exclusiveMaximum === 'number' && n >= s.exclusiveMaximum) this.add(path, `must be < ${s.exclusiveMaximum}`);
      if (typeof s.multipleOf === 'number' && s.multipleOf > 0) {
        const q = n / s.multipleOf;
        if (Math.abs(q - Math.round(q)) > 1e-9) this.add(path, `must be a multiple of ${s.multipleOf}`);
      }
    }
    if (t === 'string') {
      const str = v as string;
      const len = [...str].length;
      if (typeof s.minLength === 'number' && len < s.minLength) this.add(path, `must be at least ${s.minLength} characters`);
      if (typeof s.maxLength === 'number' && len > s.maxLength) this.add(path, `must be at most ${s.maxLength} characters`);
      if (typeof s.pattern === 'string') {
        const r = regex(s.pattern);
        if (!r) this.add(path, `invalid pattern in schema: ${s.pattern}`);
        else if (!r.test(str)) this.add(path, `must match ${s.pattern}`);
      }
    }
    if (t === 'array') {
      const arr = v as unknown[];
      if (typeof s.minItems === 'number' && arr.length < s.minItems) this.add(path, `must have at least ${s.minItems} items`);
      if (typeof s.maxItems === 'number' && arr.length > s.maxItems) this.add(path, `must have at most ${s.maxItems} items`);
      if (s.uniqueItems === true) {
        for (let i = 0; i < arr.length; i++) for (let j = i + 1; j < arr.length; j++) if (deepEqual(arr[i], arr[j])) { this.add(path, `items ${i} and ${j} are equal (uniqueItems)`); i = arr.length; break; }
      }
      const prefix = Array.isArray(s.prefixItems) ? (s.prefixItems as Schema[]) : [];
      prefix.forEach((ps, i) => i < arr.length && this.check(ps, arr[i], `${path}/${i}`, depth + 1));
      const items = s.items as Schema | Schema[] | undefined;
      if (Array.isArray(items)) items.forEach((is, i) => i < arr.length && this.check(is, arr[i], `${path}/${i}`, depth + 1)); // draft-07 tuple form
      else if (items !== undefined) for (let i = prefix.length; i < arr.length; i++) this.check(items, arr[i], `${path}/${i}`, depth + 1);
      if (s.contains !== undefined && !arr.some((x, i) => this.probe(s.contains as Schema, x, `${path}/${i}`, depth + 1))) this.add(path, 'no item matches "contains"');
    }
    if (t === 'object') {
      const o = v as Record<string, unknown>;
      const keys = Object.keys(o);
      if (typeof s.minProperties === 'number' && keys.length < s.minProperties) this.add(path, `must have at least ${s.minProperties} properties`);
      if (typeof s.maxProperties === 'number' && keys.length > s.maxProperties) this.add(path, `must have at most ${s.maxProperties} properties`);
      if (Array.isArray(s.required)) for (const r of s.required) if (typeof r === 'string' && !(r in o)) this.add(path, `missing required property "${r}"`);
      const props = isObj(s.properties) ? (s.properties as Record<string, Schema>) : {};
      const pats = isObj(s.patternProperties) ? Object.entries(s.patternProperties as Record<string, Schema>) : [];
      for (const k of keys) {
        const p = `${path}/${esc(k)}`;
        if (s.propertyNames !== undefined && !this.probe(s.propertyNames as Schema, k, p, depth + 1)) this.add(p, `property name "${k}" does not match propertyNames`);
        let known = false;
        if (Object.prototype.hasOwnProperty.call(props, k)) {
          known = true;
          this.check(props[k]!, o[k], p, depth + 1);
        }
        for (const [pat, ps] of pats) {
          const r = regex(pat);
          if (r?.test(k)) {
            known = true;
            this.check(ps, o[k], p, depth + 1);
          }
        }
        if (!known && s.additionalProperties !== undefined) {
          if (s.additionalProperties === false) this.add(p, `unexpected property "${k}"`);
          else if (isObj(s.additionalProperties) || s.additionalProperties === true) this.check(s.additionalProperties as Schema, o[k], p, depth + 1);
        }
      }
    }
    if (Array.isArray(s.allOf)) for (const a of s.allOf as Schema[]) this.check(a, v, path, depth + 1);
    if (Array.isArray(s.anyOf) && !(s.anyOf as Schema[]).some((a) => this.probe(a, v, path, depth + 1))) this.add(path, 'does not match any of the "anyOf" schemas');
    if (Array.isArray(s.oneOf)) {
      const n = (s.oneOf as Schema[]).filter((a) => this.probe(a, v, path, depth + 1)).length;
      if (n !== 1) this.add(path, `must match exactly one "oneOf" schema (matches ${n})`);
    }
    if (s.not !== undefined && this.probe(s.not as Schema, v, path, depth + 1)) this.add(path, 'must not match the "not" schema');
    if (s.if !== undefined) {
      const branch = this.probe(s.if as Schema, v, path, depth + 1) ? s.then : s.else;
      if (branch !== undefined) this.check(branch as Schema, v, path, depth + 1);
    }
  }
}

/** Validate a value against a JSON Schema (the subset described in the module comment). */
export function validateJsonSchema(schema: unknown, value: unknown): SchemaResult {
  const s: Schema = typeof schema === 'boolean' ? schema : isObj(schema) ? schema : true;
  const v = new Validator(s);
  v.check(s, value, '', 0);
  return { valid: v.errors.length === 0, errors: v.errors };
}

/** JSON with object keys sorted at every level (arrays keep their order). */
export function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map((x) => canonicalJson(x === undefined ? null : x)).join(',')}]`;
  if (isObj(v)) {
    return `{${Object.keys(v)
      .filter((k) => v[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(v[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(v ?? null);
}

/**
 * 15.3.0-canary.0: the digest `policy.toolSchemas.pins` compares — sha256 (hex) of the canonical JSON of
 * `{ inputSchema, outputSchema }` (absent schemas count as `null`). Names, titles and descriptions are not part of it.
 */
export function toolSchemaDigest(tool: { inputSchema?: unknown; outputSchema?: unknown }): string {
  return createHash('sha256').update(canonicalJson({ inputSchema: tool.inputSchema ?? null, outputSchema: tool.outputSchema ?? null })).digest('hex');
}
