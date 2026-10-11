#!/usr/bin/env node
/**
 * mcp-gateway CLI
 */

import 'dotenv/config';
import { Command } from 'commander';
import { existsSync } from 'fs';
import { readFile, writeFile } from 'fs/promises';
import { homedir } from 'os';
import { join } from 'path';
import { stringify as stringifyYaml } from 'yaml';
import { loadConfig, generateDefaultConfig, resolveConfigPath } from './config/loader.js';
import { ConfigWatcher } from './config/watcher.js';
import { runPolicyTests } from './policy/tool-policy.js';
import { diffConfigs, formatDiff, type ConfigChange } from './config/diff.js';
import { Gateway } from './gateway/index.js';
import { logger } from './utils/logger.js';
import { VERSION } from './utils/version.js';
import { randomBytes } from 'crypto';
import { hashApiKey } from './auth/middleware.js';
import { securityWarnings } from './security/posture.js';
import { nodeVersionError } from './utils/node-check.js';

// 6.0: Node.js 22+ only.
const nodeErr = nodeVersionError();
if (nodeErr) {
  console.error(nodeErr);
  process.exit(1);
}

const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const;

const program = new Command();

program
  .name('mcp-gateway')
  .description('A lightweight gateway for managing multiple MCP servers')
  .version(VERSION);

// ─── start ────────────────────────────────────────────────────────────────────

program
  .command('start')
  .description('Start the MCP gateway server')
  .option('-c, --config <path>', 'Path to config file')
  .option('-p, --port <number>', 'Override port from config')
  .option('--log-level <level>', 'Log level (debug|info|warn|error)')
  .option('--no-watch', 'Disable config hot reload')
  .option('--insecure', 'Allow starting without auth on a non-loopback address (trusted networks only)')
  .action(async (options) => {
    let gateway: Gateway | undefined;
    let watcher: ConfigWatcher | undefined;
    try {
      const config = await loadConfig(options.config);

      if (options.port !== undefined) {
        const port = Number(options.port);
        if (!Number.isInteger(port) || port < 0 || port > 65535) {
          throw new Error(`Invalid --port "${options.port}"`);
        }
        config.port = port;
      }
      if (options.logLevel) {
        if (!(LOG_LEVELS as readonly string[]).includes(options.logLevel)) {
          throw new Error(`Invalid --log-level "${options.logLevel}" (expected ${LOG_LEVELS.join('|')})`);
        }
        config.logLevel = options.logLevel;
      }
      if (options.insecure) config.security = { ...config.security, insecure: true };

      const fromDisk = resolveConfigPath(options.config) ? () => loadConfig(options.config) : undefined;
      const gw = new Gateway(config, { reloadFromDisk: fromDisk });
      gateway = gw;

      // Graceful shutdown (idempotent; a second signal forces exit)
      let shuttingDown = false;
      const shutdown = (signal: string) => {
        if (shuttingDown) {
          logger.warn(`Received ${signal} again, forcing exit`);
          process.exit(1);
        }
        shuttingDown = true;
        logger.info(`Received ${signal}, shutting down gracefully...`);
        watcher?.stop();
        gw.stop().then(
          () => process.exit(0),
          (err: unknown) => {
            logger.error(`Error during shutdown: ${err instanceof Error ? err.message : String(err)}`);
            process.exit(1);
          },
        );
      };

      process.on('SIGINT', () => shutdown('SIGINT'));
      process.on('SIGTERM', () => shutdown('SIGTERM'));

      await gw.start();

      const configPath = resolveConfigPath(options.config);
      if (configPath) {
        const w = new ConfigWatcher(configPath, logger);
        watcher = w;
        w.on('reload', (next) => {
          // CLI overrides keep precedence over the file
          if (options.logLevel) next.logLevel = options.logLevel;
          if (options.port !== undefined) next.port = config.port;
          if (options.insecure) next.security = { ...next.security, insecure: true };
          gw.reload(next).catch((err: unknown) => {
            logger.error(`Hot reload failed: ${err instanceof Error ? err.message : String(err)}`);
          });
        });
        if (options.watch) w.start();
        // SIGHUP reloads the config file even with --no-watch (Windows has no SIGHUP).
        if (process.platform !== 'win32') {
          process.on('SIGHUP', () => {
            logger.info('Received SIGHUP — reloading configuration');
            void w.reloadNow();
          });
        }
      }
    } catch (err) {
      logger.error(`Failed to start gateway: ${err instanceof Error ? err.message : String(err)}`);
      watcher?.stop();
      await gateway?.stop().catch(() => {});
      process.exit(1);
    }
  });

// ─── init ─────────────────────────────────────────────────────────────────────

program
  .command('init')
  .description('Generate a default configuration file')
  .option('-o, --output <path>', 'Output path', 'mcp-gateway.yml')
  .option('--force', 'Overwrite existing file')
  .action(async (options) => {
    if (existsSync(options.output) && !options.force) {
      logger.error(`File "${options.output}" already exists. Use --force to overwrite.`);
      process.exit(1);
    }
    await writeFile(options.output, generateDefaultConfig(), 'utf-8');
    logger.info(`Created ${options.output}`);
    console.log('\nNext steps:');
    console.log(`  1. Edit ${options.output} to configure your MCP servers`);
    console.log('  2. Run: mcp-gateway start\n');
  });

// ─── desktop (7.6) ────────────────────────────────────────────────────────────

/** Where desktop MCP clients keep their server lists. */
export function desktopClientPaths(home = homedir(), platform = process.platform, env = process.env): Record<string, string> {
  const appData = env.APPDATA ?? join(home, 'AppData', 'Roaming');
  const claude =
    platform === 'darwin' ? join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json')
    : platform === 'win32' ? join(appData, 'Claude', 'claude_desktop_config.json')
    : join(home, '.config', 'Claude', 'claude_desktop_config.json');
  return { claude, cursor: join(home, '.cursor', 'mcp.json'), windsurf: join(home, '.codeium', 'windsurf', 'mcp_config.json'), vscode: join(process.cwd(), '.vscode', 'mcp.json') };
}

program
  .command('desktop')
  .description('Write a desktop profile (loopback, generated key, offline mode) importing the MCP servers of a desktop client')
  .option('--from <client>', 'Import from claude | cursor | windsurf | vscode')
  .option('--import <file>', 'Import from a desktop-client MCP config file')
  .option('-o, --output <path>', 'Output path', 'mcp-gateway.yml')
  .option('-p, --port <port>', 'Port', '4000')
  .option('--force', 'Overwrite an existing file')
  .action(async (options) => {
    const { importDesktopServers, desktopConfig } = await import('./features/offline.js');
    if (existsSync(options.output) && !options.force) {
      logger.error(`File "${options.output}" already exists. Use --force to overwrite.`);
      process.exit(1);
    }
    let file: string | undefined = options.import;
    if (options.from) {
      file = desktopClientPaths()[String(options.from)];
      if (!file) {
        logger.error(`Unknown client "${options.from}" (claude, cursor, windsurf, vscode)`);
        process.exit(1);
      }
    }
    let servers: import('./utils/types.js').McpServerConfig[] = [];
    if (file) {
      if (!existsSync(file)) {
        logger.error(`No MCP config at ${file}`);
        process.exit(1);
      }
      const r = importDesktopServers(JSON.parse(await readFile(file, 'utf8')));
      servers = r.servers;
      console.log(`Imported ${servers.length} server(s) from ${file}${r.skipped.length ? ` (skipped: ${r.skipped.join(', ')})` : ''}`);
    }
    const port = Number(options.port);
    const { config, apiKey } = desktopConfig({ servers, port });
    await writeFile(options.output, `# mcp-gateway desktop profile (generated by \`mcp-gateway desktop\`)\n${stringifyYaml(config)}`, { encoding: 'utf-8', mode: 0o600 });
    console.log(`Created ${options.output}\n\nPoint your desktop client at the gateway instead of the individual servers:\n`);
    console.log(JSON.stringify({ mcpServers: { gateway: { url: `http://127.0.0.1:${port}/mcp`, headers: { Authorization: `Bearer ${apiKey}` } } } }, null, 2));
    console.log(`\nThen run: mcp-gateway start -c ${options.output}\n`);
  });

// ─── validate ─────────────────────────────────────────────────────────────────

program
  .command('validate')
  .description('Validate a configuration file and report security warnings')
  .option('-c, --config <path>', 'Path to config file')
  .option('--strict', 'Exit with code 2 when there are security warnings')
  .action(async (options) => {
    try {
      const config = await loadConfig(options.config);
      console.log(`✓ Configuration is valid`);
      console.log(`  Port: ${config.port}`);
      console.log(`  Servers: ${config.servers.length}`);
      console.log(`  Auth: ${config.auth?.strategy ?? 'none'}`);
      if (config.deprecations?.length) {
        console.log('\nDeprecated:');
        for (const d of config.deprecations) console.log(`  ! (removed in ${d.removedIn}) ${d.message}${(d as { detail?: string }).detail ? ` — ${(d as { detail?: string }).detail}` : ''}`);
      }
      const warnings = securityWarnings(config);
      if (warnings.length > 0) {
        console.log('\nSecurity:');
        for (const w of warnings) console.log(`  ${w.level === 'warn' ? '!' : '-'} ${w.message}`);
        if (options.strict && warnings.some((w) => w.level === 'warn')) process.exit(2);
      }
    } catch (err) {
      logger.error(`Invalid configuration: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
  });

// ─── declarative config: diff / apply ─────────────────────────────────────────

/** Load a config file for sending to a gateway: policy files merged, loader-only fields dropped. */
async function portableFromFile(path: string | undefined): Promise<Record<string, unknown>> {
  const cfg = await loadConfig(path);
  if (cfg.policy) cfg.policy = { ...cfg.policy, files: undefined };
  const { configDir: _d, deprecations: _x, ...rest } = cfg;
  return JSON.parse(JSON.stringify(rest)) as Record<string, unknown>;
}

async function adminCall(url: string, key: string | undefined, method: string, path: string, body?: unknown): Promise<{ status: number; data: Record<string, unknown> }> {
  const res = await fetch(`${url.replace(/\/+$/, '')}/api/v1${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(text) as Record<string, unknown>;
  } catch {
    data = { message: text };
  }
  return { status: res.status, data };
}

const remoteOptions = (cmd: Command) =>
  cmd
    .option('-c, --config <path>', 'Desired config file')
    .option('--url <url>', 'Gateway base URL (default env MCP_GATEWAY_URL or http://localhost:4000)')
    .option('--key <key>', 'Operator API key (default env MCP_GATEWAY_ADMIN_KEY)')
    .option('--json', 'Print JSON');

remoteOptions(
  program
    .command('diff')
    .description('Show what applying a config file would change (against a running gateway, or another file with --against)')
    .option('--against <path>', 'Compare with this config file instead of a running gateway'),
).action(async (options) => {
  try {
    const desired = await portableFromFile(options.config);
    let changes: ConfigChange[];
    if (options.against) {
      changes = diffConfigs(await portableFromFile(options.against), desired);
    } else {
      const r = await adminCall(options.url ?? process.env.MCP_GATEWAY_URL ?? 'http://localhost:4000', options.key ?? process.env.MCP_GATEWAY_ADMIN_KEY, 'POST', '/admin/config/diff', desired);
      if (r.status !== 200) throw new Error(`Gateway answered ${r.status}: ${String(r.data.message ?? r.data.error ?? '')}`);
      changes = r.data.changes as ConfigChange[];
    }
    console.log(options.json ? JSON.stringify({ changes }, null, 2) : formatDiff(changes));
    process.exitCode = changes.length > 0 ? 3 : 0;
  } catch (err) {
    logger.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
});

remoteOptions(
  program
    .command('apply')
    .description('Apply a config file to a running gateway (hot reload over the admin API; needs controlPlane.configApi: true)')
    .option('--dry-run', 'Validate and show the diff without applying'),
).action(async (options) => {
  try {
    const desired = await portableFromFile(options.config);
    const r = await adminCall(
      options.url ?? process.env.MCP_GATEWAY_URL ?? 'http://localhost:4000',
      options.key ?? process.env.MCP_GATEWAY_ADMIN_KEY,
      'PUT',
      `/admin/config${options.dryRun ? '?dryRun=true' : ''}`,
      desired,
    );
    if (r.status !== 200) throw new Error(`Gateway answered ${r.status}: ${String(r.data.message ?? r.data.error ?? '')}`);
    if (options.json) console.log(JSON.stringify(r.data, null, 2));
    else {
      console.log(formatDiff(r.data.changes as ConfigChange[]));
      console.log(r.data.applied ? '\n✓ Applied' : options.dryRun ? '\n(dry run — nothing applied)' : '\nNothing to apply');
      const restart = (r.data.changes as ConfigChange[]).filter((c) => c.restart);
      if (restart.length > 0) console.log(`! ${restart.length} change(s) need a restart: ${restart.map((c) => c.path).join(', ')}`);
    }
  } catch (err) {
    logger.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
});

program
  .command('policy')
  .description('Policy-as-code tools')
  .command('test')
  .description('Run policy tests (policy.tests and the tests in policy.files) against the merged rules')
  .option('-c, --config <path>', 'Path to config file')
  .option('--json', 'Print results as JSON')
  .action(async (options) => {
    try {
      const config = await loadConfig(options.config);
      const results: Array<{ name: string; passed: boolean; expected: string; actual: string }> = runPolicyTests(config.policy);
      // 10.5: features.policyEngine tests (Cedar in-process; OPA is queried when configured)
      const { engineOf, runEngineTests } = await import('./features/policy-engine.js');
      const engine = engineOf(config);
      if (engine?.tests?.length) for (const r of await runEngineTests(engine, engine.tests, { configDir: config.configDir })) results.push({ ...r, name: `[policyEngine] ${r.name}` });
      const failed = results.filter((r) => !r.passed);
      if (options.json) console.log(JSON.stringify({ total: results.length, failed: failed.length, results }, null, 2));
      else {
        console.log(`Policy: ${config.policy?.rules?.length ?? 0} rules, default ${config.policy?.default ?? 'allow'}`);
        for (const r of results) console.log(`  ${r.passed ? '✓' : '✗'} ${r.name}${r.passed ? '' : ` — expected ${r.expected}, got ${r.actual}`}`);
        console.log(results.length === 0 ? 'No policy tests defined.' : `${results.length - failed.length}/${results.length} passed`);
      }
      if (failed.length > 0) process.exit(1);
    } catch (err) {
      logger.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  });

// ─── tenancy (14.2.0) ─────────────────────────────────────────────────────────

program
  .command('tenancy')
  .description('Tenant isolation tools (14.2.0)')
  .command('report')
  .description('Report tenant boundaries: server owners, cross-tenant sharing and grants, shared credentials, global caches (exit 1 on violations)')
  .option('-c, --config <path>', 'Path to config file')
  .option('--json', 'Print the report as JSON')
  .action(async (options) => {
    try {
      const config = await loadConfig(options.config);
      const { tenancyReport, formatTenancyReport } = await import('./auth/isolation.js');
      const report = tenancyReport(config);
      console.log(options.json ? JSON.stringify(report, null, 2) : formatTenancyReport(report));
      if (report.violations > 0) process.exit(1);
    } catch (err) {
      logger.error(err instanceof Error ? err.message : String(err));
      process.exit(2);
    }
  });

// ─── keys ─────────────────────────────────────────────────────────────────────

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString('utf8').replace(/\r?\n$/, '');
}

program
  .command('hash-key')
  .description('Print the sha256:<hex> digest of an API key, for auth.apiKeys (reads stdin when no key is given)')
  .argument('[key]', 'The key (prefer stdin so it stays out of your shell history)')
  .action(async (key?: string) => {
    const value = key ?? (process.stdin.isTTY ? '' : await readStdin());
    if (!value) {
      logger.error('No key given. Usage: echo -n "$KEY" | mcp-gateway hash-key');
      process.exit(1);
    }
    console.log(hashApiKey(value));
  });

program
  .command('gen-key')
  .description('Generate a random API key and print it with its sha256 digest')
  .option('-b, --bytes <n>', 'Random bytes (16-128)', '32')
  .option('--prefix <prefix>', 'Key prefix (helps secret scanners and redaction)', 'mgw_')
  .option('--json', 'Print JSON')
  .action((options) => {
    const bytes = Number(options.bytes);
    if (!Number.isInteger(bytes) || bytes < 16 || bytes > 128) {
      logger.error(`Invalid --bytes "${options.bytes}" (16-128)`);
      process.exit(1);
    }
    const key = `${options.prefix}${randomBytes(bytes).toString('base64url')}`;
    const hash = hashApiKey(key);
    if (options.json) {
      console.log(JSON.stringify({ key, hash }));
      return;
    }
    console.log(`key:  ${key}`);
    console.log(`hash: ${hash}`);
    console.log('\nGive the key to the client; put the hash in auth.apiKeys. The key is not shown again.');
  });

// ─── operator (6.8) ───────────────────────────────────────────────────────────

program
  .command('operator')
  .description('Run the Kubernetes operator: reconcile McpGateway resources (in-cluster service account)')
  .option('-n, --namespace <ns>', 'Only watch this namespace (default: all)')
  .option('--interval <seconds>', 'Reconcile interval in seconds', '15')
  .option('--once', 'Reconcile once and exit (prints the result)')
  .action(async (options) => {
    const { K8sOperator, inClusterApi } = await import('./features/k8s.js');
    let api;
    try {
      api = inClusterApi();
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
    const op = new K8sOperator(api, { namespace: options.namespace, intervalMs: Math.max(1, Number(options.interval) || 15) * 1000 });
    if (options.once) {
      const r = await op.reconcileAll();
      console.log(JSON.stringify(r, null, 2));
      process.exit(r.some((x) => x.error) ? 1 : 0);
    }
    logger.info(`McpGateway operator started (${options.namespace ? `namespace ${options.namespace}` : 'all namespaces'})`);
    op.start();
    const stop = () => {
      op.stop();
      process.exit(0);
    };
    process.on('SIGTERM', stop);
    process.on('SIGINT', stop);
  });

// ─── migrate (3.9) ────────────────────────────────────────────────────────────

program
  .command('migrate')
  .description('Rewrite a config file to schema v11 (or --to 10 / 9 / 8 / 7 / 6 / 5 / 4), keeping comments; prints the changes')
  .option('-c, --config <path>', 'Config file (default: the usual search paths)')
  .option('--to <version>', 'Target schema version (4 – 11)', '11')
  .option('--write', 'Write the file in place (a .bak copy is kept)')
  .option('-o, --output <path>', 'Write the migrated config to this file instead')
  .option('--check', 'Exit with code 3 when the file needs migrating (CI)')
  .action(async (options) => {
    const { readFile } = await import('fs/promises');
    const { migrateConfigText } = await import('./config/migrate.js');
    const path = resolveConfigPath(options.config);
    if (!path) {
      logger.error('No config file found (use -c <path>)');
      process.exit(1);
    }
    try {
      const text = await readFile(path, 'utf8');
      const r = migrateConfigText(text, /\.json$/i.test(path) ? 'json' : 'yaml', Number(options.to));
      if (!r.changed) {
        console.log(`✓ ${path} is already on schema v${options.to}`);
      } else {
        console.log(`${path}: ${r.changes.length} change(s)`);
        for (const c of r.changes) console.log(`  ~ ${c}`);
      }
      for (const n of r.notes) console.log(`  ! ${n}`);
      if (r.changed && options.check) process.exit(3);
      if (!r.changed) return;
      if (options.output) {
        await writeFile(options.output, r.text);
        console.log(`Written to ${options.output}`);
      } else if (options.write) {
        await writeFile(`${path}.bak`, text);
        await writeFile(path, r.text);
        console.log(`Written (backup: ${path}.bak)`);
      } else {
        console.log('\n--- migrated config (use --write to save) ---\n');
        process.stdout.write(r.text);
      }
    } catch (err) {
      logger.error(`Migration failed: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
  });

// ─── config migrate / diff / rollback --to v12 (13.9.0 preview; 14.0.0 writes files) ─────────────────────────────

/** `--to v12` / `12` → 12; anything else is refused (other targets: `mcp-gateway migrate --to <n>`). */
function v12Target(to: string): number {
  const n = Number(String(to).replace(/^v/i, ''));
  if (n !== 12) {
    logger.error(`config migrate / config diff target schema v12 only (got --to ${to}); for v4 – v11 use \`mcp-gateway migrate --to <n>\``);
    process.exit(1);
  }
  return n;
}

async function v12Preview(options: { config?: string; to: string }) {
  const { readFile } = await import('fs/promises');
  const { migrateToV12 } = await import('./config/v12.js');
  v12Target(options.to);
  const path = resolveConfigPath(options.config);
  if (!path) {
    logger.error('No config file found (use -c <path>)');
    process.exit(1);
  }
  const text = await readFile(path, 'utf8');
  return { path, text, r: migrateToV12(text, /\.json$/i.test(path) ? 'json' : 'yaml', { from: `${path} (v11)`, to: `${path} (v12)` }) };
}

function printReport(r: { changes: string[]; report: { errors: string[]; warnings: string[]; manual: string[] } }) {
  console.log('Compatibility report (schema v11 → v12)');
  console.log(`  changes: ${r.changes.length}`);
  for (const c of r.changes) console.log(`    ~ ${c}`);
  for (const e of r.report.errors) console.log(`  ✗ error: ${e}`);
  for (const w of r.report.warnings) console.log(`  ! warning: ${w}`);
  for (const m of r.report.manual) console.log(`  → manual: ${m}`);
}

/** Default output of `config migrate --to v12`: `gw.yml` → `gw.v12.yml` next to it. */
const v12OutputPath = (p: string) => (/\.(ya?ml|json)$/i.test(p) ? p.replace(/\.(ya?ml|json)$/i, '.v12.$1') : `${p}.v12.yml`);
/** Backup written by `config migrate --in-place` and read by `config rollback`. */
const v11BackupPath = (p: string) => `${p}.v11.bak`;

const configCmd = program.command('config').description('Config schema tools: migrate a schema v11 file to schema v12 (14.0), diff, roll back');

configCmd
  .command('migrate')
  .description('Migrate a schema v11 config to schema v12 (comments and layout kept): writes <name>.v12.<ext> (or -o), or rewrites the file with --in-place (backup <file>.v11.bak); --dry-run only prints the v12 config, unified diff and compatibility report')
  .option('-c, --config <path>', 'Config file (default: the usual search paths)')
  .option('--to <version>', 'Target schema (only v12)', 'v12')
  .option('--dry-run', 'Print the result without writing anything')
  .option('-o, --output <path>', 'Write the v12 config to this file (default: <name>.v12.<ext> next to the input)')
  .option('--in-place', 'Rewrite the config file itself, after copying it to <file>.v11.bak (undo: mcp-gateway config rollback)')
  .option('--force', 'Overwrite an existing output file / backup')
  .option('--json', 'Print { to, config, diff, changes, report } as JSON')
  .action(async (options) => {
    try {
      const { path, text, r } = await v12Preview(options);
      const say = (m: string) => { if (!options.json) console.log(m); };
      if (options.json) console.log(JSON.stringify({ file: path, to: 12, ok: r.ok, config: r.config, text: r.text, diff: r.diff, changes: r.changes, report: r.report }, null, 2));
      else printReport(r);
      if (!r.ok) process.exit(1);
      if (!r.changes.length) {
        say(`✓ ${path} is already on schema v12 — nothing to write`);
        return;
      }
      if (options.dryRun) {
        if (!options.json) {
          console.log('\n--- v12 config ---\n');
          process.stdout.write(r.text);
        }
        return;
      }
      // never write a file the gateway would refuse
      const { validateConfig } = await import('./config/loader.js');
      const { parse } = await import('yaml');
      const out = validateConfig(/\.json$/i.test(path) ? JSON.parse(r.text) : parse(r.text));
      if (out.schemaVersion !== 12) throw new Error('the migrated file does not read as schema v12');
      const { resolve } = await import('path');
      const { existsSync } = await import('fs');
      const { copyFile, rename } = await import('fs/promises');
      if (options.inPlace) {
        const bak = v11BackupPath(path);
        if (existsSync(bak) && !options.force) throw new Error(`backup ${bak} already exists (an earlier migration?) — move it away or pass --force`);
        await copyFile(path, bak);
        const tmp = `${path}.tmp-${process.pid}`;
        await writeFile(tmp, r.text);
        await rename(tmp, path);
        say(`Migrated ${path} to schema v12 in place (backup: ${bak}; undo: mcp-gateway config rollback -c ${path})`);
        void text;
        return;
      }
      const target = options.output ?? v12OutputPath(path);
      if (resolve(target) === resolve(path)) throw new Error('refusing to write over the input: use --in-place (it keeps a backup)');
      if (existsSync(target) && !options.force) throw new Error(`${target} already exists — pass --force to overwrite`);
      await writeFile(target, r.text);
      say(`Written to ${target}`);
    } catch (err) {
      logger.error(`Migration failed: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
  });

configCmd
  .command('rollback')
  .description('Undo `config migrate --in-place`: restore <file>.v11.bak over the config file (the v12 file is kept as <file>.v12.bak)')
  .option('-c, --config <path>', 'Config file (default: the usual search paths)')
  .action(async (options) => {
    try {
      const path = resolveConfigPath(options.config);
      if (!path) throw new Error('No config file found (use -c <path>)');
      const bak = v11BackupPath(path);
      const { existsSync } = await import('fs');
      const { copyFile } = await import('fs/promises');
      if (!existsSync(bak)) throw new Error(`no backup ${bak} — nothing to roll back`);
      await copyFile(path, `${path}.v12.bak`);
      await copyFile(bak, path);
      console.log(`Restored ${path} from ${bak} (the v12 file is kept as ${path}.v12.bak). 14.x reads it as schema v11 (migrated in memory); 13.9.x reads it as it is.`);
    } catch (err) {
      logger.error(`Rollback failed: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
  });

configCmd
  .command('diff')
  .description('Unified diff between a schema v11 config and its schema v12 migration (exit 3 when it would change)')
  .option('-c, --config <path>', 'Config file (default: the usual search paths)')
  .option('--to <version>', 'Target schema (only v12)', 'v12')
  .option('--json', 'Print { diff, changes, report } as JSON')
  .action(async (options) => {
    try {
      const { r } = await v12Preview(options);
      if (options.json) console.log(JSON.stringify({ to: 12, ok: r.ok, diff: r.diff, changes: r.changes, report: r.report }, null, 2));
      else if (!r.ok) printReport(r);
      else process.stdout.write(r.diff);
      process.exitCode = !r.ok ? 1 : r.diff ? 3 : 0;
    } catch (err) {
      logger.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  });

// ─── bench (3.9) ──────────────────────────────────────────────────────────────

program
  .command('bench')
  .description('Benchmark an in-process gateway with a local echo server (REST, auth, cache, /mcp)')
  .option('-d, --duration <seconds>', 'Seconds per scenario', '10')
  .option('--concurrency <n>', 'Concurrent clients', '32')
  .option('-s, --scenario <list>', 'Comma-separated: rest,rest-auth,cache,mcp', 'rest,rest-auth,cache,mcp')
  .option('--json', 'Print JSON')
  .action(async (options) => {
    const { runBenchmark, benchMarkdown, BENCH_SCENARIOS } = await import('./bench/index.js');
    const scenarios = String(options.scenario).split(',').map((x: string) => x.trim()).filter(Boolean);
    const bad = scenarios.filter((x: string) => !(BENCH_SCENARIOS as string[]).includes(x));
    const duration = Number(options.duration);
    const concurrency = Number(options.concurrency);
    if (bad.length || !(duration > 0) || !Number.isInteger(concurrency) || concurrency < 1) {
      logger.error(`Invalid options${bad.length ? `: unknown scenario(s) ${bad.join(', ')}` : ''}`);
      process.exit(1);
    }
    logger.setLevel('error');
    const report = await runBenchmark({ durationMs: duration * 1000, concurrency, scenarios: scenarios as never });
    console.log(options.json ? JSON.stringify(report, null, 2) : benchMarkdown(report));
  });

// ─── plugin signing (5.4) ─────────────────────────────────────────────────────

const pluginCmd = program.command('plugin').description('Signed plugins: keygen, sign, verify');
pluginCmd
  .command('keygen')
  .description('Generate an Ed25519 signing key pair (PEM files)')
  .option('-o, --out <prefix>', 'Output prefix (writes <prefix>.key and <prefix>.pub)', 'plugin-signing')
  .action(async (options) => {
    const { generateSigningKey } = await import('./plugins/trust.js');
    const { writeFileSync } = await import('fs');
    const k = generateSigningKey();
    writeFileSync(`${options.out}.key`, k.privateKey, { mode: 0o600 });
    writeFileSync(`${options.out}.pub`, k.publicKey);
    console.log(`Wrote ${options.out}.key (keep secret) and ${options.out}.pub (add to pluginTrust.keys)`);
  });
pluginCmd
  .command('sign <file>')
  .description('Sign a plugin file (writes <file>.sig)')
  .requiredOption('-k, --key <file>', 'Private key PEM')
  .requiredOption('--key-id <id>', 'Key id recorded in the signature (matches pluginTrust.keys[].id)')
  .option('--pq-key <file>', 'Also sign with ML-DSA (hybrid, EXPERIMENTAL): a key from `mcp-gateway pq keygen` (.hybrid.json)')
  .action(async (file: string, options) => {
    const { signArtifact } = await import('./plugins/trust.js');
    const { readFileSync, writeFileSync } = await import('fs');
    let pq: import('./security/pq.js').MlDsaKey | undefined;
    if (options.pqKey) {
      const { parseMlDsaKey } = await import('./security/pq.js');
      const raw = JSON.parse(readFileSync(options.pqKey, 'utf8')) as { mldsa?: unknown };
      pq = parseMlDsaKey(raw.mldsa ?? raw, true) as import('./security/pq.js').MlDsaKey;
    }
    const sig = signArtifact(readFileSync(file), readFileSync(options.key, 'utf8'), options.keyId, pq);
    writeFileSync(`${file}.sig`, JSON.stringify(sig, null, 2) + '\n');
    console.log(`Signed ${file} (sha256 ${sig.sha256}) → ${file}.sig`);
  });
pluginCmd
  .command('verify <file>')
  .description('Verify a plugin file against its .sig and a public key')
  .requiredOption('-p, --pub <file>', 'Public key PEM')
  .requiredOption('--key-id <id>', 'Key id of that public key')
  .option('-s, --sig <file>', 'Signature file (default <file>.sig)')
  .action(async (file: string, options) => {
    const { verifyArtifact } = await import('./plugins/trust.js');
    const { readFileSync } = await import('fs');
    let sig: unknown;
    try { sig = JSON.parse(readFileSync(options.sig ?? `${file}.sig`, 'utf8')); } catch (e) { logger.error(`Cannot read signature: ${(e as Error).message}`); process.exit(1); }
    const r = verifyArtifact(readFileSync(file), sig, [{ id: options.keyId, publicKey: readFileSync(options.pub, 'utf8') }]);
    if (!r.ok) { logger.error(`✗ ${file}: ${r.reason}`); process.exit(1); }
    console.log(`✓ ${file} signed by ${r.keyId}`);
  });

// ─── post-quantum keys (10.8, EXPERIMENTAL) ──────────────────────────────────

const pqCmd = program.command('pq').description('Post-quantum (ML-DSA) hybrid keys — EXPERIMENTAL');
pqCmd
  .command('keygen')
  .description('Generate an Ed25519 + ML-DSA hybrid key (features.pqIdentity.keyFile, plugin sign --pq-key)')
  .option('-o, --out <prefix>', 'Output prefix (writes <prefix>.hybrid.json and <prefix>.pub.json)', 'gateway')
  .option('--alg <alg>', 'ml-dsa-44 | ml-dsa-65 | ml-dsa-87', 'ml-dsa-65')
  .action(async (options) => {
    const { hybridKeygen, ML_DSA_LEVELS, pqBackend } = await import('./security/pq.js');
    if (!ML_DSA_LEVELS.includes(options.alg)) { logger.error(`--alg must be one of ${ML_DSA_LEVELS.join(', ')}`); process.exit(1); }
    const { writeFileSync } = await import('fs');
    const k = hybridKeygen(options.alg);
    writeFileSync(`${options.out}.hybrid.json`, JSON.stringify(k.privateKey, null, 2) + '\n', { mode: 0o600 });
    writeFileSync(`${options.out}.pub.json`, JSON.stringify(k.publicKey, null, 2) + '\n');
    console.log(`Wrote ${options.out}.hybrid.json (secret) and ${options.out}.pub.json (Ed25519 + ${options.alg}). Backend: ${pqBackend().note}`);
  });
pqCmd
  .command('info')
  .description('Show which ML-DSA implementation this runtime uses')
  .action(async () => {
    const { pqBackend } = await import('./security/pq.js');
    const b = pqBackend();
    console.log(`${b.backend}: ${b.note}`);
  });

// ─── conformance (5.1) ────────────────────────────────────────────────────────

program
  .command('conformance <url>')
  .description('Run the MCP conformance suite against a Streamable HTTP endpoint (e.g. http://127.0.0.1:8080/mcp)')
  .option('-H, --header <header...>', 'Extra request header "Name: value" (repeatable)')
  .option('--only <ids>', 'Comma-separated check ids')
  .option('--json', 'Print JSON')
  .action(async (url: string, options) => {
    const { runConformance, formatReport } = await import('./features/conformance.js');
    const headers: Record<string, string> = {};
    for (const h of (options.header ?? []) as string[]) {
      const i = h.indexOf(':');
      if (i > 0) headers[h.slice(0, i).trim()] = h.slice(i + 1).trim();
    }
    const only = options.only ? String(options.only).split(',').map((x: string) => x.trim()).filter(Boolean) : undefined;
    const report = await runConformance(url, { headers, only });
    console.log(options.json ? JSON.stringify(report, null, 2) : formatReport(report));
    process.exit(report.failed ? 1 : 0);
  });

// ─── 14.4.0: durable task runs and the failure queue (DLQ) ─────────────────────

const taskOpts = (cmd: Command) =>
  cmd
    .option('--url <url>', 'Gateway base URL (default env MCP_GATEWAY_URL or http://localhost:4000)')
    .option('--key <key>', 'Operator API key (default env MCP_GATEWAY_ADMIN_KEY)')
    .option('--json', 'Print JSON');
async function taskCall(options: { url?: string; key?: string; json?: boolean }, method: string, path: string, body?: unknown, show?: (d: Record<string, unknown>) => string): Promise<void> {
  try {
    const r = await adminCall(options.url ?? process.env.MCP_GATEWAY_URL ?? 'http://localhost:4000', options.key ?? process.env.MCP_GATEWAY_ADMIN_KEY, method, `/admin/task-graphs${path}`, body);
    if (r.status >= 400) throw new Error(`Gateway answered ${r.status}: ${String(r.data.message ?? r.data.error ?? '')}`);
    console.log(options.json || !show ? JSON.stringify(r.data, null, 2) : show(r.data));
  } catch (err) {
    logger.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}
const tasksCmd = program.command('tasks').description('Durable task runs (14.4): list, inspect, resume, cancel, approve / deny, and the failure queue (DLQ)');
taskOpts(tasksCmd.command('runs').description('List task runs').option('--status <status>', 'Only runs in this status')).action((o) =>
  taskCall(o, 'GET', `/runs${o.status ? `?status=${encodeURIComponent(o.status)}` : ''}`, undefined, (d) =>
    ((d.runs as Array<Record<string, unknown>>) ?? []).map((r) => `${r.id}  ${String(r.graph).padEnd(16)} ${String(r.status).padEnd(18)} ${r.error ?? ''}`).join('\n') || '(no runs)'),
);
taskOpts(tasksCmd.command('show <runId>').description('Show one run (nodes, audit trail)')).action((id, o) => taskCall(o, 'GET', `/runs/${encodeURIComponent(id)}`));
taskOpts(tasksCmd.command('resume <runId>').description('Resume a failed / interrupted / cancelled run')).action((id, o) => taskCall(o, 'POST', `/runs/${encodeURIComponent(id)}/resume`, {}));
taskOpts(tasksCmd.command('cancel <runId>').description('Cancel a run (its compensations run)')).action((id, o) => taskCall(o, 'POST', `/runs/${encodeURIComponent(id)}/cancel`, {}));
taskOpts(tasksCmd.command('approve <runId>').description('Approve an approval-gated node (operator override)').option('--node <id>', 'Node id (when several wait)').option('--reason <text>', 'Reason (audited)')).action((id, o) =>
  taskCall(o, 'POST', `/runs/${encodeURIComponent(id)}/approve`, { node: o.node, reason: o.reason }),
);
taskOpts(tasksCmd.command('deny <runId>').description('Deny an approval-gated node (operator override; the run compensates)').option('--node <id>', 'Node id (when several wait)').option('--reason <text>', 'Reason (audited)')).action((id, o) =>
  taskCall(o, 'POST', `/runs/${encodeURIComponent(id)}/deny`, { node: o.node, reason: o.reason }),
);
const dlqCmd = tasksCmd.command('dlq').description('Failure queue: list, show, replay, discard');
taskOpts(dlqCmd.command('list').description('List DLQ entries').option('--status <status>', 'pending | replaying | exhausted | replayed | discarded')).action((o) =>
  taskCall(o, 'GET', `/dlq${o.status ? `?status=${encodeURIComponent(o.status)}` : ''}`, undefined, (d) =>
    ((d.entries as Array<Record<string, unknown>>) ?? []).map((e) => `${e.id}  run ${e.runId}  ${String(e.status).padEnd(10)} retries ${e.retries}/${e.maxRetries}  ${e.reason}`).join('\n') || '(empty)'),
);
taskOpts(dlqCmd.command('show <id>').description('Show one DLQ entry with its run')).action((id, o) => taskCall({ ...o, json: true }, 'GET', `/dlq/${encodeURIComponent(id)}`));
taskOpts(dlqCmd.command('replay <id>').description('Re-run the parked run').option('--force', 'Also execute nodes whose outcome is unknown (they may have run upstream)')).action((id, o) =>
  taskCall(o, 'POST', `/dlq/${encodeURIComponent(id)}/replay`, { force: !!o.force }, (d) => `replaying run ${d.runId}`),
);
taskOpts(dlqCmd.command('discard <id>').description('Give up on the run (its compensations run unless --no-compensate)').option('--no-compensate', 'Do not run compensations')).action((id, o) =>
  taskCall(o, 'POST', `/dlq/${encodeURIComponent(id)}/discard`, { compensate: o.compensate !== false, wait: true }, (d) => `discarded ${d.id}${d.run ? ` (run ${(d.run as { status: string }).status})` : ''}`),
);

// ─── 14.5.0: multi-region consistency ─────────────────────────────────────────

/** Human-readable `regions report`. */
export function formatRegionsReport(d: Record<string, unknown>): string {
  const peers = (d.peers ?? []) as Array<Record<string, unknown>>;
  const ms = (v: unknown) => (typeof v === 'number' ? `${v} ms` : '—');
  const lines = [
    `region ${String(d.self)} — ${d.fresh ? 'fresh' : 'NOT FRESH'} (max staleness ${ms(d.maxStalenessMs)}, on stale: ${String(d.onStale)}, max clock skew ${ms(d.maxClockSkewMs)})`,
    `replicated:   ${((d.boundaries as { replicated?: string[] })?.replicated ?? []).join(', ')}`,
    `region-local: ${((d.boundaries as { regionLocal?: string[] })?.regionLocal ?? []).join(', ')}`,
    '',
    'peer            status   fresh  lag        skew       clock     policy',
  ];
  for (const p of peers)
    lines.push(
      `${String(p.id).padEnd(15)} ${String(p.status).padEnd(8)} ${(p.fresh ? 'yes' : 'NO').padEnd(6)} ${ms(p.lagMs).padEnd(10)} ${ms(p.skewMs).padEnd(10)} ${String(p.clockSkew).padEnd(9)} ${p.policyDrift ? 'DRIFT' : 'same'}${p.lastError ? `  (${String(p.lastError)})` : ''}`,
    );
  if (!peers.length) lines.push('(no peers)');
  const rej = (d.rejected ?? {}) as Record<string, number>;
  const den = (d.denied ?? {}) as Record<string, number>;
  lines.push('', `revocations ${String(d.revocations ?? 0)} · kv keys ${String(d.keys ?? 0)} · conflicts ${String(d.conflicts ?? 0)} · rejected entries ${Object.entries(rej).map(([k, v]) => `${k} ${v}`).join(', ')} · denied calls stale ${den.stale ?? 0}, revoked ${den.revoked ?? 0}`);
  return lines.join('\n');
}
async function regionsCall(options: { url?: string; key?: string; json?: boolean }, method: string, path: string, body?: unknown, show?: (d: Record<string, unknown>) => string, okStatus: number[] = []): Promise<void> {
  try {
    const r = await adminCall(options.url ?? process.env.MCP_GATEWAY_URL ?? 'http://localhost:4000', options.key ?? process.env.MCP_GATEWAY_ADMIN_KEY, method, `/admin/regions${path}`, body);
    if (r.status >= 400 && !okStatus.includes(r.status)) throw new Error(`Gateway answered ${r.status}: ${String(r.data.message ?? r.data.error ?? '')}`);
    console.log(options.json || !show ? JSON.stringify(r.data, null, 2) : show(r.data));
    if (r.status >= 400) process.exit(2);
  } catch (err) {
    logger.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}
const regionsCmd = program.command('regions').description('Multi-region consistency (14.5): report, health, replicated revocations');
taskOpts(regionsCmd.command('report').description('Consistency report: boundaries, freshness and lag per peer, clock skew, conflicts, policy drift')).action((o) =>
  regionsCall(o, 'GET', '/report', undefined, formatRegionsReport),
);
taskOpts(regionsCmd.command('health').description('Exit 0 when this region is fresh, 2 when it is not')).action((o) =>
  regionsCall(o, 'GET', '/health', undefined, (d) => `region ${String(d.region)}: ${d.fresh ? 'fresh' : `NOT fresh (stale peers: ${((d.stale ?? []) as string[]).join(', ')})`}`, [503]),
);
taskOpts(regionsCmd.command('revoke <clientId>').description('Revoke a client id in every region (replicated; cannot be undone)').option('--reason <text>', 'Reason (replicated)')).action((id, o) =>
  regionsCall(o, 'POST', '/revocations', { clientId: id, ...(o.reason ? { reason: o.reason } : {}) }, (d) => `revoked ${String(d.clientId)} (region ${String(d.region)})`),
);

// ─── 14.6.0: edge autonomy ────────────────────────────────────────────────────

/** Human-readable `edge report`. */
export function formatEdgeReport(d: Record<string, unknown>): string {
  const q = (d.queue ?? {}) as Record<string, unknown>;
  const seal = (d.seal ?? {}) as Record<string, unknown>;
  const rec = (d.reconcile ?? {}) as Record<string, unknown>;
  const last = rec.last as { at?: string; result?: Record<string, unknown> } | null | undefined;
  const den = (d.denied ?? {}) as Record<string, number>;
  const lines = [
    `edge autonomy — high-risk offline: ${String(d.highRisk)} · persisted: ${d.persisted ? 'yes' : 'no'} · seal: ${seal.ok === false ? `FAILED (${String(seal.error)})` : String(seal.source ?? 'n/a')}`,
    `queue: queued ${String(q.queued ?? 0)} · review ${String(q.review ?? 0)} · conflicts ${String(q.conflict ?? 0)} · rejected ${String(q.rejected ?? 0)} · applied ${String(q.applied ?? 0)} (max ${String(q.maxItems)}, ttl ${String(q.ttlSeconds)} s, on expiry ${String(q.onExpiry)}, oldest ${String(q.oldestAgeSeconds ?? 0)} s)`,
    `denied offline: low ${den.low ?? 0}, medium ${den.medium ?? 0}, high ${den.high ?? 0}, critical ${den.critical ?? 0}`,
    `reconcile: epoch ${String(rec.epoch ?? 0)} · outcome unknown ${String(rec.outcomeUnknown ?? 0)}${last ? ` · last ${String(last.at)}: ${Object.entries(last.result ?? {}).filter(([, v]) => typeof v === 'number' && v > 0).map(([k, v]) => `${k} ${String(v)}`).join(', ') || 'nothing to do'}` : ''}`,
    '',
    'server          connectivity',
  ];
  for (const s of (d.servers ?? []) as Array<{ id: string; disconnected: string | null }>) lines.push(`${s.id.padEnd(15)} ${s.disconnected ? `DISCONNECTED (${s.disconnected})` : 'connected'}`);
  return lines.join('\n');
}
async function edgeCall(options: { url?: string; key?: string; json?: boolean }, method: string, path: string, body?: unknown, show?: (d: Record<string, unknown>) => string): Promise<void> {
  try {
    const r = await adminCall(options.url ?? process.env.MCP_GATEWAY_URL ?? 'http://localhost:4000', options.key ?? process.env.MCP_GATEWAY_ADMIN_KEY, method, `/admin/edge-autonomy${path}`, body);
    if (r.status >= 400) throw new Error(`Gateway answered ${r.status}: ${String(r.data.message ?? r.data.error ?? '')}`);
    console.log(options.json || !show ? JSON.stringify(r.data, null, 2) : show(r.data));
  } catch (err) {
    logger.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}
const edgeCmd = program.command('edge').description('Edge autonomy (14.6): offline report, queue, reconcile');
taskOpts(edgeCmd.command('report').description('Offline boundaries, queue (expiry, review), reconcile state, seal, connectivity per server')).action((o) =>
  edgeCall(o, 'GET', '/report', undefined, formatEdgeReport),
);
taskOpts(edgeCmd.command('queue').description('List queued calls').option('--status <status>', 'queued | review | conflict | rejected | applied')).action((o) =>
  edgeCall(o, 'GET', `/outbox${o.status ? `?status=${encodeURIComponent(o.status)}` : ''}`, undefined, (d) => {
    const es = (d.entries ?? []) as Array<Record<string, unknown>>;
    if (!es.length) return '(empty)';
    return es.map((e) => `${String(e.id)}  ${String(e.status).padEnd(8)} ${String(e.serverId)}/${String(e.tool)}  client ${String(e.clientId ?? '—')}  risk ${String(e.risk ?? '—')}  queued ${String(e.at)}${e.expiresAt ? `  expires ${String(e.expiresAt)}` : ''}${e.reviewReason ? `  (${String(e.reviewReason)})` : ''}`).join('\n');
  }),
);
taskOpts(edgeCmd.command('reconcile').description('Replay queued calls whose server is reachable again (fenced, in order, revocations checked)')).action((o) =>
  edgeCall(o, 'POST', '/reconcile', {}, (d) => {
    const n = (k: string) => `${k} ${String(d[k] ?? 0)}`;
    return `${d.busy ? 'another reconcile holds the lease — ' : ''}${['applied', 'pending', 'held', 'failed', 'conflicts', 'review', 'rejected', 'expired', 'deduplicated'].map(n).join(' · ')}${d.fenced ? ' · FENCED (superseded)' : ''}${d.waiting ? `\nwaiting: ${String(d.waiting)}` : ''}`;
  }),
);

// ─── gitops (14.7) ────────────────────────────────────────────────────────────

const gitopsCmd = program.command('gitops').description('GitOps (14.7): render config directories, env diffs, signed releases, plan / apply / status');
const gitopsDir = (cmd: Command) => cmd.requiredOption('-d, --dir <path>', 'Config directory (base.yml + environments/<env>.yml)').requiredOption('-e, --env <name>', 'Environment');
const gitopsFail = (err: unknown): never => {
  const e = err as { issues?: string[] };
  logger.error(err instanceof Error ? err.message : String(err));
  void e;
  process.exit(1);
};
const gitopsRemote = (o: { url?: string; key?: string }) => ({ url: o.url ?? process.env.MCP_GATEWAY_URL ?? 'http://localhost:4000', key: o.key ?? process.env.MCP_GATEWAY_ADMIN_KEY });
async function readJsonFile(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, 'utf8'));
}
async function readCalls(path: string): Promise<unknown[]> {
  const text = await readFile(path, 'utf8');
  const t = text.trim();
  if (t.startsWith('[')) return JSON.parse(t) as unknown[];
  return t.split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
}
const verifyLine = (v: Record<string, unknown> | null | undefined): string => {
  if (!v) return 'manifest: none (unsigned bundle)';
  const ok = v.ok === true;
  return `${ok ? '✓' : '✗'} release ${String(v.gitSha)} for ${String(v.env)}: author ${String(v.author ?? '?')}, ${String(v.approvals)}/${String(v.required)} approvals${(v.approvers as string[] | undefined)?.length ? ` (${(v.approvers as string[]).join(', ')})` : ''}${(v.reasons as string[] | undefined)?.length ? `\n  ${(v.reasons as string[]).join('\n  ')}` : ''}`;
};

gitopsDir(gitopsCmd.command('render').description('Render a config directory for one environment into a release bundle (JSON)'))
  .option('-o, --out <file>', 'Write the bundle to a file')
  .option('--json', 'Print the bundle (default when no --out)')
  .action(async (o) => {
    try {
      const { renderConfigDir } = await import('./config/gitops.js');
      const b = await renderConfigDir(o.dir, o.env);
      if (o.out) {
        await writeFile(o.out, JSON.stringify(b, null, 2) + '\n');
        console.log(o.json ? JSON.stringify(b, null, 2) : `✓ ${o.env}: ${b.configHash} (${b.files.length} files) → ${o.out}`);
      } else console.log(JSON.stringify(b, null, 2));
    } catch (err) {
      gitopsFail(err);
    }
  });

taskOpts(
  gitopsDir(gitopsCmd.command('diff').description('What differs: <env> → --against-env <other>, or the running gateway → <env> (exit 3 when there are changes)')).option('--against-env <name>', 'Compare two environments of the directory (no gateway needed)'),
).action(async (o) => {
  try {
    const { renderConfigDir, diffEnvironments } = await import('./config/gitops.js');
    const b = await renderConfigDir(o.dir, o.env);
    let changes: ConfigChange[];
    if (o.againstEnv) changes = diffEnvironments(b, await renderConfigDir(o.dir, o.againstEnv));
    else {
      const { url, key } = gitopsRemote(o);
      const r = await adminCall(url, key, 'POST', '/admin/config/diff', b.config);
      if (r.status !== 200) throw new Error(`Gateway answered ${r.status}: ${String(r.data.message ?? r.data.error ?? '')}`);
      changes = r.data.changes as ConfigChange[];
    }
    console.log(o.json ? JSON.stringify({ from: o.againstEnv ? o.env : 'live', to: o.againstEnv ?? o.env, changes }, null, 2) : formatDiff(changes));
    process.exitCode = changes.length ? 3 : 0;
  } catch (err) {
    gitopsFail(err);
  }
});

taskOpts(
  gitopsDir(gitopsCmd.command('plan').description('Review a release against the running gateway: diff, manifest verification, policy simulation (exit 3 when there are changes)'))
    .option('--manifest <file>', 'Release manifest (mcp-gateway gitops sign)')
    .option('--calls <file>', 'Calls to simulate (JSON array or JSON lines of { clientId?, serverId, tool, args? }); default: recorded calls'),
).action(async (o) => {
  try {
    const { renderConfigDir } = await import('./config/gitops.js');
    const b = await renderConfigDir(o.dir, o.env);
    const body: Record<string, unknown> = { bundle: b };
    if (o.manifest) body.manifest = await readJsonFile(o.manifest);
    if (o.calls) body.calls = await readCalls(o.calls);
    const { url, key } = gitopsRemote(o);
    const r = await adminCall(url, key, 'POST', '/admin/gitops/plan', body);
    if (r.status !== 200) throw new Error(`Gateway answered ${r.status}: ${String(r.data.message ?? r.data.error ?? '')}`);
    const d = r.data;
    const changes = d.changes as ConfigChange[];
    if (o.json) console.log(JSON.stringify(d, null, 2));
    else {
      const sim = d.simulation as { source: string; calls: number; changed: number; transitions: Record<string, number>; changes: Array<{ call: { clientId?: string; serverId: string; tool: string }; explanation: string }> };
      const lines = [
        `Environment ${String(d.environment)}${d.enforce ? ' (enforced)' : ''} — bundle ${String(d.configHash)}`,
        '',
        formatDiff(changes),
        '',
        verifyLine(d.verification as Record<string, unknown> | null),
        d.wouldApply ? '→ would be applied' : `→ would be REFUSED: ${String(d.refusal)}`,
        '',
        `Policy simulation (${sim.source}, ${sim.calls} calls): ${sim.changed} decision(s) change${Object.keys(sim.transitions).length ? ` — ${Object.entries(sim.transitions).map(([k, v]) => `${k} ${v}`).join(', ')}` : ''}`,
        ...sim.changes.slice(0, 50).map((c) => `  ${c.call.clientId ?? 'anonymous'} → ${c.call.serverId}/${c.call.tool}: ${c.explanation}`),
      ];
      console.log(lines.join('\n'));
    }
    process.exitCode = changes.length ? 3 : 0;
  } catch (err) {
    gitopsFail(err);
  }
});

taskOpts(
  gitopsDir(gitopsCmd.command('apply').description('Apply a release to the running gateway (refused when enforcement is on and the release is unsigned or not approved)'))
    .option('--manifest <file>', 'Release manifest (mcp-gateway gitops sign / approve)')
    .option('--dry-run', 'Verify and show the diff without applying'),
).action(async (o) => {
  try {
    const { renderConfigDir } = await import('./config/gitops.js');
    const b = await renderConfigDir(o.dir, o.env);
    const body: Record<string, unknown> = { bundle: b, ...(o.dryRun ? { dryRun: true } : {}) };
    if (o.manifest) body.manifest = await readJsonFile(o.manifest);
    const { url, key } = gitopsRemote(o);
    const r = await adminCall(url, key, 'POST', '/admin/gitops/apply', body);
    if (r.status === 403) throw new Error(`Refused: ${String(r.data.reason ?? r.data.message ?? '')}`);
    if (r.status !== 200) throw new Error(`Gateway answered ${r.status}: ${String(r.data.message ?? r.data.error ?? '')}`);
    const d = r.data;
    if (o.json) console.log(JSON.stringify(d, null, 2));
    else {
      console.log(formatDiff(d.changes as ConfigChange[]));
      const rel = d.release as { signed?: boolean; gitSha?: string; author?: string; approvers?: string[] } | undefined;
      if (d.dryRun) console.log('\n(dry run — nothing applied)');
      else console.log(rel?.signed ? `\n✓ Applied release ${String(rel.gitSha)} (author ${String(rel.author)}; approved by ${rel.approvers?.join(', ') || 'nobody — none required'})` : '\n✓ Applied unsigned bundle (enforcement is off)');
    }
  } catch (err) {
    gitopsFail(err);
  }
});

taskOpts(gitopsCmd.command('status').description('Applied release, enforcement and drift (exit 2 when the running config drifted from the release)')).action(async (o) => {
  try {
    const { url, key } = gitopsRemote(o);
    const r = await adminCall(url, key, 'GET', '/admin/gitops/status');
    if (r.status !== 200) throw new Error(`Gateway answered ${r.status}: ${String(r.data.message ?? r.data.error ?? '')}`);
    const d = r.data as { configured: boolean; environment?: string; enforce?: boolean; release?: Record<string, unknown> | null; drift?: { drifted: boolean; changes: ConfigChange[] } };
    if (o.json) console.log(JSON.stringify(d, null, 2));
    else if (!d.configured) console.log('GitOps is not configured (controlPlane.gitops)');
    else {
      const rel = d.release;
      console.log(`Environment ${String(d.environment)} — enforcement ${d.enforce ? 'ON' : 'off'}`);
      console.log(rel ? `Release ${rel.signed ? String(rel.gitSha) : '(unsigned)'}${rel.author ? ` by ${String(rel.author)}` : ''}${(rel.approvers as string[] | undefined)?.length ? `, approved by ${(rel.approvers as string[]).join(', ')}` : ''}, applied ${String(rel.appliedAt)}` : 'No release applied yet');
      if (rel) console.log(d.drift?.drifted ? `DRIFT — the running config differs from the release:\n${formatDiff(d.drift.changes)}` : '✓ in sync with the release');
    }
    process.exitCode = d.drift?.drifted ? 2 : 0;
  } catch (err) {
    gitopsFail(err);
  }
});

gitopsCmd
  .command('keygen')
  .description('Create an ed25519 release signing key: <out>.key (private, 0600) and <out>.pub')
  .requiredOption('--out <prefix>', 'Path prefix for the key files')
  .option('--json', 'Print JSON')
  .action(async (o) => {
    try {
      const { generateSigningKey } = await import('./config/gitops.js');
      const k = generateSigningKey();
      if (existsSync(`${o.out}.key`)) throw new Error(`${o.out}.key exists — not overwritten`);
      await writeFile(`${o.out}.key`, k.privateKeyPem, { mode: 0o600 });
      await writeFile(`${o.out}.pub`, k.publicKey + '\n');
      const out = { publicKey: k.publicKey, keyId: k.keyId, privateKeyFile: `${o.out}.key`, publicKeyFile: `${o.out}.pub` };
      console.log(o.json ? JSON.stringify(out, null, 2) : `✓ ${out.privateKeyFile} (keep it secret) / ${out.publicKeyFile}\n  trustedKeys entry: { id: <key id>, name: <who>, publicKey: "${k.publicKey}" }`);
    } catch (err) {
      gitopsFail(err);
    }
  });

gitopsDir(gitopsCmd.command('sign').description('Create a release manifest for <env>, signed by its author'))
  .requiredOption('--key <file>', 'Author private key (PEM)')
  .requiredOption('--key-id <id>', 'Key id as listed in trustedKeys')
  .requiredOption('--author <name>', 'Author (the trusted name of the key)')
  .option('--git-sha <sha>', 'Commit (default: $GITHUB_SHA, else git rev-parse HEAD in the directory)')
  .option('--expires-in <hours>', 'Manifest expiry in hours')
  .requiredOption('-o, --out <file>', 'Manifest file')
  .action(async (o) => {
    try {
      const { renderConfigDir, createReleaseManifest } = await import('./config/gitops.js');
      const b = await renderConfigDir(o.dir, o.env);
      let sha: string | undefined = o.gitSha ?? process.env.GITHUB_SHA;
      if (!sha) {
        const { execFileSync } = await import('child_process');
        try {
          sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: o.dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
        } catch {
          throw new Error('no --git-sha and the directory is not in a git checkout');
        }
      }
      const hours = o.expiresIn !== undefined ? Number(o.expiresIn) : undefined;
      if (hours !== undefined && !(hours > 0)) throw new Error('--expires-in must be a positive number of hours');
      const m = createReleaseManifest({ bundle: b, gitSha: sha, author: o.author, keyId: o.keyId, privateKeyPem: await readFile(o.key, 'utf8'), ...(hours ? { expiresAt: new Date(Date.now() + hours * 3_600_000).toISOString() } : {}) });
      await writeFile(o.out, JSON.stringify(m, null, 2) + '\n');
      console.log(`✓ release ${sha} for ${o.env} (${m.configHash}) signed by ${o.author} → ${o.out}`);
    } catch (err) {
      gitopsFail(err);
    }
  });

gitopsCmd
  .command('approve <manifest>')
  .description('Add your approval (ed25519 signature) to a release manifest')
  .requiredOption('--key <file>', 'Approver private key (PEM)')
  .requiredOption('--key-id <id>', 'Key id as listed in trustedKeys')
  .requiredOption('--by <name>', 'Approver (the trusted name of the key)')
  .option('-o, --out <file>', 'Write here instead of updating the manifest in place')
  .action(async (file, o) => {
    try {
      const { approveRelease } = await import('./config/gitops.js');
      const m = approveRelease((await readJsonFile(file)) as never, { keyId: o.keyId, privateKeyPem: await readFile(o.key, 'utf8'), by: o.by });
      await writeFile(o.out ?? file, JSON.stringify(m, null, 2) + '\n');
      console.log(`✓ approved by ${o.by} (${m.approvals.length} approval(s) on the manifest) → ${o.out ?? file}`);
    } catch (err) {
      gitopsFail(err);
    }
  });

gitopsDir(gitopsCmd.command('verify <manifest>').description('Verify a release manifest for <env> against a trust config (exit 1 when it would be refused)'))
  .requiredOption('--trust <file>', 'Gateway config (YAML / JSON) whose controlPlane.gitops lists the trusted keys')
  .option('--json', 'Print JSON')
  .action(async (file, o) => {
    try {
      const { renderConfigDir, verifyRelease, GitopsSchema } = await import('./config/gitops.js');
      const text = await readFile(o.trust, 'utf8');
      const raw = (o.trust.endsWith('.json') ? JSON.parse(text) : (await import('yaml')).parse(text)) as { controlPlane?: { gitops?: unknown } };
      if (!raw?.controlPlane?.gitops) throw new Error(`${o.trust} has no controlPlane.gitops`);
      const trust = GitopsSchema.parse(raw.controlPlane.gitops);
      const v = verifyRelease((await readJsonFile(file)) as never, await renderConfigDir(o.dir, o.env), trust);
      console.log(o.json ? JSON.stringify(v, null, 2) : verifyLine(v as unknown as Record<string, unknown>));
      process.exitCode = v.ok ? 0 : 1;
    } catch (err) {
      gitopsFail(err);
    }
  });

program.parse(process.argv);

if (!process.argv.slice(2).length) {
  program.outputHelp();
}
