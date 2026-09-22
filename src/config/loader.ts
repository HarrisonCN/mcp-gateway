/**
 * Configuration loader
 * Supports YAML, JSON, and environment variable overrides
 */

import { readFile } from 'fs/promises';
import { existsSync } from 'fs';
import { resolve } from 'path';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import type { GatewayConfig } from '../utils/types.js';

// ─── Zod Schema ───────────────────────────────────────────────────────────────

const McpServerSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string().optional(),
  transport: z.enum(['stdio', 'sse', 'websocket']),
  command: z.string().optional(),
  args: z.array(z.string()).optional(),
  url: z.string().url().optional(),
  env: z.record(z.string()).optional(),
  tags: z.array(z.string()).optional(),
  enabled: z.boolean().default(true),
  timeout: z.number().positive().default(30000),
  maxConcurrency: z.number().positive().default(10),
});

const GatewayConfigSchema = z.object({
  port: z.number().int().min(1).max(65535).default(4000),
  host: z.string().default('0.0.0.0'),
  auth: z
    .object({
      strategy: z.enum(['none', 'api-key', 'jwt', 'oauth2']).default('none'),
      apiKeys: z.array(z.string()).optional(),
      jwtSecret: z.string().optional(),
    })
    .optional(),
  rateLimit: z
    .object({
      limit: z.number().positive().default(100),
      windowSeconds: z.number().positive().default(60),
      perKey: z.boolean().default(true),
    })
    .optional(),
  monitor: z
    .object({
      prometheus: z.boolean().default(false),
      requestLog: z.boolean().default(true),
      retentionHours: z.number().positive().default(24),
    })
    .optional(),
  servers: z.array(McpServerSchema).default([]),
  corsOrigins: z.array(z.string()).optional(),
  logLevel: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
});

// ─── Loader ───────────────────────────────────────────────────────────────────

const CONFIG_SEARCH_PATHS = [
  'mcp-gateway.yml',
  'mcp-gateway.yaml',
  'mcp-gateway.json',
  '.mcp-gateway.yml',
  '.mcp-gateway.yaml',
];

export async function loadConfig(configPath?: string): Promise<GatewayConfig> {
  let raw: unknown = {};

  if (configPath) {
    raw = await readConfigFile(resolve(configPath));
  } else {
    for (const searchPath of CONFIG_SEARCH_PATHS) {
      if (existsSync(searchPath)) {
        raw = await readConfigFile(resolve(searchPath));
        break;
      }
    }
  }

  // Apply environment variable overrides
  raw = applyEnvOverrides(raw as Record<string, unknown>);

  const result = GatewayConfigSchema.safeParse(raw);
  if (!result.success) {
    throw new Error(
      `Invalid configuration:\n${result.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n')}`
    );
  }

  return result.data as GatewayConfig;
}

async function readConfigFile(filePath: string): Promise<unknown> {
  const content = await readFile(filePath, 'utf-8');
  if (filePath.endsWith('.json')) {
    return JSON.parse(content);
  }
  return parseYaml(content);
}

function applyEnvOverrides(config: Record<string, unknown>): Record<string, unknown> {
  const overrides: Record<string, unknown> = { ...config };

  if (process.env.MCP_GATEWAY_PORT) {
    overrides.port = parseInt(process.env.MCP_GATEWAY_PORT, 10);
  }
  if (process.env.MCP_GATEWAY_HOST) {
    overrides.host = process.env.MCP_GATEWAY_HOST;
  }
  if (process.env.MCP_GATEWAY_LOG_LEVEL) {
    overrides.logLevel = process.env.MCP_GATEWAY_LOG_LEVEL;
  }
  if (process.env.MCP_GATEWAY_API_KEYS) {
    overrides.auth = {
      ...(overrides.auth as Record<string, unknown> ?? {}),
      strategy: 'api-key',
      apiKeys: process.env.MCP_GATEWAY_API_KEYS.split(',').map((k) => k.trim()),
    };
  }

  return overrides;
}

export function generateDefaultConfig(): string {
  return `# mcp-gateway configuration
# Documentation: https://github.com/HarrisonCN/mcp-gateway/docs

port: 4000
host: 0.0.0.0
logLevel: info

# Authentication (optional)
# auth:
#   strategy: api-key
#   apiKeys:
#     - your-secret-key-here

# Rate limiting (optional)
# rateLimit:
#   limit: 100
#   windowSeconds: 60
#   perKey: true

# Monitoring
monitor:
  requestLog: true
  prometheus: false
  retentionHours: 24

# MCP Servers to manage
servers:
  - id: filesystem
    name: Filesystem Server
    description: Access local files and directories
    transport: stdio
    command: npx
    args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"]
    tags: [files, local]
    enabled: true
    timeout: 15000
    maxConcurrency: 10

  - id: github
    name: GitHub Server
    description: Interact with GitHub repositories
    transport: stdio
    command: npx
    args: ["-y", "@modelcontextprotocol/server-github"]
    env:
      GITHUB_PERSONAL_ACCESS_TOKEN: \${GITHUB_TOKEN}
    tags: [github, vcs]
    enabled: true
    timeout: 15000
    maxConcurrency: 10
`;
}
