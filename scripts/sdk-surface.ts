/**
 * 17.0.0-alpha.2: the SDK export surface — every export (value or type) of each package entry point
 * (`package.json` `exports`), computed from the TypeScript sources with the compiler API. `api/exports-surface.json`
 * records it; until 17.0.0 ships the surface may only grow (docs/v17/freeze.md): a recorded export that disappears is
 * a frozen-surface break (test/v17-sdk-surface-17-0-0.test.ts). First recorded at 17.0.0-alpha.2; re-recorded at
 * 17.0.0-rc.1 as the frozen list (test/v17-freeze-17-0-0-rc1.test.ts).
 *
 *   npx tsx scripts/sdk-surface.ts                         # prints recorded exports missing now (exit 1 when any)
 *   npx tsx scripts/sdk-surface.ts --record [--at <ver>]   # rewrites api/exports-surface.json (only at a freeze point)
 *   npx tsx scripts/sdk-surface.ts --record-file <f>       # checks against another record (tests)
 *
 * Entries are `value <name>` (anything that exists at runtime: functions, classes, consts, enums) or `type <name>`
 * (interfaces and type aliases only). Kept out of the gateway's import graph (scripts only).
 *
 * @module scripts/sdk-surface
 */
import { readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import ts from 'typescript';

/** Package entry point → TypeScript source (mirrors `package.json` `exports`). */
export const ENTRY_POINTS: Record<string, string> = {
  '.': 'src/index.ts',
  './gateway': 'src/gateway/public.ts',
  './edge': 'src/edge/entry.ts',
  './testing': 'src/testing/index.ts',
};

/** Sorted `value X` / `type X` entries per entry point. */
export function sdkSurface(root: string): Record<string, string[]> {
  const files = Object.values(ENTRY_POINTS).map((f) => join(root, f));
  const program = ts.createProgram(files, {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    allowJs: false,
    skipLibCheck: true,
    noEmit: true,
  });
  const checker = program.getTypeChecker();
  const out: Record<string, string[]> = {};
  for (const [entry, rel] of Object.entries(ENTRY_POINTS)) {
    const sf = program.getSourceFile(join(root, rel));
    const sym = sf && checker.getSymbolAtLocation(sf);
    if (!sym) throw new Error(`sdk-surface: cannot read ${rel}`);
    const names = new Set<string>();
    for (const e of checker.getExportsOfModule(sym)) {
      if (e.name === 'default') continue;
      const target = e.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(e) : e;
      // a type-only re-export (`export type { X }`) is a type even when X is a class
      const typeOnly = (e.declarations ?? []).some((d) => (ts.isExportSpecifier(d) && (d.isTypeOnly || d.parent.parent.isTypeOnly)));
      const isValue = !typeOnly && (target.flags & ts.SymbolFlags.Value) !== 0;
      names.add(`${isValue ? 'value' : 'type'} ${e.name}`);
    }
    out[entry] = [...names].sort();
  }
  return out;
}

/** Recorded exports that are missing from `current`, as `<entry>: <kind> <name>`. */
export function missingExports(recorded: Record<string, string[]>, current: Record<string, string[]>): string[] {
  const miss: string[] = [];
  for (const [e, names] of Object.entries(recorded)) {
    const now = new Set(current[e] ?? []);
    for (const n of names) if (!now.has(n)) miss.push(`${e}: ${n}`);
  }
  return miss;
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  const args = process.argv.slice(2);
  const opt = (k: string) => (args.includes(k) ? args[args.indexOf(k) + 1] : undefined);
  const cur = sdkSurface(root);
  if (args.includes('--record')) {
    const at = opt('--at') ?? JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
    const body = { $comment: 'SDK export surface (scripts/sdk-surface.ts), frozen from 17.0.0-rc.1: recorded exports may not disappear before 17.0.0 ships (docs/v17/freeze.md).', recordedAt: at, entries: cur };
    writeFileSync(join(root, 'api/exports-surface.json'), JSON.stringify(body, null, 2) + '\n');
    console.log(`recorded ${Object.values(cur).reduce((n, l) => n + l.length, 0)} exports at ${at}`);
  } else {
    const file = opt('--record-file') ?? join(root, 'api/exports-surface.json');
    const rec = JSON.parse(readFileSync(file, 'utf8'));
    const miss = missingExports(rec.entries, cur);
    for (const m of miss) console.log(`missing: ${m}`);
    const added = Object.entries(cur).reduce((n, [e, l]) => n + l.filter((x) => !(rec.entries[e] ?? []).includes(x)).length, 0);
    console.log(`sdk-surface: ${miss.length} missing, ${added} added since ${rec.recordedAt}`);
    process.exit(miss.length ? 1 : 0);
  }
}
