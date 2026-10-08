import { describe, it, expect, afterEach } from 'vitest';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { renderManifests, configHash, K8sOperator, httpApi, inClusterApi, MCPGATEWAY_CRD, McpGatewaySpecSchema } from '../src/features/k8s.js';
import { startFeatureGw, type FeatureGw } from './helpers/feature-gw.js';

let h: FeatureGw | undefined;
afterEach(async () => {
  await h?.stop();
  h = undefined;
});

describe('Kubernetes operator and Helm (6.8)', () => {
  it('renders ConfigMap, Deployment, Service (+ PDB / HPA / ServiceMonitor)', () => {
    const ms = renderManifests('gw', 'prod', { config: { servers: [] }, replicas: 2, envFromSecret: 'gw-secrets', serviceMonitor: true });
    expect(ms.map((m) => m.kind)).toEqual(['ConfigMap', 'Deployment', 'Service', 'PodDisruptionBudget', 'ServiceMonitor']);
    const dep = ms[1] as any;
    expect(dep.spec.replicas).toBe(2);
    const c = dep.spec.template.spec.containers[0];
    expect(c.image).toMatch(/^ghcr\.io\/harrisoncn\/mcp-gateway:\d+\.\d+\.\d+/);
    expect(c.envFrom).toEqual([{ secretRef: { name: 'gw-secrets' } }]);
    expect(c.securityContext.readOnlyRootFilesystem).toBe(true);
    expect(dep.spec.template.metadata.annotations['mcp-gateway.dev/config-hash']).toBe(configHash({ servers: [], port: 4000, host: '0.0.0.0' }));
    expect(parse((ms[0] as any).data['mcp-gateway.yml'])).toEqual({ servers: [], port: 4000, host: '0.0.0.0' });
    const hpa = renderManifests('gw', 'prod', { autoscaling: { maxReplicas: 9 } });
    expect(hpa.map((m) => m.kind)).toEqual(['ConfigMap', 'Deployment', 'Service', 'HorizontalPodAutoscaler']);
    expect((hpa[1] as any).spec.replicas).toBeUndefined();
    expect((hpa[3] as any).spec).toMatchObject({ minReplicas: 1, maxReplicas: 9 });
    const owned = renderManifests('gw', 'prod', {}, { uid: 'u-1', name: 'gw' });
    expect((owned[0]!.metadata as any).ownerReferences[0]).toMatchObject({ kind: 'McpGateway', uid: 'u-1', controller: true });
    expect(configHash({ a: 1, b: [1, { c: 2 }] })).toBe(configHash({ b: [1, { c: 2 }], a: 1 }));
    expect(() => renderManifests('Bad_Name', 'x', {})).toThrow();
    expect(() => McpGatewaySpecSchema.parse({ replicas: -1 })).toThrow();
  });

  it('operator applies with server-side apply and writes status', async () => {
    const reqs: Array<{ method: string; url: string; type?: string; body?: any }> = [];
    let fail = false;
    const srv = createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => {
        reqs.push({ method: req.method!, url: req.url!, type: req.headers['content-type'], body: raw ? JSON.parse(raw) : undefined });
        res.setHeader('content-type', 'application/json');
        if (req.method === 'GET') return void res.end(JSON.stringify({ items: [{ metadata: { name: 'gw', namespace: 'ns1', uid: 'u-9', generation: 3 }, spec: { replicas: 2 } }] }));
        if (fail && req.url!.includes('/deployments/')) return void ((res.statusCode = 422), res.end(JSON.stringify({ message: 'invalid' })));
        res.end('{}');
      });
    });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
    const api = httpApi(`http://127.0.0.1:${(srv.address() as { port: number }).port}`, () => 'tok');
    const op = new K8sOperator(api, { namespace: 'ns1' });
    const [r] = await op.reconcileAll();
    expect(r).toEqual({ namespace: 'ns1', name: 'gw', applied: ['ConfigMap/gw', 'Deployment/gw', 'Service/gw', 'PodDisruptionBudget/gw'] });
    expect(reqs[0]!.url).toBe('/apis/mcp-gateway.dev/v1alpha1/namespaces/ns1/mcpgateways');
    const dep = reqs.find((x) => x.url.startsWith('/apis/apps/v1/namespaces/ns1/deployments/gw'))!;
    expect(dep.method).toBe('PATCH');
    expect(dep.type).toBe('application/apply-patch+yaml');
    expect(dep.url).toContain('fieldManager=mcp-gateway-operator&force=true');
    expect(reqs.some((x) => x.url.startsWith('/api/v1/namespaces/ns1/configmaps/gw'))).toBe(true);
    expect(reqs.some((x) => x.url.startsWith('/apis/policy/v1/namespaces/ns1/poddisruptionbudgets/gw'))).toBe(true);
    const st = reqs.find((x) => x.url.includes('/mcpgateways/gw/status'))!;
    expect(st.body.status).toMatchObject({ observedGeneration: 3, phase: 'Ready', conditions: [{ type: 'Ready', status: 'True' }] });
    fail = true;
    reqs.length = 0;
    const [bad] = await op.reconcileAll();
    expect(bad!.error).toMatch(/Deployment\/gw: HTTP 422 invalid/);
    expect(reqs.find((x) => x.url.includes('/status'))!.body.status.phase).toBe('Error');
    await new Promise<void>((r) => srv.close(() => r()));
    expect(() => inClusterApi({})).toThrow(/not running in a cluster/);
    expect(inClusterApi({ KUBERNETES_SERVICE_HOST: '10.0.0.1' }, '/nonexistent')).toBeDefined();
  });

  it('ships a CRD and Helm chart that match', () => {
    const crd = parse(readFileSync(new URL('../deploy/crd/mcpgateways.yaml', import.meta.url), 'utf8'));
    expect(crd).toEqual(MCPGATEWAY_CRD);
    const chart = parse(readFileSync(new URL('../deploy/helm/mcp-gateway/Chart.yaml', import.meta.url), 'utf8'));
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    expect(chart.appVersion).toBe(pkg.version);
    expect(chart.version).toBe(pkg.version);
    const values = parse(readFileSync(new URL('../deploy/helm/mcp-gateway/values.yaml', import.meta.url), 'utf8'));
    expect(values.operator.enabled).toBe(false);
    expect(values.config).toBeTypeOf('object');
  });

  it('admin API renders manifests for this gateway without API keys', async () => {
    h = await startFeatureGw({});
    const r = await h.admin('k8s/manifests?namespace=prod&replicas=3&secret=gw-keys');
    expect(r.status).toBe(200);
    expect(r.body.items.map((m: any) => m.kind)).toEqual(['ConfigMap', 'Deployment', 'Service', 'PodDisruptionBudget']);
    const cm = r.body.items[0].data['mcp-gateway.yml'] as string;
    expect(cm).not.toContain('scoped');
    expect(parse(cm).servers[0].id).toBe('fake');
    expect(r.body.items[1].spec.replicas).toBe(3);
    const y = await fetch(`${h.base}/api/v1/admin/k8s/manifests?format=yaml`, { headers: { authorization: 'Bearer op' } });
    expect(y.headers.get('content-type')).toMatch(/yaml/);
    expect((await y.text()).split('---\n')).toHaveLength(3);
    expect((await h.admin('k8s/manifests?name=Bad_Name')).status).toBe(400);
    expect((await h.admin('k8s/crd')).body.spec.names.kind).toBe('McpGateway');
  });
});
