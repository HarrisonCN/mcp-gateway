# mcp-gateway Helm chart

Deploys [mcp-gateway](https://github.com/HarrisonCN/mcp-gateway) (Deployment, Service, ConfigMap, optional HPA, PDB,
ServiceMonitor and operator). The chart lives in the repository; it is not published to a chart registry.

## An API key is required (chart 10.3.0+)

The gateway listens on `0.0.0.0` inside the pod, and since 10.3 it refuses to start there without authentication.
The chart therefore **fails at `helm template` / `helm install` time** unless authentication is provided:

```bash
npx @winstonsayno/mcp-gateway gen-key            # key: mgw_… (give to clients)   hash: sha256:… (store this)
kubectl create secret generic gw-secrets \
  --from-literal=MCP_GATEWAY_API_KEYS=sha256:<hash> \
  --from-literal=GITHUB_TOKEN=<upstream token, if your servers need one>
helm install gw ./deploy/helm/mcp-gateway --set existingSecret=gw-secrets
```

Without it you get:

```
Error: execution error at (mcp-gateway/templates/deployment.yaml:1:4):

mcp-gateway: an API key is required (chart >= 10.3.0).
Create a Secret containing MCP_GATEWAY_API_KEYS and pass it as existingSecret:
  kubectl create secret generic gw-secrets --from-literal=MCP_GATEWAY_API_KEYS=<key>
  helm install <release> ./deploy/helm/mcp-gateway --set existingSecret=gw-secrets
Alternatives: --set apiKeys={<key>} (chart-managed Secret) or config.auth (e.g. jwt).
To run WITHOUT authentication on a trusted network only: --set security.insecure=true
```

| Way to provide auth | Values | Notes |
|---|---|---|
| Existing Secret (recommended) | `existingSecret: gw-secrets` | Every key of the Secret becomes an env var; `MCP_GATEWAY_API_KEYS` (comma-separated, plain or `sha256:` digests) turns on API-key auth. The chart can't look inside the Secret: if `MCP_GATEWAY_API_KEYS` is missing the pod exits with `Refusing to start: authentication is disabled …`. |
| Chart-managed Secret | `apiKeys: ["sha256:…"]` | Renders `<release>-mcp-gateway-api-keys`. Values are stored in the Helm release, so use digests. |
| Gateway config | `config.auth.strategy: jwt` (etc.) | Any strategy other than `none`; also `config.controlPlane.role: data` (auth comes from the control plane). |
| **Opt out** | `security.insecure: true` | Starts the gateway with `--insecure`: **no authentication**. Only for a trusted, isolated network; `helm install` prints a loud warning. |

## Values

| Value | Default | |
|-------|---------|---|
| `config` | `{ version: 10, monitor: { prometheus: true }, servers: [] }` | Gateway config, rendered into a ConfigMap (`host` / `port` are set by the chart). Never put API keys here. |
| `existingSecret` | `""` | Secret with env vars: `MCP_GATEWAY_API_KEYS`, upstream tokens |
| `apiKeys` | `[]` | Keys for a chart-managed Secret (`MCP_GATEWAY_API_KEYS`) |
| `security.insecure` | `false` | Run without auth (`--insecure`) |
| `image.repository` / `image.tag` | `ghcr.io/harrisoncn/mcp-gateway` / appVersion | |
| `port`, `service.type`, `service.port` | `4000`, `ClusterIP`, `80` | |
| `replicaCount`, `resources`, `nodeSelector`, `tolerations`, `affinity` | | Usual knobs |
| `autoscaling.enabled` | `false` | HPA on CPU |
| `podDisruptionBudget.enabled` | `false` | PDB with `minAvailable` |
| `serviceMonitor.enabled` | `false` | Prometheus Operator `ServiceMonitor` |
| `operator.enabled` | `false` | Also deploy the `McpGateway` operator with RBAC |

## Upgrading from chart ≤ 10.2

A release installed without `existingSecret` (or with a Secret lacking `MCP_GATEWAY_API_KEYS`) ran an
unauthenticated gateway. `helm upgrade` to 10.3.0 now fails with the message above. Create the Secret and pass
`--set existingSecret=…` (recommended), or keep the old behaviour explicitly with `--set security.insecure=true`.
