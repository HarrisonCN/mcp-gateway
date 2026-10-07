#!/usr/bin/env node
/**
 * mcp-gateway CLI
 */

import 'dotenv/config';
import { Command } from 'commander';
import { existsSync } from 'fs';
import { writeFile } from 'fs/promises';
import { loadConfig, generateDefaultConfig, resolveConfigPath } from './config/loader.js';
import { ConfigWatcher } from './config/watcher.js';
import { Gateway } from './gateway/index.js';
import { logger } from './utils/logger.js';
import { VERSION } from './utils/version.js';

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

      const gw = new Gateway(config);
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
      if (options.watch && configPath) {
        const w = new ConfigWatcher(configPath, logger);
        watcher = w;
        w.on('reload', (next) => {
          // CLI overrides keep precedence over the file
          if (options.logLevel) next.logLevel = options.logLevel;
          gw.reload(next).catch((err: unknown) => {
            logger.error(`Hot reload failed: ${err instanceof Error ? err.message : String(err)}`);
          });
        });
        w.start();
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

// ─── validate ─────────────────────────────────────────────────────────────────

program
  .command('validate')
  .description('Validate a configuration file')
  .option('-c, --config <path>', 'Path to config file')
  .action(async (options) => {
    try {
      const config = await loadConfig(options.config);
      console.log(`✓ Configuration is valid`);
      console.log(`  Port: ${config.port}`);
      console.log(`  Servers: ${config.servers.length}`);
      console.log(`  Auth: ${config.auth?.strategy ?? 'none'}`);
    } catch (err) {
      logger.error(`Invalid configuration: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
  });

program.parse(process.argv);

if (!process.argv.slice(2).length) {
  program.outputHelp();
}
