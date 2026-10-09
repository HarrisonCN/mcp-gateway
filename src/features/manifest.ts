/**
 * Feature manifest (13.0): every built-in feature module, described WITHOUT evaluating it — id, version, summary,
 * the config section(s) that activate it, the modules it depends on, the call hook it registers and an `import()`
 * thunk. The kernel ({@link ../gateway/kernel-runtime.ts}) loads a module (after its dependencies) only when it
 * becomes active, so a gateway that configures no features evaluates no feature module.
 *
 * Order matters: it is the call-hook pipeline order (a hook registered with `first` still runs first).
 *
 * @module features/manifest
 */

import type { GatewayConfig } from '../utils/types.js';

export interface FeatureManifestEntry {
  id: string;
  since: string;
  summary: string;
  /** Config section(s) that activate the module in lazy mode; none = always available (loaded on first use). */
  activation?: readonly (keyof GatewayConfig)[];
  /** Modules that must be loaded (and initialised) before this one, and are disposed after it. */
  dependsOn?: readonly string[];
  /** Id of the call hook the module registers, if any (hook modules are loaded at start when active). */
  hook?: string;
  /** Config section that makes the hook do anything (modules without `activation`); the module is then loaded at start. */
  hookWhen?: keyof GatewayConfig;
  /** Evaluate the module (registers it with the feature registry). */
  load: () => Promise<unknown>;
}

export const FEATURE_MANIFEST: readonly FeatureManifestEntry[] = [
  { id: 'conformance', since: '5.1.0', summary: 'MCP conformance self-test of this gateway\'s /mcp endpoint', load: () => import('./conformance.js') },
  { id: 'regions', since: '5.2.0', summary: 'Multi-region active-active: replicated state, peer health, cross-region failover routing', activation: ['regions'], load: () => import('./regions.js') },
  { id: 'edge-fleet', since: '5.3.0', summary: 'Managed edge nodes: fleet view with config drift, push config to edges', activation: ['edgeFleet'], load: () => import('./edge-fleet.js') },
  { id: 'marketplace', since: '5.4.0', summary: 'Signed plugin marketplace: browse indexes, verified install', activation: ['marketplace'], load: () => import('./marketplace.js') },
  { id: 'sessions', since: '5.5.0', summary: 'Agent session recording, replay and regression evals', activation: ['sessions'], load: () => import('./sessions.js') },
  { id: 'dlp', since: '5.6.0', summary: 'Data loss prevention: sensitivity levels, per-tenant clearance and masking', activation: ['dlp'], hook: 'dlp', load: () => import('./dlp.js') },
  { id: 'adaptive', since: '5.8.0', summary: 'Adaptive routing 2.0: pick upstream / model by quality, cost and latency (Thompson sampling)', activation: ['adaptive'], hook: 'adaptive', load: () => import('./adaptive.js') },
  { id: 'api-upstreams', since: '6.1.0', summary: 'GraphQL and gRPC (Connect / JSON transcoding) upstreams exposed as tools', activation: ['apiUpstreams'], load: () => import('./api-upstreams.js') },
  { id: 'genai-otel', since: '6.3.0', summary: 'OpenTelemetry GenAI semantic conventions: execute_tool spans, operation duration and token usage metrics, OTLP export', activation: ['genaiTelemetry'], hook: 'genai-otel', load: () => import('./genai-otel.js') },
  { id: 'identity', since: '6.4.0', summary: 'Enterprise SSO (OIDC ID tokens) and SCIM 2.0 user / group provisioning mapped to tenant roles', activation: ['identity'], load: () => import('./identity.js') },
  { id: 'policy-sim', since: '6.5.0', summary: 'Policy simulation and dry-run: replay history against a candidate policy, shadow policies on live traffic', hook: 'policy-shadow', hookWhen: 'policyShadow', load: () => import('./policy-sim.js') },
  { id: 'anomaly', since: '6.6.0', summary: 'Anomaly detection: traffic bursts, error spikes, tool enumeration and prompt-injection scoring with alert / quarantine', activation: ['anomaly'], hook: 'anomaly', load: () => import('./anomaly.js') },
  { id: 'billing', since: '6.7.0', summary: 'Usage billing: per-tenant metering against a price book, monthly invoices (JSON / CSV)', activation: ['billing'], dependsOn: ['genai-otel'], hook: 'billing', load: () => import('./billing.js') },
  { id: 'k8s', since: '6.8.0', summary: 'Kubernetes: render manifests for this gateway; McpGateway operator (server-side apply) and Helm chart', load: () => import('./k8s.js') },
  { id: 'terraform', since: '7.1.0', summary: 'Terraform: REST resources for servers, tenants and API keys (restapi provider) and HCL export with import blocks', load: () => import('./terraform.js') },
  { id: 'console', since: '7.2.0', summary: 'SaaS console: organisations with plans (servers, daily call limits), onboarding, suspension', activation: ['console'], hook: 'console', load: () => import('./console.js') },
  { id: 'sanitize', since: '7.3.0', summary: 'Prompt-injection defence: tool-output sanitisation (hidden Unicode, ANSI, HTML, exfil images), spotlighting, inbound / outbound blocking', activation: ['sanitize'], dependsOn: ['anomaly'], hook: 'sanitize', load: () => import('./sanitize.js') },
  { id: 'semantic-cache', since: '7.4.0', summary: 'Semantic cache: answer paraphrased tool calls from earlier results by embedding similarity (tenant-isolated)', activation: ['semanticCache'], hook: 'semantic-cache', load: () => import('./semantic-cache.js') },
  { id: 'rollouts', since: '7.5.0', summary: 'Tool versioning and gradual rollout: sticky percentage canaries per server with automatic rollback', activation: ['rollouts'], hook: 'rollouts', load: () => import('./rollouts.js') },
  { id: 'offline', since: '7.6.0', summary: 'Offline desktop gateway: connectivity probe, fail-fast for remote upstreams when offline, desktop-client config import', activation: ['offline'], hook: 'offline', load: () => import('./offline.js') },
  { id: 'approval-flows', since: '7.7.0', summary: 'Approvals 2.0: multi-step, conditional approval flows with named approvers and escalation', activation: ['approvalFlows'], hook: 'approval-flows', load: () => import('./approval-flows.js') },
  { id: 'compliance-reports', since: '7.8.0', summary: 'Automated compliance reports: scheduled SOC 2 / ISO 27001 / GDPR evidence bundles with SHA-256 manifests', activation: ['complianceReports'], load: () => import('./compliance-reports.js') },
  { id: 'agent-identity', since: '8.1.0', summary: 'Agent identity & delegated auth: agent registry, on-behalf-of delegation tokens (RFC 8693 act chains), scoped agent calls', activation: ['agentIdentity'], hook: 'agent-identity', load: () => import('./agent-identity.js') },
  { id: 'a2a-federation', since: '8.2.0', summary: 'Cross-gateway A2A federation: remote agent discovery (agent cards), skill catalog, task forwarding with shared audit', activation: ['a2aFederation'], load: () => import('./a2a-federation.js') },
  { id: 'debug-sessions', since: '8.3.0', summary: 'Live collaborative debugging: shared sessions, live call stream (SSE), breakpoints, edit/resume/abort, notes, replay', activation: ['debugSessions'], hook: 'debug-sessions', load: () => import('./debug-sessions.js') },
  { id: 'cost-advisor', since: '8.4.0', summary: 'Cost optimization advisor: quantified caching, failure, cheaper-upstream and budget recommendations from live traffic', activation: ['costAdvisor'], hook: 'cost-advisor', load: () => import('./cost-advisor.js') },
  { id: 'blue-green', since: '8.5.0', summary: 'Zero-downtime blue/green upgrades: probed atomic switch, in-flight drain, verification window with auto-rollback', activation: ['blueGreen'], hook: 'blue-green', load: () => import('./blue-green.js') },
  { id: 'data-lineage', since: '8.6.0', summary: 'Data lineage: value fingerprints link tool outputs to later tool inputs (graph, trace by value, OpenLineage export)', activation: ['dataLineage'], hook: 'data-lineage', load: () => import('./data-lineage.js') },
  { id: 'config-assistant', since: '8.7.0', summary: 'Natural-language config assistant: plain-words changes → validated config patch, diff (dry run), apply', activation: ['configAssistant'], load: () => import('./config-assistant.js') },
  { id: 'chaos', since: '8.8.0', summary: 'Chaos testing: scheduled or on-demand latency / error / timeout / corruption injection with a steady-state guard', activation: ['chaos'], hook: 'chaos', load: () => import('./chaos.js') },
  { id: 'multimodal', since: '9.1.0', summary: 'Multimodal tools: content-type policy and size limits for image / audio / blob results, offloaded and streamed in chunks', activation: ['multimodal'], hook: 'multimodal', load: () => import('./multimodal.js') },
  { id: 'edge-runtime', since: '9.2.0', summary: 'Edge WASM runtime 2.0: WebAssembly tools with a warm instance pool, SHA-256 pins and per-tool time / memory / concurrency quotas', activation: ['edgeRuntime'], load: () => import('./edge-runtime.js') },
  { id: 'confidential', since: '9.3.0', summary: 'Confidential computing: sensitive servers get calls only from inside a remotely attested TEE (SEV-SNP, TDX, Nitro, SGX)', activation: ['confidential'], hook: 'confidential', load: () => import('./confidential.js') },
  { id: 'tool-registry', since: '9.4.0', summary: 'Global tool registry: signed tool manifests, search, cross-gateway mirrors, immutable versions and version pins', activation: ['toolRegistry'], load: () => import('./tool-registry.js') },
  { id: 'sla', since: '9.5.0', summary: 'SLA monitoring: availability / p95 latency objectives per server and tenant, error budgets, breaches and service-credit reports', activation: ['sla'], hook: 'sla', load: () => import('./sla.js') },
  { id: 'self-healing', since: '9.6.0', summary: 'Self-healing: eject / fail over, roll back or throttle unhealthy upstreams automatically, lifted after a cool-down', activation: ['selfHealing'], hook: 'self-healing', load: () => import('./self-healing.js') },
  { id: 'pq-tls', since: '9.7.0', summary: 'Post-quantum TLS: hybrid X25519MLKEM768 key exchange for upstream HTTPS, PQ handshake probes and a certificate policy', activation: ['postQuantumTls'], load: () => import('./pq-tls.js') },
  { id: 'ecosystem', since: '9.8.0', summary: 'Ecosystem marketplace GA: moderated catalogue of plugins and tools, ratings and reviews, verified publishers', activation: ['ecosystem'], load: () => import('./ecosystem.js') },
  { id: 'policy-engine', since: '10.5.0', summary: 'Policy-as-code 2.0: Cedar policies in-process, Rego via OPA, policy unit tests and change-impact analysis', activation: ['policyEngine'], hook: 'policy-engine', load: () => import('./policy-engine.js') },
  { id: 'time-travel', since: '10.6.0', summary: 'Full-chain replay and time-travel debugging: journal of configs and calls, state at any instant, replay with diffs', activation: ['timeTravel'], hook: 'time-travel', load: () => import('./time-travel.js') },
  { id: 'realtime-budgets', since: '10.6.0', summary: 'Real-time cost and carbon budgets: sliding windows per client / tenant, warnings, reject or downgrade', activation: ['realtimeBudgets'], hook: 'realtime-budgets', load: () => import('./realtime-budgets.js') },
  { id: 'task-graphs', since: '10.7.0', summary: 'Multi-agent orchestration 2.0: cross-gateway task graphs with checkpoints, resume, retry with backoff and saga compensation', activation: ['taskGraphs'], dependsOn: ['a2a-federation'], load: () => import('./task-graphs.js') },
  { id: 'edge-autonomy', since: '10.7.0', summary: 'Edge autonomy (EXPERIMENTAL): local cache / WASM / queue / deny decisions while an upstream is unreachable, outbox reconcile on reconnect', activation: ['edgeAutonomy'], dependsOn: ['edge-runtime', 'offline'], hook: 'edge-autonomy', load: () => import('./edge-autonomy.js') },
  { id: 'privacy', since: '10.8.0', summary: 'Privacy computing (EXPERIMENTAL): differentially private aggregates of tool results, federated queries, ε budgets', activation: ['privacy'], hook: 'privacy', load: () => import('./privacy.js') },
  { id: 'pq-identity', since: '10.8.0', summary: 'Post-quantum identity (EXPERIMENTAL): Ed25519 + ML-DSA hybrid signed identity document, tool manifest and audit-log checkpoints', activation: ['pqIdentity'], hook: 'pq-identity', load: () => import('./pq-identity.js') },
  { id: 'kernel', since: '10.0.0', summary: 'Unified gateway kernel: config schema v11, lazily activated feature modules, call-hook pipeline and support status in one view', load: () => import('./kernel.js') },
];

const byId = new Map(FEATURE_MANIFEST.map((e) => [e.id, e]));

/** Manifest entry of a module id. */
export const manifestEntry = (id: string): FeatureManifestEntry | undefined => byId.get(id);

/** Module id that owns a call hook id (`policy-shadow` → `policy-sim`). */
export const hookOwner = (hookId: string): string | undefined => FEATURE_MANIFEST.find((e) => e.hook === hookId)?.id;
