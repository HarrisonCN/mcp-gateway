/**
 * Configuration loader
 * Supports YAML, JSON, and environment variable overrides
 */

import { invalidPolicy } from '../policy/tool-policy.js';
import { invalidFilterPattern } from '../policy/output-filter.js';
import { readFile } from 'fs/promises';
import { existsSync } from 'fs';
import { dirname, resolve } from 'path';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import type { GatewayConfig } from '../utils/types.js';
import { expandEnv } from '../transport/channel.js';
import { invalidCidr } from '../security/network.js';
import { invalidRedactPattern } from '../security/redact.js';
import { ASYMMETRIC_ALGORITHMS, HMAC_ALGORITHMS } from '../auth/middleware.js';

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
  replicas: z
    .array(
      z
        .object({
          name: z.string().min(1).optional(),
          transport: z.enum(['stdio', 'sse', 'websocket', 'streamable-http']).optional(),
          url: z.string().url().optional(),
          command: z.string().optional(),
          args: z.array(z.string()).optional(),
          env: z.record(z.string()).optional(),
          headers: z.record(z.string()).optional(),
          weight: z.number().positive().optional(),
          enabled: z.boolean().optional(),
        })
        .strict(),
    )
    .optional(),
  loadBalancing: z
    .object({
      strategy: z.enum(['round-robin', 'random', 'weighted', 'least-latency', 'failover']).optional(),
      failoverOn: z.array(z.enum(['not-connected', 'timeout', 'error'])).optional(),
      retries: z.number().int().min(0).optional(),
      ejectAfter: z.number().int().min(0).optional(),
      ejectMs: z.number().int().positive().optional(),
    })
    .strict()
    .optional(),
  weight: z.number().positive().optional(),
}).superRefine((s, ctx) => {
  if (s.id.includes('~')) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['id'], message: '"~" is reserved for replica ids' });
  }
  (s.replicas ?? []).forEach((r, i) => {
    const transport = r.transport ?? s.transport;
    if (transport === 'stdio' && !(r.command ?? s.command)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['replicas', i, 'command'], message: 'required for stdio transport' });
    }
    const protocols = URL_PROTOCOLS[transport];
    const url = r.url ?? s.url;
    if (protocols && (!url || !protocols.includes(safeProtocol(url)))) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['replicas', i, 'url'], message: `a ${protocols.join(' / ')} URL is required for ${transport} transport` });
    }
  });
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
      expiresAt: z
        .string()
        .refine((v) => !Number.isNaN(Date.parse(v)), 'must be an ISO 8601 date or date-time')
        .optional(),
      disabled: z.boolean().optional(),
      rateLimit: z
        .object({ limit: z.number().int().positive(), windowSeconds: z.number().positive() })
        .strict()
        .optional(),
    })
    .strict(),
]);

const StringOrList = z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]);

const JwtSchema = z
  .object({
    issuer: StringOrList.optional(),
    audience: StringOrList.optional(),
    algorithms: z.array(z.enum([...HMAC_ALGORITHMS, ...ASYMMETRIC_ALGORITHMS] as [string, ...string[]])).min(1).optional(),
    clockToleranceSeconds: z.number().min(0).max(3600).optional(),
    jwksUrl: z.string().url().optional(),
    jwksCacheSeconds: z.number().int().positive().optional(),
    publicKey: z.string().min(1).optional(),
    requireExp: z.boolean().optional(),
    maxTokenAgeSeconds: z.number().int().positive().optional(),
  })
  .strict();

const OAuthSchema = z
  .object({
    authorizationServers: z.array(z.string().url()).min(1),
    resource: z.string().url().optional(),
    issuer: z.union([z.string(), z.array(z.string())]).optional(),
    audience: z.union([z.string(), z.array(z.string())]).optional(),
    jwksUrl: z.string().url().optional(),
    jwksCacheSeconds: z.number().int().positive().optional(),
    algorithms: z.array(z.string()).optional(),
    clockToleranceSeconds: z.number().int().min(0).optional(),
    introspection: z
      .object({
        url: z.string().url(),
        clientId: z.string().optional(),
        clientSecret: z.string().optional(),
        cacheSeconds: z.number().int().min(0).optional(),
        requireAudience: z.boolean().optional(),
        preferForJwt: z.boolean().optional(),
      })
      .strict()
      .optional(),
    scopesSupported: z.array(z.string()).optional(),
    requiredScopes: z.array(z.string()).optional(),
    resourceName: z.string().optional(),
    documentation: z.string().url().optional(),
  })
  .strict();

const LockoutSchema = z
  .object({
    maxFailures: z.number().int().min(1).optional(),
    windowSeconds: z.number().int().positive().optional(),
    lockoutSeconds: z.number().int().positive().optional(),
  })
  .strict();

const SecuritySchema = z
  .object({
    headers: z.boolean().default(true),
    hsts: z
      .union([
        z.boolean(),
        z.object({ maxAgeSeconds: z.number().int().min(0).optional(), includeSubDomains: z.boolean().optional() }).strict(),
      ])
      .optional(),
    trustProxy: z.union([z.boolean(), z.number().int().min(0), z.string().min(1), z.array(z.string().min(1))]).optional(),
    ipAllowlist: z
      .array(z.string().min(1))
      .superRefine((list, ctx) => {
        const err = invalidCidr(list);
        if (err) ctx.addIssue({ code: z.ZodIssueCode.custom, message: err });
      })
      .optional(),
    allowedHosts: z.array(z.string().min(1)).optional(),
    dnsRebindingProtection: z.boolean().default(false),
    maxBodyBytes: z.number().int().min(1024).default(10 * 1024 * 1024),
    maxToolArgumentsBytes: z.number().int().min(0).default(0),
    authLockout: z.union([z.boolean(), LockoutSchema]).optional(),
    redactPatterns: z
      .array(z.string().min(1))
      .superRefine((list, ctx) => {
        const err = invalidRedactPattern(list);
        if (err) ctx.addIssue({ code: z.ZodIssueCode.custom, message: `invalid regular expression ${err}` });
      })
      .optional(),
    exposeErrorDetails: z.boolean().default(false),
  })
  .strict();

const GatewayConfigSchema = z.object({
  port: z.number().int().min(1).max(65535).default(4000),
  host: z.string().default('0.0.0.0'),
  auth: z
    .object({
      strategy: z.enum(['none', 'api-key', 'jwt', 'oauth2']).default('none'),
      apiKeys: z.array(ApiKeySchema).optional(),
      jwtSecret: z.string().optional(),
      jwt: JwtSchema.optional(),
      oauth: OAuthSchema.optional(),
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
        const key = keyOf(k);
        if (/^sha256:/i.test(key) && !/^sha256:[0-9a-f]{64}$/i.test(key)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: typeof k === 'string' ? ['apiKeys', i] : ['apiKeys', i, 'key'],
            message: '"sha256:" keys must be followed by 64 hex characters (mcp-gateway hash-key)',
          });
        }
        if (typeof k !== 'string' && k.key.length === 0) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['apiKeys', i, 'key'], message: 'is empty (unset environment variable?)' });
        }
      });
      if (a.strategy === 'api-key' && !(a.apiKeys ?? []).some((k) => keyOf(k).length > 0)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['apiKeys'], message: 'at least one key is required for api-key strategy' });
      }
      if (a.strategy === 'jwt') {
        const sources = [a.jwtSecret, a.jwt?.publicKey, a.jwt?.jwksUrl].filter(Boolean).length;
        if (sources === 0) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['jwtSecret'], message: 'jwt strategy needs jwtSecret, jwt.publicKey or jwt.jwksUrl' });
        } else if (sources > 1) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['jwt'], message: 'configure only one of jwtSecret, jwt.publicKey, jwt.jwksUrl' });
        }
        const algs = a.jwt?.algorithms;
        if (algs && sources === 1) {
          const allowed = a.jwtSecret ? HMAC_ALGORITHMS : ASYMMETRIC_ALGORITHMS;
          const bad = algs.filter((x) => !allowed.includes(x));
          if (bad.length > 0) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: ['jwt', 'algorithms'],
              message: `${bad.join(', ')} cannot be used with ${a.jwtSecret ? 'an HMAC secret' : 'a public key / JWKS'} (algorithm confusion)`,
            });
          }
        }
      }
      if (a.strategy === 'oauth2') {
        if (!a.oauth) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['oauth'], message: 'oauth2 strategy needs auth.oauth (authorizationServers, jwksUrl or introspection)' });
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
      eventBufferSize: z.number().int().min(0).max(100_000).default(256),
    })
    .strict()
    .optional(),
  security: SecuritySchema.optional(),
  policy: z
    .object({
      rules: z
        .array(
          z
            .object({
              name: z.string().optional(),
              effect: z.enum(['allow', 'deny', 'approve']),
              clients: z.array(z.string()).optional(),
              servers: z.array(z.string()).optional(),
              tools: z.array(z.string()).optional(),
              args: z
                .array(
                  z
                    .object({
                      path: z.string().min(1),
                      exists: z.boolean().optional(),
                      equals: z.union([z.string(), z.number(), z.boolean()]).optional(),
                      in: z.array(z.union([z.string(), z.number(), z.boolean()])).optional(),
                      glob: z.array(z.string()).optional(),
                      notGlob: z.array(z.string()).optional(),
                      regex: z.string().optional(),
                      notRegex: z.string().optional(),
                      longerThan: z.number().int().min(0).optional(),
                      under: z.array(z.string()).optional(),
                      notUnder: z.array(z.string()).optional(),
                    })
                    .strict(),
                )
                .optional(),
              message: z.string().optional(),
            })
            .strict(),
        )
        .optional(),
      default: z.enum(['allow', 'deny', 'approve']).optional(),
      approval: z
        .object({ timeoutSeconds: z.number().int().positive().optional(), allowSelfApproval: z.boolean().optional() })
        .strict()
        .optional(),
      outputFilter: z
        .object({
          enabled: z.boolean().optional(),
          action: z.enum(['flag', 'redact', 'block']).optional(),
          builtins: z.boolean().optional(),
          patterns: z.array(z.string()).optional(),
          tools: z.array(z.string()).optional(),
        })
        .strict()
        .optional(),
    })
    .strict()
    .superRefine((pol, ctx) => {
      const bad = invalidPolicy(pol) ?? (invalidFilterPattern(pol.outputFilter?.patterns) && `outputFilter.patterns: invalid regex ${invalidFilterPattern(pol.outputFilter?.patterns)}`);
      if (bad) ctx.addIssue({ code: z.ZodIssueCode.custom, message: bad });
    })
    .optional(),
  cache: z
    .object({
      enabled: z.boolean().optional(),
      maxEntries: z.number().int().positive().optional(),
      defaultTtlSeconds: z.number().int().min(0).optional(),
      rules: z
        .array(
          z
            .object({
              servers: z.array(z.string().min(1)).optional(),
              tools: z.array(z.string().min(1)).optional(),
              ttlSeconds: z.number().int().min(0).optional(),
              scope: z.enum(['client', 'shared']).optional(),
              dedupe: z.boolean().optional(),
              dedupeOnly: z.boolean().optional(),
            })
            .strict(),
        )
        .optional(),
    })
    .strict()
    .optional(),
  plugins: z
    .array(
      z
        .object({
          module: z.string().min(1),
          name: z.string().min(1).optional(),
          enabled: z.boolean().optional(),
          options: z.record(z.unknown()).optional(),
        })
        .strict(),
    )
    .optional(),
  observability: z
    .object({
      tracing: z
        .object({
          enabled: z.boolean().default(false),
          exporter: z.enum(['otlp-http', 'console', 'otel-api']).default('otlp-http'),
          endpoint: z.string().url().optional(),
          headers: z.record(z.string()).optional(),
          serviceName: z.string().min(1).optional(),
          resourceAttributes: z.record(z.string()).optional(),
          sampleRatio: z.number().min(0).max(1).optional(),
          flushIntervalMs: z.number().int().min(100).optional(),
        })
        .strict()
        .optional(),
    })
    .strict()
    .optional(),
  state: z
    .object({
      store: z.enum(['memory', 'redis']).default('memory'),
      redis: z
        .object({
          url: z.string().regex(/^rediss?:\/\//, 'must start with redis:// or rediss://'),
          keyPrefix: z.string().optional(),
          connectTimeoutMs: z.number().int().positive().optional(),
          commandTimeoutMs: z.number().int().positive().optional(),
        })
        .strict()
        .optional(),
      failureMode: z.enum(['open', 'closed']).default('open'),
    })
    .strict()
    .superRefine((st, ctx) => {
      if (st.store === 'redis' && !st.redis) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['redis'], message: 'state.redis.url is required for store "redis"' });
    })
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

  const config = result.data as GatewayConfig;
  if (filePath) config.configDir = dirname(filePath);
  return config;
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
  if (process.env.MCP_GATEWAY_REDIS_URL) {
    overrides.state = {
      ...((overrides.state as Record<string, unknown>) ?? {}),
      store: 'redis',
      redis: { ...(((overrides.state as Record<string, unknown>)?.redis as Record<string, unknown>) ?? {}), url: process.env.MCP_GATEWAY_REDIS_URL },
    };
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
#     - sha256:<64-hex-digest>        # a key stored as its digest: run mcp-gateway hash-key
#     - key: \${CI_GATEWAY_KEY}
#       name: ci
#       expiresAt: 2027-01-01   # rejected from this date on; "disabled: true" switches a key off
#   protect:
#     health: false    # true = /api/v1/health requires a key (/health/live stays public)
#     metrics: false   # true = /api/v1/metrics requires a key (configure your scraper)

# Hardening (all optional; defaults shown where they exist)
# security:
#   headers: true                  # nosniff, frame-ancestors, Referrer-Policy, CSP (dashboard: hashed inline script)
#   hsts: false                    # true behind HTTPS
#   trustProxy: false              # e.g. 1 or ["10.0.0.0/8"] behind a reverse proxy (affects req.ip)
#   ipAllowlist: ["10.0.0.0/8", "127.0.0.1"]
#   dnsRebindingProtection: false  # true: Host must be localhost / allowedHosts, /mcp only same-origin + loopback origins
#   allowedHosts: ["gateway.example.com"]
#   maxBodyBytes: 10485760
#   maxToolArgumentsBytes: 0       # 0 = no limit
#   authLockout: true              # or { maxFailures: 10, windowSeconds: 300, lockoutSeconds: 900 }
#   redactPatterns: ["internal-[0-9a-f]{32}"]

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
