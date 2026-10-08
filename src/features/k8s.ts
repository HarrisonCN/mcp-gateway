/**
 * Kubernetes (6.8): manifests, an operator for the `McpGateway` custom resource, and a Helm chart (`deploy/helm`).
 *
 * - {@link renderManifests} turns a spec (config, replicas, image, resources, autoscaling) into a ConfigMap,
 *   Deployment (config-hash annotation so config changes roll the pods, probes, non-root security context), Service,
 *   PodDisruptionBudget and optional HorizontalPodAutoscaler / ServiceMonitor.
 * - {@link K8sOperator} reconciles `McpGateway` resources (`mcp-gateway.dev/v1alpha1`, CRD in
 *   `deploy/crd/mcpgateways.yaml`): it renders the manifests, applies them with **server-side apply**
 *   (field manager `mcp-gateway-operator`, owner references to the resource) and writes `status`
 *   (`observedGeneration`, `configHash`, `phase`, conditions). Run it with `mcp-gateway operator` in the cluster.
 * - `GET /api/v1/admin/k8s/manifests?replicas=&namespace=&format=yaml` renders manifests for this gateway's config.
 *
 * @module features/k8s
 */

import { createHash } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { stringify as toYaml } from 'yaml';
import { z } from 'zod';
import { registerFeature } from '../gateway/features.js';
import { portableConfig } from '../gateway/admin.js';
import { VERSION } from '../utils/version.js';
import { logger } from '../utils/logger.js';

export const GROUP = 'mcp-gateway.dev';
export const API_VERSION = `${GROUP}/v1alpha1`;
const FIELD_MANAGER = 'mcp-gateway-operator';
const Name = z.string().regex(/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/).max(53);

export const McpGatewaySpecSchema = z
  .object({
    config: z.record(z.unknown()).default({}),
    replicas: z.number().int().min(0).max(100).default(1),
    image: z.string().min(1).optional(),
    port: z.number().int().min(1).max(65535).default(4000),
    envFromSecret: z.string().optional(),
    resources: z.object({ requests: z.record(z.string()).optional(), limits: z.record(z.string()).optional() }).strict().default({ requests: { cpu: '100m', memory: '128Mi' }, limits: { memory: '512Mi' } }),
    autoscaling: z.object({ minReplicas: z.number().int().min(1).default(1), maxReplicas: z.number().int().min(1).default(5), targetCPUUtilization: z.number().int().min(1).max(100).default(70) }).strict().optional(),
    serviceMonitor: z.boolean().default(false),
    pdbMinAvailable: z.number().int().min(0).optional(),
  })
  .strict();
export type McpGatewaySpec = z.input<typeof McpGatewaySpecSchema>;

const stable = (v: unknown): string => (Array.isArray(v) ? `[${v.map(stable).join(',')}]` : v && typeof v === 'object' ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stable((v as Record<string, unknown>)[k])}`).join(',')}}` : JSON.stringify(v));
/** Short, order-independent hash of a config object. */
export const configHash = (config: unknown) => createHash('sha256').update(stable(config)).digest('hex').slice(0, 16);

type Manifest = { apiVersion: string; kind: string; metadata: Record<string, unknown>; [k: string]: unknown };

/** Manifests for one gateway. `owner` adds owner references (operator). */
export function renderManifests(name: string, namespace: string, spec: McpGatewaySpec, owner?: { uid: string; name: string }): Manifest[] {
  Name.parse(name);
  const s = McpGatewaySpecSchema.parse(spec);
  const labels = { 'app.kubernetes.io/name': 'mcp-gateway', 'app.kubernetes.io/instance': name, 'app.kubernetes.io/managed-by': owner ? FIELD_MANAGER : 'mcp-gateway' };
  const selector = { 'app.kubernetes.io/name': 'mcp-gateway', 'app.kubernetes.io/instance': name };
  const meta = (n = name) => ({ name: n, namespace, labels, ...(owner ? { ownerReferences: [{ apiVersion: API_VERSION, kind: 'McpGateway', name: owner.name, uid: owner.uid, controller: true, blockOwnerDeletion: true }] } : {}) });
  const config = { ...s.config, port: s.port, host: '0.0.0.0' };
  const hash = configHash(config);
  const out: Manifest[] = [
    { apiVersion: 'v1', kind: 'ConfigMap', metadata: meta(), data: { 'mcp-gateway.yml': toYaml(config) } },
    {
      apiVersion: 'apps/v1',
      kind: 'Deployment',
      metadata: meta(),
      spec: {
        ...(s.autoscaling ? {} : { replicas: s.replicas }),
        selector: { matchLabels: selector },
        strategy: { type: 'RollingUpdate', rollingUpdate: { maxUnavailable: 0, maxSurge: 1 } },
        template: {
          metadata: { labels, annotations: { 'mcp-gateway.dev/config-hash': hash, 'prometheus.io/scrape': 'true', 'prometheus.io/port': String(s.port), 'prometheus.io/path': '/api/v1/metrics' } },
          spec: {
            securityContext: { runAsNonRoot: true, runAsUser: 1000, fsGroup: 1000, seccompProfile: { type: 'RuntimeDefault' } },
            terminationGracePeriodSeconds: 30,
            containers: [
              {
                name: 'mcp-gateway',
                image: s.image ?? `ghcr.io/harrisoncn/mcp-gateway:${VERSION}`,
                args: ['start', '-c', '/config/mcp-gateway.yml'],
                ports: [{ name: 'http', containerPort: s.port }],
                ...(s.envFromSecret ? { envFrom: [{ secretRef: { name: s.envFromSecret } }] } : {}),
                volumeMounts: [{ name: 'config', mountPath: '/config', readOnly: true }, { name: 'tmp', mountPath: '/tmp' }],
                livenessProbe: { httpGet: { path: '/api/v1/health/live', port: 'http' }, periodSeconds: 10 },
                readinessProbe: { httpGet: { path: '/api/v1/health/ready', port: 'http' }, periodSeconds: 5 },
                resources: s.resources,
                securityContext: { allowPrivilegeEscalation: false, readOnlyRootFilesystem: true, capabilities: { drop: ['ALL'] } },
              },
            ],
            volumes: [{ name: 'config', configMap: { name } }, { name: 'tmp', emptyDir: {} }],
          },
        },
      },
    },
    { apiVersion: 'v1', kind: 'Service', metadata: meta(), spec: { selector, ports: [{ name: 'http', port: 80, targetPort: 'http' }] } },
  ];
  const minAvail = s.pdbMinAvailable ?? ((s.autoscaling?.minReplicas ?? s.replicas) > 1 ? 1 : undefined);
  if (minAvail !== undefined) out.push({ apiVersion: 'policy/v1', kind: 'PodDisruptionBudget', metadata: meta(), spec: { minAvailable: minAvail, selector: { matchLabels: selector } } });
  if (s.autoscaling)
    out.push({
      apiVersion: 'autoscaling/v2',
      kind: 'HorizontalPodAutoscaler',
      metadata: meta(),
      spec: { scaleTargetRef: { apiVersion: 'apps/v1', kind: 'Deployment', name }, minReplicas: s.autoscaling.minReplicas, maxReplicas: s.autoscaling.maxReplicas, metrics: [{ type: 'Resource', resource: { name: 'cpu', target: { type: 'Utilization', averageUtilization: s.autoscaling.targetCPUUtilization } } }] },
    });
  if (s.serviceMonitor) out.push({ apiVersion: 'monitoring.coreos.com/v1', kind: 'ServiceMonitor', metadata: meta(), spec: { selector: { matchLabels: selector }, endpoints: [{ port: 'http', path: '/api/v1/metrics', interval: '30s' }] } });
  return out;
}

/** The `McpGateway` CustomResourceDefinition (also in deploy/crd/mcpgateways.yaml). */
export const MCPGATEWAY_CRD = {
  apiVersion: 'apiextensions.k8s.io/v1',
  kind: 'CustomResourceDefinition',
  metadata: { name: `mcpgateways.${GROUP}` },
  spec: {
    group: GROUP,
    scope: 'Namespaced',
    names: { plural: 'mcpgateways', singular: 'mcpgateway', kind: 'McpGateway', shortNames: ['mgw'] },
    versions: [
      {
        name: 'v1alpha1',
        served: true,
        storage: true,
        subresources: { status: {} },
        additionalPrinterColumns: [
          { name: 'Replicas', type: 'integer', jsonPath: '.spec.replicas' },
          { name: 'Phase', type: 'string', jsonPath: '.status.phase' },
          { name: 'Age', type: 'date', jsonPath: '.metadata.creationTimestamp' },
        ],
        schema: { openAPIV3Schema: { type: 'object', properties: { spec: { type: 'object', 'x-kubernetes-preserve-unknown-fields': true }, status: { type: 'object', 'x-kubernetes-preserve-unknown-fields': true } } } },
      },
    ],
  },
};

/** Minimal Kubernetes API client (fetch). */
export interface K8sApi {
  request(method: string, path: string, body?: unknown, contentType?: string): Promise<{ status: number; body: any }>; // eslint-disable-line @typescript-eslint/no-explicit-any
}

/** In-cluster API access via the service account (Node's fetch; set NODE_EXTRA_CA_CERTS to the SA CA bundle). */
export function inClusterApi(env: NodeJS.ProcessEnv = process.env, saDir = '/var/run/secrets/kubernetes.io/serviceaccount'): K8sApi {
  const host = env.KUBERNETES_SERVICE_HOST;
  if (!host) throw new Error('not running in a cluster (KUBERNETES_SERVICE_HOST is unset)');
  const base = `https://${host.includes(':') ? `[${host}]` : host}:${env.KUBERNETES_SERVICE_PORT ?? '443'}`;
  const tokenFile = `${saDir}/token`;
  return httpApi(base, () => (existsSync(tokenFile) ? readFileSync(tokenFile, 'utf8').trim() : undefined));
}

export function httpApi(base: string, token: () => string | undefined = () => undefined): K8sApi {
  return {
    async request(method, path, body, contentType = 'application/json') {
      const t = token();
      const res = await fetch(base.replace(/\/+$/, '') + path, { method, headers: { accept: 'application/json', ...(body !== undefined ? { 'content-type': contentType } : {}), ...(t ? { authorization: `Bearer ${t}` } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
      const txt = await res.text();
      let b: unknown = txt;
      try { b = JSON.parse(txt); } catch { /* text */ }
      return { status: res.status, body: b };
    },
  };
}

const PLURAL: Record<string, string> = { ConfigMap: 'configmaps', Deployment: 'deployments', Service: 'services', PodDisruptionBudget: 'poddisruptionbudgets', HorizontalPodAutoscaler: 'horizontalpodautoscalers', ServiceMonitor: 'servicemonitors' };
const pathOf = (m: Manifest) => {
  const [group, version] = m.apiVersion.includes('/') ? m.apiVersion.split('/') : ['', m.apiVersion];
  const ns = m.metadata.namespace as string;
  return `${group ? `/apis/${group}/${version}` : `/api/${version}`}/namespaces/${ns}/${PLURAL[m.kind]}/${m.metadata.name as string}`;
};

export interface ReconcileResult {
  namespace: string;
  name: string;
  applied: string[];
  error?: string;
}

export class K8sOperator {
  private timer?: NodeJS.Timeout;
  constructor(private readonly api: K8sApi, private readonly opts: { namespace?: string; intervalMs?: number } = {}) {}

  /** One pass over every McpGateway resource. */
  async reconcileAll(): Promise<ReconcileResult[]> {
    const ns = this.opts.namespace;
    const list = await this.api.request('GET', `/apis/${API_VERSION}/${ns ? `namespaces/${ns}/` : ''}mcpgateways`);
    if (list.status !== 200) throw new Error(`listing McpGateways failed: HTTP ${list.status}`);
    const out: ReconcileResult[] = [];
    for (const item of (list.body.items ?? []) as Array<{ metadata: { name: string; namespace: string; uid: string; generation?: number }; spec?: McpGatewaySpec }>) out.push(await this.reconcile(item));
    return out;
  }

  async reconcile(cr: { metadata: { name: string; namespace: string; uid: string; generation?: number }; spec?: McpGatewaySpec }): Promise<ReconcileResult> {
    const { name, namespace, uid, generation } = cr.metadata;
    const r: ReconcileResult = { namespace, name, applied: [] };
    let phase = 'Ready';
    let message = 'all resources applied';
    let hash: string | undefined;
    try {
      const manifests = renderManifests(name, namespace, cr.spec ?? {}, { uid, name });
      hash = (manifests[1]!.spec as { template: { metadata: { annotations: Record<string, string> } } }).template.metadata.annotations['mcp-gateway.dev/config-hash'];
      for (const m of manifests) {
        const res = await this.api.request('PATCH', `${pathOf(m)}?fieldManager=${FIELD_MANAGER}&force=true`, m, 'application/apply-patch+yaml');
        if (res.status >= 300) throw new Error(`${m.kind}/${m.metadata.name as string}: HTTP ${res.status} ${typeof res.body === 'object' ? (res.body?.message ?? '') : res.body}`);
        r.applied.push(`${m.kind}/${m.metadata.name as string}`);
      }
    } catch (e) {
      phase = 'Error';
      message = (e as Error).message;
      r.error = message;
    }
    const status = { observedGeneration: generation, phase, ...(hash ? { configHash: hash } : {}), conditions: [{ type: 'Ready', status: phase === 'Ready' ? 'True' : 'False', reason: phase === 'Ready' ? 'Applied' : 'ApplyFailed', message, lastTransitionTime: new Date().toISOString() }] };
    await this.api.request('PATCH', `/apis/${API_VERSION}/namespaces/${namespace}/mcpgateways/${name}/status?fieldManager=${FIELD_MANAGER}&force=true`, { apiVersion: API_VERSION, kind: 'McpGateway', metadata: { name, namespace }, status }, 'application/apply-patch+yaml').catch(() => undefined);
    return r;
  }

  start(): void {
    const tick = () =>
      this.reconcileAll()
        .then((rs) => rs.forEach((x) => (x.error ? logger.warn(`McpGateway ${x.namespace}/${x.name}: ${x.error}`) : logger.debug(`McpGateway ${x.namespace}/${x.name}: ${x.applied.length} resources`))))
        .catch((e) => logger.warn(`operator: ${(e as Error).message}`));
    void tick();
    this.timer = setInterval(tick, this.opts.intervalMs ?? 15_000);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }
}

registerFeature({
  id: 'k8s',
  since: '6.8.0',
  summary: 'Kubernetes: render manifests for this gateway; McpGateway operator (server-side apply) and Helm chart',
  mount: (router, ctx) => {
    router.get('/manifests', (req, res) => {
      const q = req.query;
      const name = typeof q.name === 'string' ? q.name : 'mcp-gateway';
      const namespace = typeof q.namespace === 'string' ? q.namespace : 'default';
      const replicas = q.replicas === undefined ? 1 : Number(q.replicas);
      let manifests: Manifest[];
      try {
        const cfg = portableConfig(ctx.config()) as Record<string, unknown>;
        const { port: _p, host: _h, ...rest } = cfg;
        // Never put API keys into a ConfigMap: supply them through the Secret (MCP_GATEWAY_API_KEYS).
        const auth = rest.auth as { apiKeys?: unknown } | undefined;
        if (auth?.apiKeys) rest.auth = { ...auth, apiKeys: undefined };
        manifests = renderManifests(name, namespace, { config: rest, replicas, port: ctx.config().port || 4000, ...(typeof q.image === 'string' ? { image: q.image } : {}), ...(typeof q.secret === 'string' ? { envFromSecret: q.secret } : {}) });
      } catch (e) {
        return void res.status(400).json({ error: 'Bad Request', message: e instanceof z.ZodError ? e.issues.map((i) => `${i.path.join('.') || 'name'}: ${i.message}`).join('; ') : (e as Error).message });
      }
      if (q.format === 'yaml') return void res.type('application/yaml').send(manifests.map((m) => toYaml(m)).join('---\n'));
      res.json({ items: manifests, notes: ['auth.apiKeys are not rendered: put them in a Secret (MCP_GATEWAY_API_KEYS) and pass ?secret=<name>'] });
    });
    router.get('/crd', (_req, res) => void res.json(MCPGATEWAY_CRD));
  },
});
