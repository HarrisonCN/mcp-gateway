/**
 * Configuration loader
 * Supports YAML, JSON, and environment variable overrides
 */

import { invalidPolicy } from '../policy/tool-policy.js';
import { invalidTenants } from '../auth/tenants.js';
import { invalidFilterPattern } from '../policy/output-filter.js';
import { readFile } from 'fs/promises';
import { existsSync } from 'fs';
import { dirname, resolve } from 'path';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { RegionsSchema } from '../features/schemas/regions.js';
import { EdgeFleetSchema } from '../features/schemas/edge-fleet.js';
import { PluginTrustSchema } from '../plugins/trust.js';
import { MarketplaceSchema } from '../features/schemas/marketplace.js';
import { SessionsSchema } from '../features/schemas/sessions.js';
import { DlpSchema } from '../features/schemas/dlp.js';
import { AdaptiveSchema } from '../features/schemas/adaptive.js';
import { ApiUpstreamsSchema } from '../features/schemas/api-upstreams.js';
import { GenaiTelemetrySchema } from '../features/schemas/genai-otel.js';
import { IdentitySchema } from '../features/schemas/identity.js';
import { PolicyRuleSchema } from '../policy/rule-schema.js';
import { PolicyShadowSchema } from '../features/schemas/policy-sim.js';
import { AnomalySchema } from '../features/schemas/anomaly.js';
import { BillingSchema } from '../features/schemas/billing.js';
import { ConsoleSchema } from '../features/schemas/console.js';
import { SanitizeSchema } from '../features/schemas/sanitize.js';
import { SemanticCacheSchema } from '../features/schemas/semantic-cache.js';
import { RolloutsSchema } from '../features/schemas/rollouts.js';
import { OfflineSchema } from '../features/schemas/offline.js';
import { ApprovalFlowsSchema } from '../features/schemas/approval-flows.js';
import { ComplianceReportsSchema } from '../features/schemas/compliance-reports.js';
import { AgentIdentitySchema } from '../features/schemas/agent-identity.js';
import { A2aFederationSchema } from '../features/schemas/a2a-federation.js';
import { DebugSessionsSchema } from '../features/schemas/debug-sessions.js';
import { CostAdvisorSchema } from '../features/schemas/cost-advisor.js';
import { BlueGreenSchema } from '../features/schemas/blue-green.js';
import { DataLineageSchema } from '../features/schemas/data-lineage.js';
import { ConfigAssistantSchema } from '../features/schemas/config-assistant.js';
import { ChaosSchema } from '../features/schemas/chaos.js';
import { MultimodalSchema } from '../features/schemas/multimodal.js';
import { EdgeRuntimeSchema } from '../features/schemas/edge-runtime.js';
import { ConfidentialSchema } from '../features/schemas/confidential.js';
import { ToolRegistrySchema } from '../features/schemas/tool-registry.js';
import { SlaSchema } from '../features/schemas/sla.js';
import { SelfHealingSchema } from '../features/schemas/self-healing.js';
import { PqTlsSchema } from '../features/schemas/pq-tls.js';
import { EcosystemSchema } from '../features/schemas/ecosystem.js';
import { PolicyEngineSchema } from '../features/schemas/policy-engine.js';
import { TimeTravelSchema } from '../features/schemas/time-travel.js';
import { RealtimeBudgetsSchema } from '../features/schemas/realtime-budgets.js';
import { TaskGraphsSchema } from '../features/schemas/task-graphs.js';
import { EdgeAutonomySchema } from '../features/schemas/edge-autonomy.js';
import { PrivacySchema } from '../features/schemas/privacy.js';
import { PqIdentitySchema } from '../features/schemas/pq-identity.js';
import type { GatewayConfig, PolicyRule, ToolPolicyConfig } from '../utils/types.js';
import { expandEnv } from '../transport/channel.js';
import { ControlPlaneSchema } from '../gateway/control-plane.js';
import { PROTOCOL_VERSIONS, unknownVersions } from '../mcp/compat.js';
import { validateChains, type ChainsConfig } from '../orchestration/chains.js';
import { configDeprecations, normalizeApiKeyScopes, normalizeFeaturesV10, normalizeSchemaV5, normalizeStoreV9, removedConfigKeys } from '../utils/deprecations.js';
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
  envPassthrough: z.array(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*\*?$/, 'an environment variable name or PREFIX_* glob')).optional(),
  isolation: z
    .object({
      uid: z.number().int().min(0).optional(),
      gid: z.number().int().min(0).optional(),
      cwd: z.string().min(1).optional(),
      sandbox: z
        .object({
          type: z.enum(['bubblewrap', 'firejail', 'container', 'custom']),
          network: z.enum(['none', 'host']).default('none'),
          writable: z.array(z.string().min(1)).optional(),
          readable: z.array(z.string().min(1)).optional(),
          image: z.string().min(1).optional(),
          runtime: z.string().min(1).optional(),
          command: z.array(z.string()).min(1).optional(),
        })
        .strict()
        .superRefine((s, ctx) => {
          if (s.type === 'container' && !s.image) ctx.addIssue({ code: 'custom', path: ['image'], message: 'image is required for sandbox type "container"' });
          if (s.type === 'custom' && !s.command?.some((t) => t.includes('{command}'))) ctx.addIssue({ code: 'custom', path: ['command'], message: 'a custom sandbox command must contain "{command}"' });
        })
        .optional(),
    })
    .strict()
    .optional(),
  headers: z.record(z.string()).optional(),
  subprotocol: z.string().optional(),
  reconnect: ReconnectSchema.optional(),
  tags: z.array(z.string()).optional(),
  enabled: z.boolean().default(true),
  timeout: z.number().positive().default(30000),
  maxConcurrency: z.number().int().positive().default(10),
  maxQueue: z.number().int().min(0).optional(),
  tls: z
    .object({
      spiffeId: z.string().regex(/^spiffe:\/\/[^/\s]+(\/\S*)?$/, 'must be a spiffe://trust-domain/path ID (globs allowed)').optional(),
      ca: z.string().min(1).optional(),
      servername: z.string().min(1).optional(),
      clientCert: z.boolean().optional(),
    })
    .strict()
    .optional(),
  passthrough: z.boolean().optional(),
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
          cost: z.number().min(0).optional(),
          enabled: z.boolean().optional(),
        })
        .strict(),
    )
    .optional(),
  loadBalancing: z
    .object({
      strategy: z.enum(['round-robin', 'random', 'weighted', 'failover', 'smart']).optional(),
      score: z
        .object({ latency: z.number().min(0).optional(), errorRate: z.number().min(0).optional(), cost: z.number().min(0).optional() })
        .strict()
        .optional(),
      failoverOn: z.array(z.enum(['not-connected', 'timeout', 'error'])).optional(),
      retries: z.number().int().min(0).optional(),
      ejectAfter: z.number().int().min(0).optional(),
      ejectMs: z.number().int().positive().optional(),
    })
    .strict()
    .optional(),
  weight: z.number().positive().optional(),
  cost: z.number().min(0).optional(),
  region: z.string().min(1).optional(),
  inject: z
    .array(
      z
        .object({
          ref: z.string().regex(/^secret:\/\/[A-Za-z0-9_-]+\/\S+$/, 'must be a secret://<provider>/<path>[#field] reference'),
          argument: z.string().min(1).optional(),
          meta: z.string().min(1).optional(),
          format: z.string().includes('{value}').optional(),
          required: z.boolean().optional(),
        })
        .strict()
        .refine((i) => !!i.argument !== !!i.meta, 'set exactly one of "argument" or "meta"'),
    )
    .optional(),
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
    // 10.2: unset = on automatically for a loopback-bound gateway without auth (see effectiveRebindingProtection).
    dnsRebindingProtection: z.boolean().optional(),
    // 10.3: allow starting without auth on a non-loopback address (same as `start --insecure`).
    insecure: z.boolean().optional(),
    maxBodyBytes: z.number().int().min(1024).default(10 * 1024 * 1024),
    maxToolArgumentsBytes: z.number().int().min(0).default(0),
    stdioEnvPassthrough: z.array(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*\*?$/, 'an environment variable name or PREFIX_* glob')).optional(),
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

// 6.5: the rule schema lives in policy/rule-schema.ts (shared with policy simulation).


const ExportCommon = {
  enabled: z.boolean().optional(),
  kinds: z.array(z.enum(['tool', 'resource', 'prompt'])).optional(),
  failuresOnly: z.boolean().optional(),
  batchSize: z.number().int().positive().max(10_000).optional(),
  flushIntervalMs: z.number().int().min(10).optional(),
  retries: z.number().int().min(0).max(10).optional(),
  maxQueue: z.number().int().positive().optional(),
};

const AuditExportSchema = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('syslog'),
      host: z.string().min(1),
      port: z.number().int().min(1).max(65535).optional(),
      protocol: z.enum(['udp', 'tcp', 'tls']).optional(),
      facility: z.enum(['kern', 'user', 'daemon', 'auth', 'syslog', 'authpriv', 'local0', 'local1', 'local2', 'local3', 'local4', 'local5', 'local6', 'local7']).optional(),
      appName: z.string().min(1).optional(),
      ...ExportCommon,
    })
    .strict(),
  z
    .object({
      type: z.literal('webhook'),
      url: z.string().url(),
      headers: z.record(z.string()).optional(),
      format: z.enum(['json', 'ndjson']).optional(),
      timeoutMs: z.number().int().positive().optional(),
      ...ExportCommon,
    })
    .strict(),
]);

const PolicyTestSchema = z
  .object({
    name: z.string().optional(),
    call: z
      .object({
        client: z.string().optional(),
        server: z.string().min(1),
        tool: z.string().min(1),
        args: z.record(z.unknown()).optional(),
      })
      .strict(),
    expect: z.enum(['allow', 'deny', 'approve']),
    rule: z.string().optional(),
  })
  .strict();

/** A policy-as-code file (`policy.files`): rules, an optional default and optional tests. */
export const PolicyFileSchema = z
  .object({
    version: z.literal(1).optional(),
    default: z.enum(['allow', 'deny', 'approve']).optional(),
    rules: z.array(PolicyRuleSchema).default([]),
    tests: z.array(PolicyTestSchema).optional(),
  })
  .strict();

// 4.2: tool chains.
type ChainStepInput = { id?: string; tool?: string; args?: Record<string, unknown>; when?: string; forEach?: string; concurrency?: number; parallel?: ChainStepInput[]; continueOnError?: boolean };
const ChainStepSchema: z.ZodType<ChainStepInput> = z.lazy(() =>
  z
    .object({
      id: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/).optional(),
      tool: z.string().min(3).optional(),
      args: z.record(z.unknown()).optional(),
      when: z.string().min(1).optional(),
      forEach: z.string().min(1).optional(),
      concurrency: z.number().int().min(1).max(64).optional(),
      parallel: z.array(ChainStepSchema).min(1).optional(),
      continueOnError: z.boolean().optional(),
    })
    .strict(),
);

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
  version: z.literal(11).optional(),
  // 10.9: how feature modules are activated. 11.0 default: lazy (only modules whose section is configured);
  // eager mounts every module (10.x behaviour).
  kernel: z.object({ modules: z.enum(['eager', 'lazy']).optional() }).strict().optional(),
  cors: z.object({ origins: z.array(z.string()).optional() }).strict().optional(),
  health: z.object({ intervalMs: z.number().int().min(1000).optional() }).strict().optional(),
  // 7.0: role (all / control / data), config API, dashboard and data-plane sync.
  controlPlane: ControlPlaneSchema.optional(),
  regions: RegionsSchema.optional(),
  edgeFleet: EdgeFleetSchema.optional(),
  pluginTrust: PluginTrustSchema.optional(),
  marketplace: MarketplaceSchema.optional(),
  sessions: SessionsSchema.optional(),
  dlp: DlpSchema.optional(),
  adaptive: AdaptiveSchema.optional(),
  apiUpstreams: ApiUpstreamsSchema.optional(),
  genaiTelemetry: GenaiTelemetrySchema.optional(),
  identity: IdentitySchema.optional(),
  policyShadow: PolicyShadowSchema.optional(),
  anomaly: AnomalySchema.optional(),
  billing: BillingSchema.optional(),
  console: ConsoleSchema.optional(),
  sanitize: SanitizeSchema.optional(),
  semanticCache: SemanticCacheSchema.optional(),
  rollouts: RolloutsSchema.optional(),
  offline: OfflineSchema.optional(),
  approvalFlows: ApprovalFlowsSchema.optional(),
  complianceReports: ComplianceReportsSchema.optional(),
  agentIdentity: AgentIdentitySchema.optional(),
  a2aFederation: A2aFederationSchema.optional(),
  debugSessions: DebugSessionsSchema.optional(),
  costAdvisor: CostAdvisorSchema.optional(),
  blueGreen: BlueGreenSchema.optional(),
  dataLineage: DataLineageSchema.optional(),
  configAssistant: ConfigAssistantSchema.optional(),
  chaos: ChaosSchema.optional(),
  multimodal: MultimodalSchema.optional(),
  edgeRuntime: EdgeRuntimeSchema.optional(),
  confidential: ConfidentialSchema.optional(),
  toolRegistry: ToolRegistrySchema.optional(),
  sla: SlaSchema.optional(),
  selfHealing: SelfHealingSchema.optional(),
  postQuantumTls: PqTlsSchema.optional(),
  ecosystem: EcosystemSchema.optional(),
  // 10.5: policy-as-code 2.0 (Cedar, OPA / Rego)
  policyEngine: PolicyEngineSchema.optional(),
  // 10.6: journal + time-travel debugging; sliding-window cost / carbon budgets
  timeTravel: TimeTravelSchema.optional(),
  realtimeBudgets: RealtimeBudgetsSchema.optional(),
  // 10.7: durable cross-gateway task graphs; edge autonomy (EXPERIMENTAL)
  taskGraphs: TaskGraphsSchema.optional(),
  edgeAutonomy: EdgeAutonomySchema.optional(),
  // 10.8 (EXPERIMENTAL): differential privacy / federated query; post-quantum (ML-DSA hybrid) identity
  privacy: PrivacySchema.optional(),
  pqIdentity: PqIdentitySchema.optional(),
  logLevel: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  reconnect: ReconnectSchema.optional(),
  audit: z
    .object({
      enabled: z.boolean().default(false),
      path: z.string().min(1).default('mcp-gateway-audit.db'),
      retentionDays: z.number().int().min(0).default(30),
      export: z.array(AuditExportSchema).optional(),
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
      protocolVersions: z
        .array(z.string())
        .min(1)
        .refine((l) => unknownVersions(l).length === 0, (l) => ({ message: `unknown MCP revision(s) ${unknownVersions(l).join(', ')} (supported: ${PROTOCOL_VERSIONS.join(', ')})` }))
        .optional(),
      instructions: z.string().optional(),
      eventBufferSize: z.number().int().min(0).max(100_000).default(256),
      passthrough: z
        .object({
          sampling: z.boolean().optional(),
          elicitation: z.boolean().optional(),
          roots: z.boolean().optional(),
          timeoutSeconds: z.number().int().positive().max(3600).optional(),
        })
        .strict()
        .optional(),
    })
    .strict()
    .optional(),
  security: SecuritySchema.optional(),
  policy: z
    .object({
      rules: z.array(PolicyRuleSchema).optional(),
      files: z.array(z.string().min(1)).optional(),
      tests: z.array(PolicyTestSchema).optional(),
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
  quotas: z
    .object({
      rules: z
        .array(
          z
            .object({
              name: z.string().min(1).optional(),
              limit: z.number().int().min(0),
              period: z.enum(['hour', 'day', 'month']),
              per: z.enum(['client', 'tenant']).optional(),
              clients: z.array(z.string().min(1)).optional(),
              tenants: z.array(z.string().min(1)).optional(),
              servers: z.array(z.string().min(1)).optional(),
              tools: z.array(z.string().min(1)).optional(),
            })
            .strict(),
        )
        .optional(),
      meteringRetentionDays: z.number().int().positive().optional(),
    })
    .strict()
    .optional(),
  catalog: z
    .object({
      builtins: z.boolean().optional(),
      sources: z.array(z.string().min(1)).optional(),
      install: z.boolean().optional(),
      serversFile: z.string().min(1).optional(),
    })
    .strict()
    .optional(),
  tenants: z
    .array(
      z
        .object({
          id: z.string().min(1).regex(/^[A-Za-z0-9._-]+$/, 'letters, digits, ".", "_" and "-" only'),
          name: z.string().min(1).optional(),
          servers: z.array(z.string().min(1)),
          members: z.array(z.object({ client: z.string().min(1), role: z.enum(['owner', 'admin', 'viewer']) }).strict()).optional(),
        })
        .strict(),
    )
    .superRefine((ts, ctx) => {
      const bad = invalidTenants(ts);
      if (bad) ctx.addIssue({ code: z.ZodIssueCode.custom, message: bad });
    })
    .optional(),
  portal: z
    .object({
      enabled: z.boolean().optional(),
      signup: z.enum(['open', 'approval', 'closed']).optional(),
      allowedEmailDomains: z.array(z.string().regex(/^[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/)).optional(),
      maxKeysPerEmail: z.number().int().min(1).max(100).optional(),
      defaults: z
        .object({
          servers: z.array(z.string().min(1)).optional(),
          tools: z.array(z.string().min(1)).optional(),
          rateLimit: z.object({ limit: z.number().int().positive(), windowSeconds: z.number().int().positive() }).strict().optional(),
          keyTtlDays: z.number().int().min(1).max(3650).optional(),
        })
        .strict()
        .optional(),
      keysFile: z.string().min(1).optional(),
      title: z.string().min(1).max(80).optional(),
      publicUrl: z.string().url().optional(),
    })
    .strict()
    .optional(),
  compliance: z
    .object({
      residency: z
        .object({
          rules: z.array(z.object({ tenants: z.array(z.string().min(1)).optional(), regions: z.array(z.string().min(1)).min(1) }).strict()).optional(),
          allowUnknown: z.boolean().optional(),
        })
        .strict()
        .optional(),
    })
    .strict()
    .optional(),
  federation: z
    .object({
      enabled: z.boolean().optional(),
      gatewayId: z.string().regex(/^[A-Za-z0-9_.-]+$/),
      region: z.string().min(1).optional(),
      sharedSecret: z.string().min(32, 'federation.sharedSecret must be at least 32 characters'),
      peers: z
        .array(z.object({ id: z.string().regex(/^[A-Za-z0-9_.-]+$/), url: z.string().url(), region: z.string().min(1).optional(), priority: z.number().int().min(0).optional() }).strict())
        .optional(),
      export: z.array(z.string().min(1)).optional(),
      import: z.array(z.string().min(1)).optional(),
      sync: z.object({ intervalSeconds: z.number().int().min(5).max(3600).optional() }).strict().optional(),
      failover: z.object({ enabled: z.boolean().optional(), servers: z.array(z.string().min(1)).optional() }).strict().optional(),
    })
    .strict()
    .superRefine((f, ctx) => {
      const ids = new Set<string>();
      (f.peers ?? []).forEach((p, i) => {
        if (p.id === f.gatewayId) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['peers', i, 'id'], message: 'a peer cannot have this gateway\'s own id' });
        if (ids.has(p.id)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['peers', i, 'id'], message: `duplicate peer "${p.id}"` });
        ids.add(p.id);
      });
    })
    .optional(),
  secrets: z
    .object({
      providers: z
        .array(
          z
            .object({
              id: z.string().regex(/^[A-Za-z0-9_-]+$/),
              type: z.enum(['vault', 'aws-kms', 'gcp-kms', 'env', 'file']),
              address: z.string().url().optional(),
              token: z.string().min(1).optional(),
              roleId: z.string().min(1).optional(),
              secretId: z.string().min(1).optional(),
              mount: z.string().min(1).optional(),
              namespace: z.string().min(1).optional(),
              region: z.string().min(1).optional(),
              keyId: z.string().min(1).optional(),
              accessKeyId: z.string().min(1).optional(),
              secretAccessKey: z.string().min(1).optional(),
              sessionToken: z.string().min(1).optional(),
              endpoint: z.string().url().optional(),
              baseDir: z.string().min(1).optional(),
            })
            .strict()
            .superRefine((p, ctx) => {
              if (p.type === 'vault' && !p.address) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['address'], message: 'required for vault' });
              if (p.type === 'vault' && !p.token && !(p.roleId && p.secretId)) {
                ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['token'], message: 'vault needs token or roleId + secretId' });
              }
            }),
        )
        .optional(),
      cacheSeconds: z.number().int().min(0).max(86_400).optional(),
      rotation: z.object({ intervalSeconds: z.number().int().min(10).max(86_400).optional() }).strict().optional(),
    })
    .strict()
    .superRefine((sc, ctx) => {
      const ids = new Set<string>();
      (sc.providers ?? []).forEach((p, i) => {
        if (ids.has(p.id)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['providers', i, 'id'], message: `duplicate provider "${p.id}"` });
        ids.add(p.id);
      });
    })
    .optional(),
  routing: z
    .object({
      splits: z
        .array(
          z
            .object({
              name: z.string().min(1),
              server: z.string().min(1),
              tools: z.array(z.string().min(1)).optional(),
              sticky: z.enum(['client', 'none']).optional(),
              enabled: z.boolean().optional(),
              variants: z
                .array(
                  z
                    .object({
                      server: z.string().min(1),
                      weight: z.number().min(0),
                      label: z.string().min(1).optional(),
                      guard: z
                        .object({
                          maxErrorRate: z.number().min(0).max(1).optional(),
                          maxLatencyMs: z.number().positive().optional(),
                          minCalls: z.number().int().positive().optional(),
                        })
                        .strict()
                        .optional(),
                    })
                    .strict(),
                )
                .min(1),
            })
            .strict(),
        )
        .optional(),
    })
    .strict()
    .superRefine((r, ctx) => {
      const names = new Set<string>();
      (r.splits ?? []).forEach((sp, i) => {
        if (names.has(sp.name)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['splits', i, 'name'], message: `duplicate split "${sp.name}"` });
        names.add(sp.name);
        if (!sp.variants.some((v) => v.weight > 0)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['splits', i, 'variants'], message: 'at least one variant needs a weight > 0' });
        const seen = new Set<string>();
        sp.variants.forEach((v, j) => {
          if (seen.has(v.server)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['splits', i, 'variants', j, 'server'], message: `duplicate variant server "${v.server}"` });
          seen.add(v.server);
        });
      });
    })
    .optional(),
  replay: z
    .object({
      enabled: z.boolean().optional(),
      maxEntries: z.number().int().positive().max(100_000).optional(),
      maxBytes: z.number().int().positive().max(10 * 1024 * 1024).optional(),
      results: z.boolean().optional(),
    })
    .strict()
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
  openai: z
    .object({
      enabled: z.boolean().optional(),
      path: z.string().regex(/^\/[^\s]*$/, 'must start with "/"').optional(),
      injectTools: z.boolean().optional(),
      maxToolRounds: z.number().int().min(0).max(50).optional(),
      upstream: z
        .object({
          baseUrl: z.string().url(),
          apiKey: z.string().min(1).optional(),
          headers: z.record(z.string()).optional(),
          timeoutMs: z.number().int().positive().optional(),
        })
        .strict()
        .optional(),
    })
    .strict()
    .optional(),
  a2a: z
    .object({
      enabled: z.boolean().optional(),
      path: z.string().regex(/^\/[^\s]*$/, 'must start with "/"').optional(),
      url: z.string().url().optional(),
      name: z.string().min(1).optional(),
      description: z.string().optional(),
      provider: z.object({ organization: z.string().min(1), url: z.string().url().optional() }).strict().optional(),
      public: z.boolean().optional(),
      taskRetentionSeconds: z.number().int().positive().optional(),
    })
    .strict()
    .optional(),
  mtls: z
    .object({
      identity: z.object({ cert: z.string().min(1), key: z.string().min(1), bundle: z.string().min(1).optional() }).strict().optional(),
      reloadIntervalSeconds: z.number().int().min(0).optional(),
      requireForAll: z.boolean().optional(),
      expiryWarningHours: z.number().positive().optional(),
    })
    .strict()
    .optional(),
  streaming: z
    .object({ highWaterBytes: z.number().int().min(1024).optional(), maxBufferedBytes: z.number().int().min(4096).optional() })
    .strict()
    .optional(),
  costs: z
    .object({
      currency: z.string().regex(/^[A-Z]{3}$/).optional(),
      tools: z.array(z.object({ match: z.string().min(1), perCall: z.number().min(0) }).strict()).optional(),
      models: z.record(z.object({ input: z.number().min(0), output: z.number().min(0) }).strict()).optional(),
      budgets: z
        .array(
          z
            .object({
              name: z.string().min(1),
              clients: z.array(z.string()).optional(),
              tenants: z.array(z.string()).optional(),
              perClient: z.boolean().optional(),
              period: z.enum(['day', 'month']),
              limit: z.number().positive(),
              alertAt: z.array(z.number().gt(0).max(10)).optional(),
              action: z.enum(['alert', 'block']).optional(),
              webhook: z.string().url().optional(),
            })
            .strict(),
        )
        .optional(),
    })
    .strict()
    .optional(),
  chains: z
    .object({
      toolPrefix: z.string().regex(/^[A-Za-z0-9_.-]{1,32}$/).optional(),
      chains: z
        .array(
          z
            .object({
              name: z.string().regex(/^[A-Za-z0-9_.-]{1,64}$/),
              description: z.string().optional(),
              inputSchema: z.record(z.unknown()).optional(),
              steps: z.array(ChainStepSchema).min(1),
              output: z.unknown().optional(),
              timeoutMs: z.number().int().positive().max(3_600_000).optional(),
            })
            .strict(),
        )
        .optional(),
    })
    .strict()
    .superRefine((c, ctx) => {
      for (const m of validateChains(c as ChainsConfig)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: m.replace(/^chains\./, '') });
    })
    .optional(),
  plugins: z
    .array(
      z
        .object({
          module: z.string().min(1).optional(),
          component: z.string().min(1).optional(),
          signature: z.string().min(1).optional(),
          name: z.string().min(1).optional(),
          enabled: z.boolean().optional(),
          options: z.record(z.unknown()).optional(),
          secrets: z.record(z.string().regex(/^secret:\/\/[A-Za-z0-9_-]+\/\S+$/, 'must be a secret://provider/path reference')).optional(),
          isolation: z.enum(['tenant', 'client', 'shared']).optional(),
          // 10.5: JS module plugins — time limit per onToolCall / onResponse (fails closed).
          timeoutMs: z.number().int().positive().max(60_000).optional(),
          limits: z
            .object({
              timeoutMs: z.number().int().positive().max(60_000).optional(),
              memoryMb: z.number().int().min(1).max(4096).optional(),
              maxInstances: z.number().int().positive().max(10_000).optional(),
            })
            .strict()
            .optional(),
        })
        .strict()
        .refine((p) => (p.module ? 1 : 0) + (p.component ? 1 : 0) === 1, 'a plugin needs exactly one of "module" or "component"')
        .refine((p) => p.component || (p.isolation === undefined && p.limits === undefined), '"isolation" / "limits" apply to WASM component plugins only')
        .refine((p) => !p.component || p.timeoutMs === undefined, '"timeoutMs" applies to module plugins — use limits.timeoutMs for WASM components'),
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
      store: z.enum(['memory', 'redis', 'eventlog', 'sqlite']).default('memory'),
      // 11.2: durable single-node store on node:sqlite.
      sqlite: z.object({ path: z.string().min(1).default('.mcp-gateway/state.db') }).strict().optional(),
      // 9.0: event-sourced store (append-only log + snapshots).
      eventlog: z
        .object({
          dir: z.string().min(1).default('.mcp-gateway/store'),
          snapshotEvery: z.number().int().min(1).default(10_000),
          fsync: z.boolean().default(false),
        })
        .strict()
        .optional(),
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
      if (st.store === 'redis' && !st.redis) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['redis'], message: 'store.redis.url is required for backend "redis"' });
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
  if (c.portal?.enabled && c.auth?.strategy !== 'api-key') {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['portal', 'enabled'], message: 'the developer portal issues API keys and needs auth.strategy: api-key' });
  }
  // secret:// references must name a configured provider (or the built-in "env").
  const providers = new Set(['env', ...(c.secrets?.providers ?? []).map((p) => p.id)]);
  c.servers.forEach((s, i) => {
    const vals = [...Object.values(s.env ?? {}), ...Object.values(s.headers ?? {}), s.url ?? '', ...(s.args ?? []), ...(s.inject ?? []).map((x) => x.ref)];
    for (const v of vals) {
      for (const m of v.matchAll(/secret:\/\/([A-Za-z0-9_-]+)\//g)) {
        if (!providers.has(m[1]!)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['servers', i], message: `unknown secret provider "${m[1]}"` });
      }
    }
  });
  (c.routing?.splits ?? []).forEach((sp, i) => {
    for (const [j, id] of [sp.server, ...sp.variants.map((v) => v.server)].entries()) {
      if (!seen.has(id)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['routing', 'splits', i, ...(j === 0 ? ['server'] : ['variants', j - 1, 'server'])], message: `unknown server "${id}"` });
      }
    }
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

/** Validate (and apply defaults to) a raw config object; throws a readable error listing every issue. */
export function validateConfig(raw: unknown): GatewayConfig {
  const removed = removedConfigKeys(raw);
  const v4 = normalizeApiKeyScopes(normalizeSchemaV5(removed.length ? raw : normalizeStoreV9(normalizeFeaturesV10(raw))));
  removed.push(...v4.errors);
  if (removed.length > 0) throw new Error(`Invalid configuration:\n${removed.map((m) => `  - ${m}`).join('\n')}`);
  const result = GatewayConfigSchema.safeParse(v4.raw);
  if (!result.success) {
    throw new Error(
      `Invalid configuration:\n${result.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n')}`
    );
  }
  const config = result.data as GatewayConfig;
  const deprecations = configDeprecations(raw);
  if (deprecations.length > 0) config.deprecations = deprecations;
  return config;
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

  const config = validateConfig(raw);
  if (filePath) config.configDir = dirname(filePath);
  if (config.policy?.files?.length) config.policy = await loadPolicyFiles(config.policy, config.configDir ?? process.cwd());
  return config;
}

/**
 * Merge `policy.files` into the policy: inline rules first, then each file's rules in order (first match wins).
 * A file's `default` applies when the inline policy sets none (the last file with one wins). Tests are collected.
 */
export async function loadPolicyFiles(policy: ToolPolicyConfig, baseDir: string): Promise<ToolPolicyConfig> {
  const rules = [...(policy.rules ?? [])];
  const tests = [...(policy.tests ?? [])];
  let fileDefault: ToolPolicyConfig['default'];
  for (const f of policy.files ?? []) {
    const path = resolve(baseDir, f);
    let raw: unknown;
    try {
      raw = await readConfigFile(path);
    } catch (err) {
      throw new Error(`Invalid configuration: policy file ${f}: ${err instanceof Error ? err.message : String(err)}`);
    }
    const parsed = PolicyFileSchema.safeParse(Array.isArray(raw) ? { rules: raw } : (raw ?? {}));
    if (!parsed.success) {
      throw new Error(`Invalid configuration: policy file ${f}:\n${parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n')}`);
    }
    // Idempotent: a policy that already holds this file's rules (a running config sent back through
    // GET → PUT /admin/config, or a reload) must not end up with them twice.
    const fileRules = (parsed.data.rules as PolicyRule[]).map((r, i) => ({ ...r, name: r.name ?? `${f}#${i + 1}` }));
    const fileTests = parsed.data.tests ?? [];
    dropEqual(rules, fileRules);
    dropEqual(tests, fileTests);
    rules.push(...fileRules);
    tests.push(...fileTests);
    if (parsed.data.default) fileDefault = parsed.data.default;
  }
  const merged: ToolPolicyConfig = { ...policy, rules, tests, default: policy.default ?? fileDefault };
  const bad = invalidPolicy(merged);
  if (bad) throw new Error(`Invalid configuration: ${bad}`);
  return merged;
}

/** Remove from `list` every entry structurally equal to one in `incoming`. */
function dropEqual<T>(list: T[], incoming: T[]): void {
  const key = (v: unknown) => JSON.stringify(v, (_k, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => a.localeCompare(b))) : x));
  const seen = new Set(incoming.map(key));
  for (let i = list.length - 1; i >= 0; i--) if (seen.has(key(list[i]))) list.splice(i, 1);
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
    // Schema v9: `store: { backend: redis, redis: { url } }` (8.9 wrote the removed `state` block here).
    const st = (overrides.store as Record<string, unknown> | undefined) ?? {};
    overrides.store = {
      ...st,
      backend: 'redis',
      redis: { ...((st.redis as Record<string, unknown>) ?? {}), url: process.env.MCP_GATEWAY_REDIS_URL },
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

version: 11
port: 4000
# Loopback only. To listen on every interface (0.0.0.0) configure auth first: since 10.3 the gateway refuses to
# start without auth on a non-loopback address unless started with --insecure.
host: 127.0.0.1
logLevel: info

# Authentication (optional; keys can be changed without a restart)
# auth:
#   strategy: api-key
#   apiKeys:
#     - your-secret-key-here          # full access
#     - key: \${AURA_GATEWAY_KEY}      # scoped key; \${VAR} is expanded (patterns are globs)
#       name: aura
#       scope:
#         servers: ["github", "fs-*"]
#         tools: ["read_*", "github/create_issue"]
#         rateLimit: { limit: 30, windowSeconds: 60 }
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
#   dnsRebindingProtection: true   # Host must be localhost / allowedHosts, /mcp only same-origin + loopback origins (default: on for loopback + no auth)
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
