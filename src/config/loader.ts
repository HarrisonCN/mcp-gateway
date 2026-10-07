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
import { expandEnv } from '../transport/channel.js';

// ─── Zod Schema ───────────────────────────────────────────────────────────────

const ReconnectSchema = z.object({
  enabled: z.boolean().optional(),
  initialDelayMs: z.number().int().positive().optional(),
  maxDelayMs: z.number().int().positive().optional(),
  multiplier: z.number().min(1).optional(),
  jitter: z.number().min(0).max(1).optional(),
  maxAttempts: z.number().int().min(0).optional(),
});

const URL_PROTOCOLS: Record<string, string[]> = {
  sse: ['http:', 'https:'],
  'streamable-http': ['http:', 'https:'],
  websocket: ['ws:', 'wss:'],
};

function safeProtocol(url: string): string {
  try {
    return new URL(url).protocol;
  } catch {
    return '';
  }
}

const ToolPatternList = z.array(z.string().min(1, 'patterns must be non-empty'));

const ToolFilterSchema = z
  .object({
    allow: ToolPatternList.optional(),
    deny: ToolPatternList.optional(),
  })
  .strict();

const McpServerSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string().optional(),
  transport: z.enum(['stdio', 'sse', 'websocket', 'streamable-http']),
  command: z.string().optional(),
  args: z.array(z.string()).optional(),
  url: z.string().url().optional(),
  env: z.record(z.string()).optional(),
  headers: z.record(z.string()).optional(),
  subprotocol: z.string().optional(),
  reconnect: ReconnectSchema.optional(),
  tags: z.array(z.string()).optional(),
  enabled: z.boolean().default(true),
  timeout: z.number().positive().default(30000),
  maxConcurrency: z.number().int().positive().default(10),
  tools: ToolFilterSchema.optional(),
}).superRefine((s, ctx) => {
  if (s.transport === 'stdio' && !s.command) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['command'], message: 'required for stdio transport' });
  }
  const protocols = URL_PROTOCOLS[s.transport];
  if (protocols) {
    if (!s.url) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['url'], message: `required for ${s.transport} transport` });
    } else if (!protocols.includes(safeProtocol(s.url))) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['url'],
        message: `${s.transport} transport needs a ${protocols.map((p) => p.replace(':', '://')).join(' or ')} URL`,
      });
    }
  }
});

const PatternList = z.array(z.string().min(1, 'patterns must be non-empty'));

const RateLimitSchema = z.object({
  limit: z.number().int().positive().default(100),
  windowSeconds: z.number().positive().default(60),
  perKey: z.boolean().default(true),
});

const ApiKeySchema = z.union([
  z.string(),
  z
    .object({
      // ${VAR} references are expanded from the gateway's environment.
      key: z
        .string()
        .min(1)
        .transform((k) => expandEnv(k)),
      name: z
        .string()
        .regex(/^[A-Za-z0-9._-]{1,64}$/, 'letters, digits, ".", "_" or "-" (max 64)')
        .optional(),
      servers: PatternList.optional(),
      tools: PatternList.optional(),
      rateLimit: z
        .object({ limit: z.number().int().positive(), windowSeconds: z.number().positive() })
        .strict()
        .optional(),
    })
    .strict(),
]);

const GatewayConfigSchema = z.object({
  port: z.number().int().min(1).max(65535).default(4000),
  host: z.string().default('0.0.0.0'),
  auth: z
    .object({
      strategy: z.enum(['none', 'api-key', 'jwt', 'oauth2']).default('none'),
      apiKeys: z.array(ApiKeySchema).optional(),
      jwtSecret: z.string().optional(),
      protect: z
        .object({
          health: z.boolean().default(false),
          metrics: z.boolean().default(false),
        })
        .optional(),
    })
    .superRefine((a, ctx) => {
      const keyOf = (k: string | { key: string }) => (typeof k === 'string' ? k : k.key);
      const names = new Set<string>();
      (a.apiKeys ?? []).forEach((k, i) => {
        if (typeof k === 'string' || !k.name) return;
        if (names.has(k.name)) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['apiKeys', i, 'name'], message: `duplicate key name "${k.name}"` });
        }
        names.add(k.name);
      });
      (a.apiKeys ?? []).forEach((k, i) => {
        if (typeof k !== 'string' && k.key.length === 0) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['apiKeys', i, 'key'], message: 'is empty (unset environment variable?)' });
        }
      });
      if (a.strategy === 'api-key' && !(a.apiKeys ?? []).some((k) => keyOf(k).length > 0)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['apiKeys'], message: 'at least one key is required for api-key strategy' });
      }
      if (a.strategy === 'jwt' && !a.jwtSecret) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['jwtSecret'], message: 'required for jwt strategy' });
      }
      if (a.strategy === 'oauth2') {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['strategy'], message: 'oauth2 is not implemented yet (refusing to start without auth)' });
      }
    })
    .optional(),
  rateLimit: RateLimitSchema.optional(),
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
  reconnect: ReconnectSchema.optional(),
  healthCheckIntervalMs: z.number().int().min(1000).default(30_000),
  dashboard: z.object({ enabled: z.boolean().default(true) }).optional(),
  audit: z
    .object({
      enabled: z.boolean().default(false),
      path: z.string().min(1).default('mcp-gateway-audit.db'),
      retentionDays: z.number().int().min(0).default(30),
    })
    .strict()
    .optional(),
  mcp: z
    .object({
      enabled: z.boolean().default(true),
      path: z
        .string()
        .regex(/^\/[A-Za-z0-9._~\-/]*$/, 'must be an absolute URL path such as /mcp')
        .refine((p) => p !== '/' && !/^\/(api|dashboard)(\/|$)/.test(p), 'must not be "/" or under /api or /dashboard')
        .default('/mcp'),
      toolNaming: z.enum(['auto', 'prefix']).default('auto'),
      pageSize: z.number().int().min(1).max(10_000).default(500),
      sessionIdleTimeoutSeconds: z.number().int().positive().default(1800),
      maxSessions: z.number().int().positive().default(1000),
      allowedOrigins: z.array(z.string()).optional(),
      instructions: z.string().optional(),
    })
    .strict()
    .optional(),
}).superRefine((c, ctx) => {
  const seen = new Set<string>();
  c.servers.forEach((s, i) => {
    if (seen.has(s.id)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['servers', i, 'id'], message: `duplicate server id "${s.id}"` });
    }
    seen.add(s.id);
  });
});

// ─── Loader ───────────────────────────────────────────────────────────────────

const CONFIG_SEARCH_PATHS = [
  'mcp-gateway.yml',
  'mcp-gateway.yaml',
  'mcp-gateway.json',
  '.mcp-gateway.yml',
  '.mcp-gateway.yaml',
];

/**
 * Resolve the config file that `loadConfig` would read: the explicit path if
 * given, otherwise the first match in the default search paths.
 */
export function resolveConfigPath(configPath?: string): string | undefined {
  if (configPath) return resolve(configPath);
  for (const searchPath of CONFIG_SEARCH_PATHS) {
    if (existsSync(searchPath)) return resolve(searchPath);
  }
  return undefined;
}

export async function loadConfig(configPath?: string): Promise<GatewayConfig> {
  const filePath = resolveConfigPath(configPath);
  let raw: unknown = filePath ? await readConfigFile(filePath) : {};
  // An empty YAML file parses to null
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    if (raw !== null && raw !== undefined) {
      throw new Error(`Invalid configuration: ${filePath} must contain a mapping/object at the top level`);
    }
    raw = {};
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
    // Keeps other auth settings (e.g. auth.protect) from the file.
    overrides.auth = {
      ...(overrides.auth as Record<string, unknown> ?? {}),
      strategy: 'api-key',
      apiKeys: process.env.MCP_GATEWAY_API_KEYS.split(',').map((k) => k.trim()).filter(Boolean),
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

# Authentication (optional; keys can be changed without a restart)
# auth:
#   strategy: api-key
#   apiKeys:
#     - your-secret-key-here          # full access
#     - key: \${AURA_GATEWAY_KEY}      # scoped key; \${VAR} is expanded (patterns are globs)
#       name: aura
#       servers: ["github", "fs-*"]
#       tools: ["read_*", "github/create_issue"]
#       rateLimit: { limit: 30, windowSeconds: 60 }
#   protect:
#     health: false    # true = /api/v1/health requires a key (/health/live stays public)
#     metrics: false   # true = /api/v1/metrics requires a key (configure your scraper)

# Automatic reconnect of crashed / disconnected servers (defaults shown)
# reconnect:
#   enabled: true
#   initialDelayMs: 1000
#   maxDelayMs: 60000
#   multiplier: 2
#   jitter: 0.2
#   maxAttempts: 0     # 0 = retry forever

# Rate limiting (optional)
# rateLimit:
#   limit: 100
#   windowSeconds: 60
#   perKey: true

# Downstream MCP endpoint: point Claude Code / Cursor / any MCP client at
# http://<host>:<port>/mcp (Streamable HTTP; uses the auth settings above)
# mcp:
#   enabled: true
#   path: /mcp
#   toolNaming: auto   # auto = prefix "<server>__" only on name collisions; prefix = always

# Persistent audit log of requests (SQLite via node:sqlite, Node 22.5+; default off)
# audit:
#   enabled: true
#   path: ./data/mcp-gateway-audit.db
#   retentionDays: 30   # 0 = keep forever

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

  # Remote servers
  # - id: remote-http
  #   name: Remote (Streamable HTTP)
  #   transport: streamable-http
  #   url: https://mcp.example.com/mcp
  #   headers:
  #     Authorization: "Bearer \${REMOTE_MCP_TOKEN}"
  #
  # - id: legacy-sse
  #   name: Legacy SSE server
  #   transport: sse
  #   url: http://localhost:8080/sse
  #
  # - id: websocket
  #   name: WebSocket server
  #   transport: websocket
  #   url: ws://localhost:8081
`;
}
