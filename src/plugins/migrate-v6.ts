/**
 * 16.9.0-canary.0: plugin API v5 → v6 codemod for a module plugin's source (`mcp-gateway plugin migrate --to v6`).
 *
 * Rewrites what can be rewritten safely, as text (the file keeps its formatting and comments):
 * - `apiVersion: 5` → `apiVersion: 6`;
 * - single-property object literals in the v4-era outcome shapes →  `{ action }` outcomes:
 *   `{ deny: X }` → `{ action: 'deny', reason: X }`, `{ respond: X }` → `{ action: 'respond', result: X }`,
 *   `{ arguments: X }` → `{ action: 'rewrite', arguments: X }`.
 *
 * Reports what needs a person: `onResponse` (a v5 hook may return a whole response; v6 needs
 * `{ action: 'replace', result }` — not decidable from the text), `onRequest` / `routes` (no HTTP hooks in a v6 module
 * plugin), and a plugin without `apiVersion`. Running it again on its output changes nothing.
 *
 * @module plugins/migrate-v6
 */

export interface PluginMigrationChange {
  kind: 'apiVersion' | 'outcome';
  line: number;
  before: string;
  after: string;
}
export interface PluginMigrationNote {
  kind: 'onResponse' | 'http-hooks' | 'apiVersion';
  line: number | null;
  message: string;
}
export interface PluginMigration {
  output: string;
  changes: PluginMigrationChange[];
  manual: PluginMigrationNote[];
}

const OUTCOME: Record<string, (expr: string) => string> = {
  deny: (x) => `action: 'deny', reason: ${x}`,
  respond: (x) => `action: 'respond', result: ${x}`,
  arguments: (x) => `action: 'rewrite', arguments: ${x}`,
};

const lineOf = (src: string, i: number) => src.slice(0, i).split('\n').length;

/** Index of the bracket closing the one at `open` (strings and template literals skipped), or -1. */
function closing(src: string, open: number): number {
  const pairs: Record<string, string> = { '{': '}', '(': ')', '[': ']' };
  const stack: string[] = [];
  for (let i = open; i < src.length; i++) {
    const c = src[i]!;
    if (c === '"' || c === "'" || c === '`') {
      for (i++; i < src.length && src[i] !== c; i++) if (src[i] === '\\') i++;
      continue;
    }
    if (pairs[c]) stack.push(pairs[c]!);
    else if (c === '}' || c === ')' || c === ']') {
      if (stack.pop() !== c) return -1;
      if (stack.length === 0) return i;
    }
  }
  return -1;
}

/** Whether `body` (an object literal's inside) has a top-level comma, i.e. more than one property. */
function topLevelComma(body: string): boolean {
  let depth = 0;
  for (let i = 0; i < body.length; i++) {
    const c = body[i]!;
    if (c === '"' || c === "'" || c === '`') {
      for (i++; i < body.length && body[i] !== c; i++) if (body[i] === '\\') i++;
      continue;
    }
    if (c === '{' || c === '(' || c === '[') depth++;
    else if (c === '}' || c === ')' || c === ']') depth--;
    else if (c === ',' && depth === 0 && body.slice(i + 1).trim() !== '') return true;
  }
  return false;
}

/** Rewrite one module plugin source from plugin API v5 to v6 (see the module docs). */
export function migratePluginSource(src: string): PluginMigration {
  const changes: PluginMigrationChange[] = [];
  const manual: PluginMigrationNote[] = [];
  let out = src;

  // 1. literal outcomes, last match first so earlier indexes stay valid
  const re = /\{\s*(deny|respond|arguments)\s*:/g;
  const hits: Array<{ start: number; end: number; key: string }> = [];
  for (let m = re.exec(out); m; m = re.exec(out)) {
    const end = closing(out, m.index);
    if (end < 0) continue;
    const body = out.slice(m.index + 1, end);
    if (topLevelComma(body)) continue; // more than one property: not an outcome literal we can be sure of
    // an outcome is returned: `return {`, `=> ({`, `=> {` would be a block — only `return` and `=> (` qualify
    const before = out.slice(0, m.index).replace(/\s+$/, '');
    if (!/(\breturn|=>\s*\(|\?|:)$/.test(before)) continue;
    hits.push({ start: m.index, end, key: m[1]! });
  }
  for (const h of hits.reverse()) {
    const body = out.slice(h.start + 1, h.end);
    const expr = body.slice(body.indexOf(':') + 1).trim().replace(/,$/, '').trim();
    const replacement = `{ ${OUTCOME[h.key]!(expr)} }`;
    changes.unshift({ kind: 'outcome', line: lineOf(out, h.start), before: out.slice(h.start, h.end + 1), after: replacement });
    out = out.slice(0, h.start) + replacement + out.slice(h.end + 1);
  }

  // 2. apiVersion
  const api = /\bapiVersion\s*:\s*(\d+)/.exec(out);
  if (!api) {
    manual.push({ kind: 'apiVersion', line: null, message: 'no `apiVersion` found — declare `apiVersion: 6` on the plugin object' });
  } else if (api[1] === '5') {
    const before = api[0];
    const after = before.replace(/5$/, '6');
    changes.unshift({ kind: 'apiVersion', line: lineOf(out, api.index), before, after });
    out = out.slice(0, api.index) + after + out.slice(api.index + before.length);
  }

  // 3. what needs a person (reported on every run while it is there)
  const onResponse = /\bonResponse\b/.exec(out);
  if (onResponse && !/action\s*:\s*['"](replace|continue)['"]/.test(out)) {
    manual.push({ kind: 'onResponse', line: lineOf(out, onResponse.index), message: "onResponse: return { action: 'replace', result } (or { action: 'continue' }) — plugin API v6 refuses a returned response object" });
  }
  const http = /\b(onRequest|routes)\b/.exec(out);
  if (http) {
    manual.push({ kind: 'http-hooks', line: lineOf(out, http.index), message: `${http[1]}: plugin API v6 module plugins run in a worker or a child process and cannot have HTTP hooks — move request handling out of the plugin` });
  }
  return { output: out, changes, manual };
}

/** Human-readable report of a migration (CLI). */
export function formatPluginMigration(file: string, r: PluginMigration, wrote: boolean): string {
  const lines = [`${file}: ${r.changes.length} change(s)${wrote ? ' written' : ' (dry run — use --in-place to write)'}`];
  for (const c of r.changes) lines.push(`  line ${c.line}: ${c.before}  →  ${c.after}`);
  if (r.manual.length) {
    lines.push('Needs a person:');
    for (const m of r.manual) lines.push(`  ${m.line === null ? '' : `line ${m.line}: `}${m.message}`);
  }
  return lines.join('\n');
}
