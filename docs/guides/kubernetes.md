# Kubernetes: Helm chart and operator (6.8)

Three ways to run mcp-gateway on Kubernetes, from simplest to most automated.

## 1. Helm chart

An API key is **required** since chart 10.3.0 — the chart fails at template / install time without one (see the
[chart README](../../deploy/helm/mcp-gateway/README.md) for the exact message and the alternatives):

```bash
kubectl create secret generic gw-secrets --from-literal=MCP_GATEWAY_API_KEYS=sha256:<hash from gen-key>
helm install gw ./deploy/helm/mcp-gateway \
  --set existingSecret=gw-secrets \
  --set-file config=./my-values-config.yaml    # or edit `config:` in values.yaml
```

| Value | Default | |
|-------|---------|---|
| `config` | `{ version: 11, monitor: { prometheus: true }, servers: [] }` | The gateway config (rendered into a ConfigMap) |
| `existingSecret` | `""` | Secret with env vars — put `MCP_GATEWAY_API_KEYS` and upstream tokens here (required unless one of the next rows applies) |
| `apiKeys` | `[]` | Alternative: keys rendered into a chart-managed Secret (prefer `sha256:` digests) |
| `security.insecure` | `false` | Opt out: start with `--insecure`, **no auth** — trusted networks only; NOTES print a warning |
| `replicaCount`, `resources`, `nodeSelector`, `tolerations`, `affinity` | | Usual knobs |
| `autoscaling.enabled` | `false` | HPA on CPU (`minReplicas`, `maxReplicas`, `targetCPUUtilizationPercentage`) |
| `podDisruptionBudget.enabled` | `false` | PDB with `minAvailable` |
| `serviceMonitor.enabled` | `false` | Prometheus Operator `ServiceMonitor` |
| `operator.enabled` | `false` | Also deploy the operator with RBAC (`watchNamespace` limits it to one namespace) |

Pods run as non-root with a read-only root filesystem (`/tmp` is an `emptyDir`) and carry a config-hash annotation,
so a config change rolls the Deployment. CI lints and renders the chart (`.github/workflows/helm.yml`).

## 2. Operator

Install the CRD, then the operator (`--set operator.enabled=true`, or run `mcp-gateway operator` with a service
account), and declare gateways as resources:

```bash
kubectl apply -f deploy/crd/mcpgateways.yaml
```

```yaml
apiVersion: mcp-gateway.dev/v1alpha1
kind: McpGateway
metadata: { name: tools, namespace: team-a }
spec:
  replicas: 2
  envFromSecret: tools-secrets
  autoscaling: { minReplicas: 2, maxReplicas: 8 }
  serviceMonitor: true
  config:
    version: 11
    servers:
      - { id: github, name: GitHub, transport: stdio, command: npx, args: ["-y", "@modelcontextprotocol/server-github"] }
```

Every `--interval` seconds (default 15) the operator renders a ConfigMap, Deployment, Service, PodDisruptionBudget
(when more than one replica) and optional HPA / ServiceMonitor, applies them with **server-side apply** (field
manager `mcp-gateway-operator`, owned by the McpGateway so deleting it cleans up), and writes `status`:
`phase` (`Ready` / `Error`), `observedGeneration`, `configHash`, and a `Ready` condition. `kubectl get mgw` shows
replicas and phase. `mcp-gateway operator --once` reconciles once and prints the result.

## 3. Manifests from a running gateway

`GET /api/v1/admin/k8s/manifests?namespace=prod&replicas=3&secret=gw-secrets&format=yaml` renders manifests for the
gateway's current config. API keys are never rendered into the ConfigMap — keep them in the Secret.

> Since 10.3 a gateway with `auth.strategy: none` refuses to start on a non-loopback address. Manifests rendered by
> the operator or this endpoint bind `0.0.0.0`, so give them a Secret with `MCP_GATEWAY_API_KEYS`
> (`envFromSecret` / `?secret=`) or an `auth` block, or set `security.insecure: true` in the config.
