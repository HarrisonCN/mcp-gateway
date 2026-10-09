/**
 * Cedar policies (10.5, policy-as-code 2.0): a parser and evaluator for the subset of the
 * [Cedar policy language](https://docs.cedarpolicy.com/) that tool calls need. No external dependency.
 *
 * Supported:
 * - `permit` / `forbid` with scope `principal`, `action`, `resource` constrained by `==`, `in` (entity or, for
 *   actions, a list) and `is <Type>` (optionally `is <Type> in <entity>`);
 * - `when { … }` / `unless { … }` conditions; `@id("…")` (and any other) annotations;
 * - expressions: `&&`, `||`, `!`, `==`, `!=`, `<`, `<=`, `>`, `>=`, `+`, `-`, `*`, `in`, `like` (with `*`
 *   wildcards), `has`, `is`, `if … then … else …`, attribute access (`a.b`, `a["b"]`), set / record literals,
 *   `.contains()`, `.containsAll()`, `.containsAny()`, `.isEmpty()`, entity references (`Type::"id"`,
 *   namespaced `A::B::"id"`).
 *
 * Not supported (rejected at parse time): extension functions (`ip()`, `decimal()`, `datetime()`), templates
 * (`?principal`), schemas / validation, entity attributes beyond those the gateway supplies.
 *
 * Semantics follow Cedar: a request is allowed when at least one `permit` is satisfied and no `forbid` is;
 * otherwise denied (**default deny**). A policy whose condition raises an error (missing attribute, type
 * mismatch) does not apply and is reported in `errors`.
 *
 * Request model used by the gateway (see {@link toCedarRequest}): principal `Client::"<client id>"` (attributes
 * `id`, `tenant`; member of `Tenant::"<tenant>"`), action `Action::"callTool"`, resource
 * `Tool::"<server>/<tool>"` (attributes `server`, `tool`; member of `Server::"<server>"`), and `context`
 * `{ args, tenant, via, time, hour, weekday }`.
 *
 * @module policy/cedar
 */

export interface EntityRef {
  type: string;
  id: string;
}

export type CedarValue = string | number | boolean | EntityRef | CedarValue[] | { [k: string]: CedarValue } | null;

export interface CedarEntity {
  uid: EntityRef;
  attrs?: Record<string, CedarValue>;
  /** Ancestors (for `in`). */
  parents?: EntityRef[];
}

export interface CedarRequest {
  principal: CedarEntity;
  action: CedarEntity;
  resource: CedarEntity;
  context: Record<string, CedarValue>;
}

export interface CedarDecision {
  decision: 'allow' | 'deny';
  /** Ids of the policies that determined the decision (satisfied forbids, or satisfied permits). */
  reasons: string[];
  errors: Array<{ policy: string; message: string }>;
}

// ─── Lexer ────────────────────────────────────────────────────────────────────

type Tok = { t: 'id' | 'str' | 'num' | 'op' | 'eof'; v: string; pos: number };

const OPS = ['::', '==', '!=', '<=', '>=', '&&', '||', '(', ')', '{', '}', '[', ']', ',', ';', '.', '<', '>', '!', '+', '-', '*', '@', ':'];

export class CedarSyntaxError extends Error {
  constructor(message: string, readonly pos: number, src: string) {
    const line = src.slice(0, pos).split('\n').length;
    super(`Cedar syntax error at line ${line}: ${message}`);
    this.name = 'CedarSyntaxError';
  }
}

function lex(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (c === '/' && src[i + 1] === '/') {
      while (i < src.length && src[i] !== '\n') i++;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      let s = '';
      while (j < src.length && src[j] !== '"') {
        if (src[j] === '\\') {
          const n = src[j + 1];
          s += n === 'n' ? '\n' : n === 't' ? '\t' : n === '*' ? '\\*' : (n ?? '');
          j += 2;
        } else s += src[j++];
      }
      if (j >= src.length) throw new CedarSyntaxError('unterminated string', i, src);
      out.push({ t: 'str', v: s, pos: i });
      i = j + 1;
      continue;
    }
    if (/[0-9]/.test(c)) {
      let j = i;
      while (j < src.length && /[0-9]/.test(src[j]!)) j++;
      out.push({ t: 'num', v: src.slice(i, j), pos: i });
      i = j;
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      let j = i;
      while (j < src.length && /[A-Za-z0-9_]/.test(src[j]!)) j++;
      out.push({ t: 'id', v: src.slice(i, j), pos: i });
      i = j;
      continue;
    }
    const op = OPS.find((o) => src.startsWith(o, i));
    if (!op) throw new CedarSyntaxError(`unexpected character ${JSON.stringify(c)}`, i, src);
    out.push({ t: 'op', v: op, pos: i });
    i += op.length;
  }
  out.push({ t: 'eof', v: '', pos: src.length });
  return out;
}

// ─── AST ──────────────────────────────────────────────────────────────────────

type Expr =
  | { k: 'lit'; v: CedarValue }
  | { k: 'var'; name: 'principal' | 'action' | 'resource' | 'context' }
  | { k: 'ent'; v: EntityRef }
  | { k: 'set'; items: Expr[] }
  | { k: 'rec'; fields: Array<[string, Expr]> }
  | { k: 'not'; e: Expr }
  | { k: 'neg'; e: Expr }
  | { k: 'bin'; op: string; l: Expr; r: Expr }
  | { k: 'like'; e: Expr; pattern: string }
  | { k: 'has'; e: Expr; attr: string }
  | { k: 'is'; e: Expr; type: string; in?: Expr }
  | { k: 'get'; e: Expr; attr: string }
  | { k: 'call'; e: Expr; fn: string; args: Expr[] }
  | { k: 'if'; c: Expr; t: Expr; f: Expr };

type Scope = { op: 'any' } | { op: '=='; e: EntityRef } | { op: 'in'; e: EntityRef[] } | { op: 'is'; type: string; in?: EntityRef };

export interface CedarPolicy {
  id: string;
  effect: 'permit' | 'forbid';
  principal: Scope;
  action: Scope;
  resource: Scope;
  conditions: Array<{ kind: 'when' | 'unless'; e: Expr }>;
  annotations: Record<string, string>;
}

// ─── Parser ───────────────────────────────────────────────────────────────────

class Parser {
  private i = 0;
  constructor(
    private readonly toks: Tok[],
    private readonly src: string,
  ) {}

  private peek(o = 0): Tok {
    return this.toks[Math.min(this.i + o, this.toks.length - 1)]!;
  }
  private next(): Tok {
    return this.toks[this.i++]!;
  }
  private is(v: string, o = 0): boolean {
    const t = this.peek(o);
    return (t.t === 'op' || t.t === 'id') && t.v === v;
  }
  private eat(v: string): Tok {
    const t = this.next();
    if ((t.t !== 'op' && t.t !== 'id') || t.v !== v) throw new CedarSyntaxError(`expected "${v}" but found ${t.t === 'eof' ? 'end of input' : JSON.stringify(t.v)}`, t.pos, this.src);
    return t;
  }
  private fail(msg: string): never {
    throw new CedarSyntaxError(msg, this.peek().pos, this.src);
  }

  policies(): CedarPolicy[] {
    const out: CedarPolicy[] = [];
    while (this.peek().t !== 'eof') out.push(this.policy(out.length));
    return out;
  }

  private policy(index: number): CedarPolicy {
    const annotations: Record<string, string> = {};
    while (this.is('@')) {
      this.next();
      const name = this.ident();
      this.eat('(');
      const v = this.next();
      if (v.t !== 'str') this.fail('annotation value must be a string');
      annotations[name] = v.v;
      this.eat(')');
    }
    const eff = this.ident();
    if (eff !== 'permit' && eff !== 'forbid') this.fail(`expected "permit" or "forbid", found ${JSON.stringify(eff)}`);
    this.eat('(');
    this.eat('principal');
    const principal = this.scope(false);
    this.eat(',');
    this.eat('action');
    const action = this.scope(true);
    this.eat(',');
    this.eat('resource');
    const resource = this.scope(false);
    this.eat(')');
    const conditions: CedarPolicy['conditions'] = [];
    while (this.is('when') || this.is('unless')) {
      const kind = this.next().v as 'when' | 'unless';
      this.eat('{');
      conditions.push({ kind, e: this.expr() });
      this.eat('}');
    }
    this.eat(';');
    return { id: annotations.id ?? `policy${index}`, effect: eff, principal, action, resource, conditions, annotations };
  }

  private ident(): string {
    const t = this.next();
    if (t.t !== 'id') throw new CedarSyntaxError(`expected an identifier, found ${t.t === 'eof' ? 'end of input' : JSON.stringify(t.v)}`, t.pos, this.src);
    return t.v;
  }

  private scope(isAction: boolean): Scope {
    if (this.is('==')) {
      this.next();
      return { op: '==', e: this.entityRef() };
    }
    if (this.is('in')) {
      this.next();
      if (isAction && this.is('[')) {
        this.next();
        const list: EntityRef[] = [];
        while (!this.is(']')) {
          list.push(this.entityRef());
          if (!this.is(']')) this.eat(',');
        }
        this.eat(']');
        return { op: 'in', e: list };
      }
      return { op: 'in', e: [this.entityRef()] };
    }
    if (!isAction && this.is('is')) {
      this.next();
      const type = this.typeName();
      if (this.is('in')) {
        this.next();
        return { op: 'is', type, in: this.entityRef() };
      }
      return { op: 'is', type };
    }
    if (this.peek().t === 'op' && this.peek().v === '?') this.fail('policy templates are not supported');
    return { op: 'any' };
  }

  private typeName(): string {
    const parts = [this.ident()];
    while (this.is('::') && this.peek(1).t === 'id') {
      this.next();
      parts.push(this.ident());
    }
    return parts.join('::');
  }

  private entityRef(): EntityRef {
    const parts = [this.ident()];
    for (;;) {
      this.eat('::');
      const t = this.next();
      if (t.t === 'str') return { type: parts.join('::'), id: t.v };
      if (t.t !== 'id') throw new CedarSyntaxError('expected an entity id string', t.pos, this.src);
      parts.push(t.v);
    }
  }

  expr(): Expr {
    if (this.is('if')) {
      this.next();
      const c = this.expr();
      this.eat('then');
      const t = this.expr();
      this.eat('else');
      return { k: 'if', c, t, f: this.expr() };
    }
    return this.or();
  }
  private or(): Expr {
    let l = this.and();
    while (this.is('||')) {
      this.next();
      l = { k: 'bin', op: '||', l, r: this.and() };
    }
    return l;
  }
  private and(): Expr {
    let l = this.rel();
    while (this.is('&&')) {
      this.next();
      l = { k: 'bin', op: '&&', l, r: this.rel() };
    }
    return l;
  }
  private rel(): Expr {
    const l = this.add();
    for (const op of ['==', '!=', '<=', '>=', '<', '>', 'in']) {
      if (this.is(op)) {
        this.next();
        return { k: 'bin', op, l, r: this.add() };
      }
    }
    if (this.is('like')) {
      this.next();
      const t = this.next();
      if (t.t !== 'str') throw new CedarSyntaxError('"like" needs a string pattern', t.pos, this.src);
      return { k: 'like', e: l, pattern: t.v };
    }
    if (this.is('has')) {
      this.next();
      const t = this.next();
      if (t.t !== 'id' && t.t !== 'str') throw new CedarSyntaxError('"has" needs an attribute name', t.pos, this.src);
      return { k: 'has', e: l, attr: t.v };
    }
    if (this.is('is')) {
      this.next();
      const type = this.typeName();
      if (this.is('in')) {
        this.next();
        return { k: 'is', e: l, type, in: this.add() };
      }
      return { k: 'is', e: l, type };
    }
    return l;
  }
  private add(): Expr {
    let l = this.mul();
    while (this.is('+') || this.is('-')) {
      const op = this.next().v;
      l = { k: 'bin', op, l, r: this.mul() };
    }
    return l;
  }
  private mul(): Expr {
    let l = this.unary();
    while (this.is('*')) {
      this.next();
      l = { k: 'bin', op: '*', l, r: this.unary() };
    }
    return l;
  }
  private unary(): Expr {
    if (this.is('!')) {
      this.next();
      return { k: 'not', e: this.unary() };
    }
    if (this.is('-')) {
      this.next();
      return { k: 'neg', e: this.unary() };
    }
    return this.member();
  }
  private member(): Expr {
    let e = this.primary();
    for (;;) {
      if (this.is('.')) {
        this.next();
        const name = this.ident();
        if (this.is('(')) {
          this.next();
          const args: Expr[] = [];
          while (!this.is(')')) {
            args.push(this.expr());
            if (!this.is(')')) this.eat(',');
          }
          this.eat(')');
          if (!['contains', 'containsAll', 'containsAny', 'isEmpty'].includes(name)) this.fail(`method "${name}" is not supported`);
          e = { k: 'call', e, fn: name, args };
        } else e = { k: 'get', e, attr: name };
      } else if (this.is('[')) {
        this.next();
        const t = this.next();
        if (t.t !== 'str') throw new CedarSyntaxError('index must be a string', t.pos, this.src);
        this.eat(']');
        e = { k: 'get', e, attr: t.v };
      } else return e;
    }
  }
  private primary(): Expr {
    const t = this.peek();
    if (t.t === 'str') {
      this.next();
      return { k: 'lit', v: t.v };
    }
    if (t.t === 'num') {
      this.next();
      return { k: 'lit', v: Number(t.v) };
    }
    if (this.is('(')) {
      this.next();
      const e = this.expr();
      this.eat(')');
      return e;
    }
    if (this.is('[')) {
      this.next();
      const items: Expr[] = [];
      while (!this.is(']')) {
        items.push(this.expr());
        if (!this.is(']')) this.eat(',');
      }
      this.eat(']');
      return { k: 'set', items };
    }
    if (this.is('{')) {
      this.next();
      const fields: Array<[string, Expr]> = [];
      while (!this.is('}')) {
        const key = this.next();
        if (key.t !== 'id' && key.t !== 'str') throw new CedarSyntaxError('record key must be an identifier or string', key.pos, this.src);
        this.eat(':');
        fields.push([key.v, this.expr()]);
        if (!this.is('}')) this.eat(',');
      }
      this.eat('}');
      return { k: 'rec', fields };
    }
    if (t.t === 'id') {
      if (t.v === 'true' || t.v === 'false') {
        this.next();
        return { k: 'lit', v: t.v === 'true' };
      }
      if (t.v === 'principal' || t.v === 'action' || t.v === 'resource' || t.v === 'context') {
        this.next();
        return { k: 'var', name: t.v };
      }
      if (this.peek(1).t === 'op' && this.peek(1).v === '::') return { k: 'ent', v: this.entityRef() };
      if (this.peek(1).t === 'op' && this.peek(1).v === '(') this.fail(`extension function "${t.v}()" is not supported`);
      this.fail(`unknown identifier ${JSON.stringify(t.v)}`);
    }
    if (t.t === 'op' && t.v === '?') this.fail('policy templates are not supported');
    this.fail(`unexpected ${t.t === 'eof' ? 'end of input' : JSON.stringify(t.v)}`);
  }
}

/** Parse a policy set. Throws {@link CedarSyntaxError}. Duplicate `@id`s are an error. */
export function parseCedar(src: string): CedarPolicy[] {
  const list = new Parser(lex(src), src).policies();
  const seen = new Set<string>();
  for (const p of list) {
    if (seen.has(p.id)) throw new Error(`Cedar: duplicate policy id "${p.id}"`);
    seen.add(p.id);
  }
  return list;
}

// ─── Evaluation ───────────────────────────────────────────────────────────────

class EvalError extends Error {}

const isEntity = (v: unknown): v is EntityRef => !!v && typeof v === 'object' && !Array.isArray(v) && typeof (v as EntityRef).type === 'string' && typeof (v as EntityRef).id === 'string' && Object.keys(v as object).length === 2;
const sameEntity = (a: EntityRef, b: EntityRef) => a.type === b.type && a.id === b.id;

function equal(a: CedarValue, b: CedarValue): boolean {
  if (isEntity(a) && isEntity(b)) return sameEntity(a, b);
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x) => b.some((y) => equal(x, y))) && b.every((y) => a.some((x) => equal(x, y)));
  if (a && b && typeof a === 'object' && typeof b === 'object' && !Array.isArray(a) && !Array.isArray(b)) {
    const ka = Object.keys(a);
    const kb = Object.keys(b);
    return ka.length === kb.length && ka.every((k) => k in b && equal((a as Record<string, CedarValue>)[k]!, (b as Record<string, CedarValue>)[k]!));
  }
  return a === b;
}

/** `*` wildcard match (`\*` is a literal star). */
export function cedarLike(value: string, pattern: string): boolean {
  let re = '^';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]!;
    if (c === '\\' && pattern[i + 1] === '*') {
      re += '\\*';
      i++;
    } else if (c === '*') re += '[\\s\\S]*';
    else re += c.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`${re}$`).test(value);
}

class Evaluator {
  private readonly entities = new Map<string, CedarEntity>();
  constructor(private readonly req: CedarRequest) {
    for (const e of [req.principal, req.action, req.resource]) this.entities.set(`${e.uid.type}::${e.uid.id}`, e);
  }

  /** `a in b`: equal, or b is an ancestor of a. */
  private inEntity(a: EntityRef, b: EntityRef): boolean {
    if (sameEntity(a, b)) return true;
    const ent = this.entities.get(`${a.type}::${a.id}`);
    return !!ent?.parents?.some((p) => sameEntity(p, b));
  }

  scope(s: Scope, uid: EntityRef): boolean {
    switch (s.op) {
      case 'any':
        return true;
      case '==':
        return sameEntity(uid, s.e);
      case 'in':
        return s.e.some((e) => this.inEntity(uid, e));
      case 'is':
        return uid.type === s.type && (!s.in || this.inEntity(uid, s.in));
    }
  }

  private attrsOf(v: CedarValue): Record<string, CedarValue> {
    if (isEntity(v)) return this.entities.get(`${v.type}::${v.id}`)?.attrs ?? {};
    if (v && typeof v === 'object' && !Array.isArray(v)) return v as Record<string, CedarValue>;
    throw new EvalError('attribute access on a value that is not a record or entity');
  }

  private bool(v: CedarValue): boolean {
    if (typeof v !== 'boolean') throw new EvalError(`expected a boolean, got ${JSON.stringify(v)}`);
    return v;
  }
  private num(v: CedarValue): number {
    if (typeof v !== 'number') throw new EvalError(`expected a number, got ${JSON.stringify(v)}`);
    return v;
  }
  private set(v: CedarValue): CedarValue[] {
    if (!Array.isArray(v)) throw new EvalError(`expected a set, got ${JSON.stringify(v)}`);
    return v;
  }

  eval(e: Expr): CedarValue {
    switch (e.k) {
      case 'lit':
        return e.v;
      case 'ent':
        return e.v;
      case 'var':
        return e.name === 'context' ? (this.req.context as CedarValue) : this.req[e.name].uid;
      case 'set':
        return e.items.map((x) => this.eval(x));
      case 'rec':
        return Object.fromEntries(e.fields.map(([k, v]) => [k, this.eval(v)]));
      case 'not':
        return !this.bool(this.eval(e.e));
      case 'neg':
        return -this.num(this.eval(e.e));
      case 'if':
        return this.bool(this.eval(e.c)) ? this.eval(e.t) : this.eval(e.f);
      case 'get': {
        const attrs = this.attrsOf(this.eval(e.e));
        if (!(e.attr in attrs) || attrs[e.attr] === undefined) throw new EvalError(`attribute "${e.attr}" does not exist`);
        return attrs[e.attr]!;
      }
      case 'has': {
        const v = this.eval(e.e);
        try {
          const attrs = this.attrsOf(v);
          return e.attr in attrs && attrs[e.attr] !== undefined && attrs[e.attr] !== null;
        } catch {
          return false;
        }
      }
      case 'like': {
        const v = this.eval(e.e);
        if (typeof v !== 'string') throw new EvalError('"like" needs a string');
        return cedarLike(v, e.pattern);
      }
      case 'is': {
        const v = this.eval(e.e);
        if (!isEntity(v)) throw new EvalError('"is" needs an entity');
        if (v.type !== e.type) return false;
        if (!e.in) return true;
        const target = this.eval(e.in);
        return this.inTest(v, target);
      }
      case 'call': {
        const target = this.eval(e.e);
        if (e.fn === 'isEmpty') return this.set(target).length === 0;
        const arg = this.eval(e.args[0] ?? { k: 'lit', v: null });
        const s = this.set(target);
        if (e.fn === 'contains') return s.some((x) => equal(x, arg));
        const other = this.set(arg);
        if (e.fn === 'containsAll') return other.every((y) => s.some((x) => equal(x, y)));
        return other.some((y) => s.some((x) => equal(x, y)));
      }
      case 'bin': {
        if (e.op === '&&') return this.bool(this.eval(e.l)) ? this.bool(this.eval(e.r)) : false;
        if (e.op === '||') return this.bool(this.eval(e.l)) ? true : this.bool(this.eval(e.r));
        const l = this.eval(e.l);
        const r = this.eval(e.r);
        switch (e.op) {
          case '==':
            return equal(l, r);
          case '!=':
            return !equal(l, r);
          case '<':
            return this.num(l) < this.num(r);
          case '<=':
            return this.num(l) <= this.num(r);
          case '>':
            return this.num(l) > this.num(r);
          case '>=':
            return this.num(l) >= this.num(r);
          case '+':
            return this.num(l) + this.num(r);
          case '-':
            return this.num(l) - this.num(r);
          case '*':
            return this.num(l) * this.num(r);
          case 'in':
            if (!isEntity(l)) throw new EvalError('left side of "in" must be an entity');
            return this.inTest(l, r);
        }
        throw new EvalError(`unknown operator ${e.op}`);
      }
    }
  }

  private inTest(l: EntityRef, r: CedarValue): boolean {
    if (isEntity(r)) return this.inEntity(l, r);
    if (Array.isArray(r)) return r.some((x) => isEntity(x) && this.inEntity(l, x));
    throw new EvalError('right side of "in" must be an entity or a set of entities');
  }
}

/** Evaluate a parsed policy set against one request. */
export function evaluateCedar(policies: readonly CedarPolicy[], req: CedarRequest): CedarDecision {
  const ev = new Evaluator(req);
  const permits: string[] = [];
  const forbids: string[] = [];
  const errors: CedarDecision['errors'] = [];
  for (const p of policies) {
    if (!ev.scope(p.principal, req.principal.uid) || !ev.scope(p.action, req.action.uid) || !ev.scope(p.resource, req.resource.uid)) continue;
    let ok = true;
    try {
      for (const c of p.conditions) {
        const v = ev.eval(c.e);
        if (typeof v !== 'boolean') throw new EvalError('condition is not a boolean');
        if ((c.kind === 'when') !== v) {
          ok = false;
          break;
        }
      }
    } catch (err) {
      errors.push({ policy: p.id, message: err instanceof Error ? err.message : String(err) });
      continue;
    }
    if (ok) (p.effect === 'forbid' ? forbids : permits).push(p.id);
  }
  if (forbids.length) return { decision: 'deny', reasons: forbids, errors };
  if (permits.length) return { decision: 'allow', reasons: permits, errors };
  return { decision: 'deny', reasons: [], errors };
}

/** JSON (tool arguments) → Cedar values: numbers stay numbers, nested arrays become sets, objects records. */
export function toCedarValue(v: unknown, depth = 0): CedarValue {
  if (depth > 32) return null;
  if (v === null || v === undefined) return null;
  if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return v;
  if (Array.isArray(v)) return v.map((x) => toCedarValue(x, depth + 1));
  if (typeof v === 'object') return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, toCedarValue(x, depth + 1)]));
  return String(v);
}

/** The gateway's tool-call request in Cedar terms (see the module docs). */
export function toCedarRequest(call: { clientId?: string; tenant?: string; serverId: string; tool: string; args?: Record<string, unknown>; via?: string }, now = new Date()): CedarRequest {
  const client = call.clientId ?? 'anonymous';
  const tenantParents = call.tenant ? [{ type: 'Tenant', id: call.tenant }] : [];
  return {
    principal: { uid: { type: 'Client', id: client }, attrs: { id: client, ...(call.tenant ? { tenant: call.tenant } : {}) }, parents: tenantParents },
    action: { uid: { type: 'Action', id: 'callTool' } },
    resource: { uid: { type: 'Tool', id: `${call.serverId}/${call.tool}` }, attrs: { server: call.serverId, tool: call.tool }, parents: [{ type: 'Server', id: call.serverId }] },
    context: {
      args: toCedarValue(call.args ?? {}),
      ...(call.tenant ? { tenant: call.tenant } : {}),
      via: call.via ?? 'rest',
      time: now.toISOString(),
      hour: now.getUTCHours(),
      weekday: now.getUTCDay(),
    },
  };
}
