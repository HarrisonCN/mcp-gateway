/**
 * Docs auto-check (13.4.0): validates what the documentation tells users to run or copy.
 *
 *   npx tsx scripts/docs-check.ts [--json] [--external] [--root <dir>]
 *
 * Scans README*.md, SECURITY.md, docs/** /*.md, deploy/** /*.md, examples/** (Markdown and gateway config files) and
 * reports, with file:line:
 *
 *   config     YAML snippets that are gateway configs (or the `mcp-gateway.yml` of a Kubernetes ConfigMap / Helm
 *              `config:` value) are validated against config schema v11 (`validateConfig`); `version:` must be 11;
 *              unknown top-level keys are reported.
 *   syntax     JSON fences must parse; TypeScript / JavaScript fences must compile (esbuild); YAML fences must parse.
 *   cli        `mcp-gateway <command> --flag` in shell fences: the command and every flag must exist in src/cli.ts.
 *   link       relative links / images must point at existing files, `#anchors` at existing headings
 *              (`--external` also requests http(s) links).
 *   image      `ghcr.io/harrisoncn/mcp-gateway:<tag>` must be latest, the current major / minor / version, or a
 *              supported LTS line (scripts/docs-check.json) — stale tags (`:1`, `:1.0.0`, `:11`) fail.
 *   version    npm pins (`@winstonsayno/mcp-gateway@x`), `helm … --version x`, "latest x.y.z" statements, the Helm
 *              chart version / appVersion, the README "What's New" heading and the dashboard demo version must be
 *              current (or a supported LTS line).
 *
 * A fence preceded by `<!-- docs-check: skip -->` is not checked (use sparingly: historical before/after snippets).
 * Files listed under `historical` in scripts/docs-check.json (migration guides for earlier majors, the roadmap) are
 * exempt from the image / version / config-version rules, not from links or syntax.
 * Exit code 1 when anything is reported.
 */
import { readFileSync, existsSync, readdirSync, statSync } from 'fs';
import { join, relative, dirname, resolve, extname } from 'path';
import { parse as parseYaml, parseAllDocuments } from 'yaml';
import { transformSync } from 'esbuild';
import { validateConfig, CONFIG_FILE_KEYS } from '../src/config/loader.js';

export interface Finding {
  file: string;
  line: number;
  rule: 'config' | 'syntax' | 'cli' | 'link' | 'image' | 'version';
  message: string;
}

interface Settings {
  lts: Record<string, string>;
  distTags: string[];
  historical: string[];
}

const args = process.argv.slice(2);
const flag = (n: string) => args.includes(n);
const ROOT = resolve(args.includes('--root') ? args[args.indexOf('--root') + 1] : join(dirname(new URL(import.meta.url).pathname), '..'));

export function runDocsCheck(root = ROOT, opts: { external?: boolean } = {}): Promise<{ findings: Finding[]; stats: Record<string, number> }> {
  return check(root, opts);
}

const PLACEHOLDER = /<[^>]*>|…|\.\.\.|xxx|change-me|-----BEGIN [A-Z ]+-----\s*(\.\.\.|…)?/i;
const globToRe = (g: string) => new RegExp('^' + g.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*/g, '\u0000').replace(/\*/g, '[^/]*').replace(/\u0000/g, '.*') + '$');

function walk(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const n of readdirSync(dir)) {
    if (n === 'node_modules' || n.startsWith('.')) continue;
    const p = join(dir, n);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

/** GitHub heading anchor. */
export const slug = (h: string) =>
  h
    .trim()
    .toLowerCase()
    .replace(/<[^>]+>/g, '')
    .replace(/`/g, '')
    .replace(/[^\p{L}\p{N}\s_-]/gu, '')
    .replace(/\s/g, '-');

/** Commands and their flags, read from src/cli.ts (commander declarations). */
export function cliSpec(root: string): Map<string, Set<string>> {
  const src = readFileSync(join(root, 'src/cli.ts'), 'utf8');
  const spec = new Map<string, Set<string>>();
  const global = new Set(['--help', '-h', '--version', '-V']);
  spec.set('', new Set(global));
  // helpers that add options to a command they receive: `const remoteOptions = (cmd: Command) => cmd.option(…)…;`
  const helpers = new Map<string, string[]>();
  for (const h of src.matchAll(/const (\w+) = \(\w+: Command\) =>([\s\S]*?);\n/g)) {
    helpers.set(h[1], [...h[2].matchAll(/\.(?:required)?[oO]ption\('([^']+)'/g)].flatMap((o) => o[1].split(/[ ,]+/).filter((x) => x.startsWith('-'))));
  }
  let cur = '';
  const re = /(\w+)\(\s*program\s*\.command\('([^' ]+)|\.command\('([^' ]+)[^']*'\)|\.(?:requiredOption|option)\('([^']+)'/g;
  for (let m; (m = re.exec(src)); ) {
    const name = m[2] ?? m[3];
    if (name) {
      cur = name;
      if (!spec.has(cur)) spec.set(cur, new Set(global));
      if (m[1] && helpers.has(m[1])) for (const f of helpers.get(m[1])!) spec.get(cur)!.add(f);
    } else if (m[4]) {
      for (const part of m[4].split(/[ ,]+/)) if (part.startsWith('-')) spec.get(cur)!.add(part);
    }
  }
  return spec;
}

async function check(root: string, opts: { external?: boolean }) {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { version: string; name: string };
  const settings = JSON.parse(readFileSync(join(root, 'scripts/docs-check.json'), 'utf8')) as Settings;
  const V = pkg.version;
  const [MAJ, MIN] = V.split('.');
  const historical = settings.historical.map(globToRe);
  const isHistorical = (f: string) => historical.some((r) => r.test(f));
  const ltsAliases = new Set<string>();
  for (const [line, latest] of Object.entries(settings.lts)) {
    ltsAliases.add(line);
    ltsAliases.add(line.split('.')[0]);
    ltsAliases.add(latest);
  }
  const okVersion = (x: string) => ['latest', MAJ, `${MAJ}.${MIN}`, V, ...settings.distTags].includes(x) || ltsAliases.has(x);
  const cli = cliSpec(root);
  const findings: Finding[] = [];
  const stats: Record<string, number> = { files: 0, fences: 0, configs: 0, skipped: 0, links: 0, cli: 0, images: 0 };
  const add = (file: string, line: number, rule: Finding['rule'], message: string) => findings.push({ file, line, rule, message });

  const files = [
    ...['README.md', 'README.zh-CN.md', 'SECURITY.md'].map((f) => join(root, f)).filter(existsSync),
    ...walk(join(root, 'docs')).filter((f) => f.endsWith('.md')),
    ...walk(join(root, 'deploy')).filter((f) => f.endsWith('.md')),
    ...walk(join(root, 'examples')).filter((f) => /\.(md|ya?ml)$/.test(f)),
  ];
  const headingCache = new Map<string, Set<string>>();
  const headingsOf = (abs: string) => {
    let h = headingCache.get(abs);
    if (!h) {
      h = new Set();
      const counts = new Map<string, number>();
      let fence = false;
      for (const l of readFileSync(abs, 'utf8').split('\n')) {
        if (/^\s*(```|~~~)/.test(l)) fence = !fence;
        if (fence) continue;
        const m = /^#{1,6}\s+(.*?)\s*#*\s*$/.exec(l);
        if (m) {
          const s = slug(m[1]);
          const n = counts.get(s) ?? 0;
          h.add(n ? `${s}-${n}` : s);
          counts.set(s, n + 1);
        }
        for (const a of l.matchAll(/<a\s+(?:name|id)="([^"]+)"/g)) h.add(a[1]);
      }
      headingCache.set(abs, h);
    }
    return h;
  };

  const checkConfig = (rel: string, line: number, doc: Record<string, unknown>, hist: boolean) => {
    stats.configs++;
    const unknown = Object.keys(doc).filter((k) => !CONFIG_FILE_KEYS.includes(k));
    if (unknown.length) add(rel, line, 'config', `unknown top-level key(s): ${unknown.join(', ')}`);
    if (doc.version !== undefined && doc.version !== 11) {
      if (!hist) add(rel, line, 'config', `config "version: ${String(doc.version)}" — the current schema is version 11`);
      return;
    }
    // `${VAR}` references get a stand-in value (docs never carry real secrets); errors on documentation placeholders
    // (`<hex>`, `…`, `...`, `xxx`, `change-me`) are not findings.
    const filled = JSON.parse(JSON.stringify({ version: 11, servers: [], ...doc }).replace(/\$\{[A-Z0-9_]+(?::-[^}]*)?\}/g, 'docs-check-env-value-0123456789abcdef0123')) as Record<string, unknown>;
    try {
      validateConfig(filled);
    } catch (e) {
      const issues = (e as Error).message.replace(/^Invalid configuration:\s*/, '').split(/\n\s*-\s*/).map((x) => x.replace(/^\s*-\s*/, '').trim()).filter(Boolean);
      const real = issues.filter((iss) => {
        const path = /^([\w.]+):/.exec(iss)?.[1];
        if (!path) return true;
        // the error path is the runtime path: feature sections live under `features:` in the file
        const at = (base: unknown, keys: string[]) => keys.reduce<unknown>((v, k) => (v && typeof v === 'object' ? (v as Record<string, unknown>)[k] : undefined), base);
        const keys = path.split('.');
        const lookup = (ks: string[]) => at(filled, ks) ?? at(filled.features, ks);
        const text = (v: unknown) => (typeof v === 'string' ? v : v && typeof v === 'object' ? JSON.stringify(v) : '');
        // a placeholder in the value itself, or in the object that holds it (`{ id: a, ... }`, `# ...`)
        return !PLACEHOLDER.test(text(lookup(keys))) && !PLACEHOLDER.test(text(lookup(keys.slice(0, -1))));
      });
      if (real.length) add(rel, line, 'config', real.join('; '));
    }
  };
  /** A YAML document that is (or embeds) a gateway config. */
  const configsIn = (doc: unknown): Array<Record<string, unknown>> => {
    if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return [];
    const d = doc as Record<string, unknown>;
    if (d.kind === 'ConfigMap' && d.data && typeof d.data === 'object') {
      return Object.entries(d.data as Record<string, unknown>)
        .filter(([k, v]) => /mcp-gateway.*\.ya?ml$/.test(k) && typeof v === 'string')
        .flatMap(([, v]) => configsIn(parseYaml(v as string)));
    }
    if (d.apiVersion || d.services || d.scrape_configs || d.global) return [];
    const keys = Object.keys(d);
    if (!keys.length) return [];
    // Helm values: `config:` holds the gateway config
    if (keys.includes('config') && (keys.includes('image') || keys.includes('existingSecret') || keys.includes('replicaCount'))) return configsIn(d.config);
    const known = keys.filter((k) => CONFIG_FILE_KEYS.includes(k)).length;
    // a snippet is a gateway config when most of its top-level keys are config keys
    return known > 0 && known * 2 >= keys.length ? [d] : [];
  };

  const checkLine = (rel: string, abs: string, n: number, l: string, hist: boolean, inFence: boolean) => {
    // image tags
    for (const m of l.matchAll(/ghcr\.io\/harrisoncn\/mcp-gateway(?::([A-Za-z0-9._-]+))?(@sha256:[0-9a-f<>A-Za-z._-]+)?/g)) {
      stats.images++;
      const tag = m[1];
      if (!tag || hist) continue;
      if (!okVersion(tag)) add(rel, n, 'image', `stale image tag ":${tag}" (current ${V}; use :${MAJ}, :${MAJ}.${MIN}, :${V}, a digest, or a supported LTS line ${Object.keys(settings.lts).join(' / ')})`);
    }
    if (!hist) {
      for (const m of l.matchAll(/@winstonsayno\/mcp-gateway@([A-Za-z0-9._-]+)/g)) if (!okVersion(m[1])) add(rel, n, 'version', `stale npm version "${m[1]}" (current ${V})`);
      for (const m of l.matchAll(/helm\s+(?:install|upgrade|template|pull)\b[^\n]*--version[ =]([0-9][0-9.]*)/g)) if (m[1] !== V) add(rel, n, 'version', `helm chart --version ${m[1]} (chart version is ${V})`);
      for (const m of l.matchAll(/\blatest (\d+\.\d+\.\d+)\b/g)) if (m[1] !== V && !Object.values(settings.lts).includes(m[1])) add(rel, n, 'version', `"latest ${m[1]}" is stale (current ${V}; LTS ${Object.values(settings.lts).join(', ')})`);
    }
    if (inFence) return;
    // links (outside code)
    for (const m of l.matchAll(/!?\[[^\]]*\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)|<img[^>]+src="([^"]+)"|<a[^>]+href="([^"]+)"/g)) {
      const target = m[1] ?? m[2] ?? m[3];
      if (!target || target.startsWith('mailto:')) continue;
      stats.links++;
      if (/^https?:\/\//.test(target)) {
        if (opts.external) externals.push({ rel, n, url: target });
        continue;
      }
      const [path, anchor] = target.split('#');
      const dest = path ? resolve(dirname(abs), decodeURI(path)) : abs;
      if (path && !existsSync(dest)) {
        add(rel, n, 'link', `broken link "${target}" (no such file)`);
        continue;
      }
      if (anchor && dest.endsWith('.md') && !headingsOf(dest).has(decodeURI(anchor).toLowerCase())) add(rel, n, 'link', `broken anchor "#${anchor}" in ${relative(root, dest)}`);
    }
  };
  const externals: Array<{ rel: string; n: number; url: string }> = [];

  for (const abs of files) {
    stats.files++;
    const rel = relative(root, abs);
    const hist = isHistorical(rel);
    const text = readFileSync(abs, 'utf8');
    if (/\.ya?ml$/.test(abs)) {
      // example config / manifest files
      try {
        for (const d of parseAllDocuments(text)) {
          if (d.errors.length) {
            add(rel, 1, 'syntax', `YAML: ${d.errors[0].message.split('\n')[0]}`);
            continue;
          }
          for (const c of configsIn(d.toJS())) checkConfig(rel, 1, c, hist);
        }
      } catch (e) {
        add(rel, 1, 'syntax', `YAML: ${(e as Error).message.split('\n')[0]}`);
      }
      text.split('\n').forEach((l, i) => checkLine(rel, abs, i + 1, l, hist, true));
      continue;
    }
    const lines = text.split('\n');
    let fence: { lang: string; start: number; body: string[]; skip: boolean; marker: string } | undefined;
    let skipNext = false;
    let html = false;
    lines.forEach((l, i) => {
      const n = i + 1;
      if (!fence) {
        if (/<!--\s*docs-check:\s*skip\s*-->/.test(l)) skipNext = true;
        if (/^\s*<!--/.test(l) && !/-->/.test(l)) html = true;
        if (html) {
          if (/-->/.test(l)) html = false;
          return;
        }
      }
      const fm = /^(\s*)(```+|~~~+)\s*([\w+-]*)/.exec(l);
      if (fm && !fence) {
        fence = { lang: fm[3].toLowerCase(), start: n, body: [], skip: skipNext, marker: fm[2] };
        skipNext = false;
        return;
      }
      if (fence && fm && fm[2].startsWith(fence.marker) && !fm[3]) {
        stats.fences++;
        const f = fence;
        fence = undefined;
        if (f.skip) {
          stats.skipped++;
          return;
        }
        const body = f.body.join('\n');
        const ellipsis = /(^|\s)(\.\.\.|…)(\s|$)|\{\s*(\.\.\.|…)\s*\}|<[^>\n]*>/m.test(body);
        if (f.lang === 'json') {
          try {
            JSON.parse(body);
          } catch (e) {
            if (!ellipsis && !/^\s*\/\//m.test(body)) add(rel, f.start, 'syntax', `JSON: ${(e as Error).message}`);
            else stats.skipped++;
          }
        } else if (['ts', 'typescript', 'js', 'javascript', 'mjs', 'tsx'].includes(f.lang)) {
          try {
            transformSync(body, { loader: f.lang.startsWith('ts') || f.lang === 'typescript' ? (f.lang === 'tsx' ? 'tsx' : 'ts') : 'js', format: 'esm', logLevel: 'silent' });
          } catch (e) {
            if (!ellipsis) add(rel, f.start, 'syntax', `${f.lang}: ${String((e as { errors?: Array<{ text: string }> }).errors?.[0]?.text ?? (e as Error).message).split('\n')[0]}`);
            else stats.skipped++;
          }
        } else if (f.lang === 'yaml' || f.lang === 'yml') {
          let docs: unknown[] = [];
          try {
            docs = parseAllDocuments(body).map((d) => {
              if (d.errors.length) throw d.errors[0];
              return d.toJS();
            });
          } catch (e) {
            if (!ellipsis) add(rel, f.start, 'syntax', `YAML: ${(e as Error).message.split('\n')[0]}`);
            else stats.skipped++;
          }
          for (const d of docs) for (const c of configsIn(d)) checkConfig(rel, f.start, c, hist);
        } else if (['bash', 'sh', 'shell', 'console', 'zsh', ''].includes(f.lang)) {
          f.body.forEach((bl, j) => {
            // `mcp-gateway` in command position only (start of line, after a shell operator, npx, a local bin path)
            const cmd = /(?:^|&&|\|\||[;|(]|\$\()\s*(?:sudo\s+)?(?:npx\s+(?:-y\s+)?(?:@winstonsayno\/)?|\.\/node_modules\/\.bin\/|node\s+dist\/cli\.js\s+|node_modules\/\.bin\/)?mcp-gateway\s+([^#\n]*)/.exec(bl.replace(/^\s*[$>]\s*/, ''));
            if (!cmd || hist) return;
            const tokens = cmd[1].trim().split(/\s+/).filter(Boolean);
            if (!tokens.length) return;
            stats.cli++;
            let i = 0;
            let command = '';
            if (!tokens[0].startsWith('-')) {
              command = tokens[0];
              i = 1;
              if (!cli.has(command)) {
                if (['config', 'plugin', 'pq', 'policy'].includes(command) && tokens[1] && cli.has(tokens[1])) {
                  command = tokens[1];
                  i = 2;
                } else if (/^[a-z][a-z-]*$/.test(command)) {
                  add(rel, f.start + j + 1, 'cli', `unknown command "mcp-gateway ${command}"`);
                  return;
                } else return;
              } else if (['config', 'plugin', 'pq', 'policy'].includes(command) && tokens[1] && cli.has(tokens[1])) {
                command = tokens[1];
                i = 2;
              }
            }
            const known = cli.get(command) ?? new Set();
            for (const t of tokens.slice(i)) {
              if (/^[|;&>]/.test(t)) break;
              const fl = /^(--?[A-Za-z][\w-]*)/.exec(t)?.[1];
              if (!fl) continue;
              if (!known.has(fl) && !cli.get('')!.has(fl)) add(rel, f.start + j + 1, 'cli', `unknown flag "${fl}" for "mcp-gateway${command ? ' ' + command : ''}"`);
            }
          });
        }
        return;
      }
      if (fence) {
        fence.body.push(l);
        checkLine(rel, abs, n, l, hist, true);
        return;
      }
      checkLine(rel, abs, n, l, hist, false);
    });
  }

  // repository-wide version facts
  const chartPath = join(root, 'deploy/helm/mcp-gateway/Chart.yaml');
  if (existsSync(chartPath)) {
    const chart = parseYaml(readFileSync(chartPath, 'utf8')) as { version?: string; appVersion?: string };
    if (chart.version !== V) add('deploy/helm/mcp-gateway/Chart.yaml', 1, 'version', `chart version ${chart.version} != package ${V}`);
    if (String(chart.appVersion) !== V) add('deploy/helm/mcp-gateway/Chart.yaml', 1, 'version', `chart appVersion ${chart.appVersion} != package ${V}`);
  }
  const readme = readFileSync(join(root, 'README.md'), 'utf8');
  const wn = /^## What's New in v(\d+\.\d+)/m.exec(readme);
  if (wn && wn[1] !== `${MAJ}.${MIN}`) add('README.md', readme.slice(0, wn.index).split('\n').length, 'version', `"What's New in v${wn[1]}" but the package is ${V}`);
  const mock = join(root, 'dashboard/demo/mock.js');
  if (existsSync(mock)) {
    const mv = /const VERSION = '([^']*)'/.exec(readFileSync(mock, 'utf8'))?.[1];
    if (mv && mv !== V) add('dashboard/demo/mock.js', 1, 'version', `demo VERSION ${mv} != package ${V}`);
  }
  const lock = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8')) as { version?: string };
  if (lock.version !== V) add('package-lock.json', 1, 'version', `package-lock version ${lock.version} != package ${V}`);

  if (opts.external) {
    const seen = new Map<string, number>();
    for (const e of externals) {
      if (!seen.has(e.url)) {
        try {
          const r = await fetch(e.url, { method: 'HEAD', redirect: 'follow', signal: AbortSignal.timeout(10_000) });
          seen.set(e.url, r.status === 405 || r.status === 403 ? 200 : r.status);
        } catch {
          seen.set(e.url, 0);
        }
      }
      const s = seen.get(e.url)!;
      if (s === 404 || s === 410) add(e.rel, e.n, 'link', `external link ${e.url} answered ${s}`);
    }
  }
  return { findings, stats };
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('docs-check.ts')) {
  const { findings, stats } = await check(ROOT, { external: flag('--external') });
  if (flag('--json')) console.log(JSON.stringify({ findings, stats }, null, 2));
  else {
    for (const f of findings) console.log(`${f.file}:${f.line}: [${f.rule}] ${f.message}`);
    console.log(`docs-check: ${findings.length} finding(s) — ${stats.files} files, ${stats.fences} code blocks (${stats.configs} configs validated against schema v11, ${stats.skipped} skipped), ${stats.cli} CLI invocations, ${stats.links} links, ${stats.images} image references`);
  }
  process.exit(findings.length ? 1 : 0);
}
void extname;
