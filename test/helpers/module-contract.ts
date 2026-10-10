/**
 * Module contract harness (13.4.0): one minimal, schema-v11-valid configuration per registered feature module, so the
 * shared lifecycle / security contract (test/contract-13-4-0.test.ts) can be applied to every module in the manifest.
 * A module added to the manifest without an entry here fails the harness ("no minimal section").
 */
import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { hybridKeygen } from '../../src/security/pq.js';

/** Extra top-level config that activates module `id` (empty for modules that are always available). */
export function minimalSections(): { dir: string; sections: Record<string, Record<string, unknown>> } {
  const dir = mkdtempSync(join(tmpdir(), 'mgw-contract-'));
  writeFileSync(join(dir, 'gw.hybrid.json'), JSON.stringify(hybridKeygen().privateKey));
  const sections: Record<string, Record<string, unknown>> = {
    conformance: {},
    regions: { regions: { self: 'eu', syncIntervalMs: 3_600_000, peers: [] } },
    'edge-fleet': { edgeFleet: {} },
    marketplace: { marketplace: {} },
    sessions: { sessions: {} },
    dlp: { dlp: {} },
    adaptive: { adaptive: {} },
    'api-upstreams': { apiUpstreams: [{ id: 'gql', kind: 'graphql', url: 'http://127.0.0.1:9/graphql', operations: [{ name: 'q', document: 'query q { a }' }] }] },
    'genai-otel': { genaiTelemetry: {} },
    identity: { identity: {} },
    'policy-sim': { policyShadow: {} },
    anomaly: { anomaly: {} },
    billing: { billing: {} },
    k8s: {},
    terraform: {},
    console: { console: {} },
    sanitize: { sanitize: {} },
    'semantic-cache': { semanticCache: { tools: ['fake/echo'] } },
    rollouts: { rollouts: [{ id: 'r', stable: 'fake', canary: 'fake2' }] },
    offline: { offline: {} },
    'approval-flows': { approvalFlows: {} },
    'compliance-reports': { complianceReports: {} },
    'agent-identity': { agentIdentity: { signingKey: 'k'.repeat(40), agents: [] } },
    'a2a-federation': { a2aFederation: {} },
    'debug-sessions': { debugSessions: {} },
    'cost-advisor': { costAdvisor: {} },
    'blue-green': { blueGreen: [{ id: 'bg', blue: 'fake', green: 'fake2' }] },
    'data-lineage': { dataLineage: {} },
    'config-assistant': { configAssistant: {} },
    chaos: { chaos: {} },
    multimodal: { multimodal: {} },
    'edge-runtime': { edgeRuntime: {} },
    confidential: { confidential: {} },
    'tool-registry': { toolRegistry: {} },
    sla: { sla: {} },
    'self-healing': { selfHealing: {} },
    'pq-tls': { postQuantumTls: {} },
    ecosystem: { ecosystem: {} },
    'policy-engine': { policyEngine: { cedar: 'permit(principal, action, resource);' } },
    'time-travel': { timeTravel: { dir: join(dir, 'tt') } },
    'realtime-budgets': { realtimeBudgets: { budgets: [{ name: 'hourly', metric: 'cost', limit: 1000, windowSeconds: 3600 }] } },
    'task-graphs': { taskGraphs: { dir: join(dir, 'tg'), graphs: [{ id: 'g', nodes: [{ id: 'a', tool: 'fake/echo' }] }] } },
    'edge-autonomy': { edgeAutonomy: { dir: join(dir, 'ea'), rules: [{ match: 'fake/echo', action: 'cache' }], reconcile: { intervalMs: 3_600_000 } } },
    privacy: { privacy: {} },
    'pq-identity': { configDir: dir, pqIdentity: { keyFile: 'gw.hybrid.json', keyId: 'gw-test', gatewayId: 'gw.example', auditLog: { dir: join(dir, 'audit') } } },
    kernel: {},
  };
  return { dir, sections };
}
