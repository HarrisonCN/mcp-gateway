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
  .description('Rewrite a config file to schema v10 (or --to 9 / 8 / 7 / 6 / 5 / 4), keeping comments; prints the changes')
  .option('-c, --config <path>', 'Config file (default: the usual search paths)')
  .option('--to <version>', 'Target schema version (4, 5, 6, 7, 8, 9 or 10)', '10')
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
  .action(async (file: string, options) => {
    const { signArtifact } = await import('./plugins/trust.js');
    const { readFileSync, writeFileSync } = await import('fs');
    const sig = signArtifact(readFileSync(file), readFileSync(options.key, 'utf8'), options.keyId);
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

program.parse(process.argv);

if (!process.argv.slice(2).length) {
  program.outputHelp();
}
