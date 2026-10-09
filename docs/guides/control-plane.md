# Control plane / data plane (7.0)

From 7.0 a gateway runs in one of three roles, set with `controlPlane.role`:

| Role | Serves | Config comes from |
|------|--------|-------------------|
| `all` (default) | everything — tool traffic, admin API, dashboard (what every 6.x gateway was) | its own file |
| `control` | admin API, dashboard, **config distribution** to data planes (and tool traffic, if you send it some) | its own file / the admin API |
| `data` | tool traffic only (`/mcp`, `/api/v1/tools/call`, bridges) | pulled from the control plane |

Run one control plane and as many data planes as you need behind a load balancer. You edit the config in one place
(file, `mcp-gateway apply`, the dashboard's Config tab); every data plane picks it up within `pullIntervalMs`.

## Control plane

```yaml
version: 10
controlPlane:
  role: control
  configApi: true # optional: edit the config over the admin API / dashboard
auth:
  strategy: api-key
  apiKeys:
    - ${OPERATOR_KEY} # unscoped = operator; data planes authenticate with it
servers:
  - {id: github, name: GitHub, transport: streamable-http, url: https://api.githubcopilot.com/mcp/}
```

| Endpoint | |
|----------|---|
| `GET /api/v1/admin/data-planes` | data planes: `lastSeen`, `configEtag`, `inSync`, `status` (`online` / `stale` after 3 missed intervals), servers online, last error; plus a summary |
| `GET /api/v1/admin/data-planes/config` | the config data planes run, with an `ETag`; `If-None-Match` → `304` |
| `POST /api/v1/admin/data-planes/heartbeat` | `{ nodeId, configEtag, version, pullIntervalMs, servers }` → `{ ok, configEtag, inSync }` |
| `DELETE /api/v1/admin/data-planes/:nodeId` | forget a data plane |

The distributed config is the running config **without** `controlPlane`, `port` and `host` (each data plane keeps
its own). It contains secrets (API keys, upstream headers), so it is only served to operators of a gateway with
`role: control` — an `all` gateway answers `409`.

## Data plane

```yaml
version: 10
port: 4000
controlPlane:
  role: data
  url: https://cp.internal:4000
  token: ${OPERATOR_KEY} # an operator API key of the control plane
  pullIntervalMs: 10000 # default; min 1000
  nodeId: dp-eu-1 # default: <hostname>-<random>
```

- **Fail closed:** until the first config has been pulled and applied, every route except `/`, `/api/v1/health`,
  `/api/v1/health/live` and `/api/v1/data-plane` answers `503` (`/api/v1/health/ready` too, so Kubernetes keeps the
  pod out of the Service).
- **Hot apply:** a changed config (new `ETag`) is validated and applied like `PUT /admin/config` — restart-only
  fields (`health`, `audit`, `store`, `observability`) are reported, not applied. An invalid config or an
  unreachable control plane keeps the current config; the error is shown on both sides.
- **No admin API:** `/api/v1/admin/*` answers `403` with the control plane URL.
- `GET /api/v1/data-plane` (operators) shows the sync state: `ready`, `configEtag`, `lastPullAt`, `lastAppliedAt`,
  `lastHeartbeatAt`, `lastError`, `pulls` / `applied` / `failures`.

## Kubernetes

Deploy the control plane as a single-replica Deployment (or the `McpGateway` operator with `replicas: 1`) and the data
planes with the Helm chart, passing the data-plane `controlPlane` block in `config` and the key in `existingSecret`.

## Compared with edge sync (4.8)

Edge gateways (`@winstonsayno/mcp-gateway/edge`) pull a reduced *edge snapshot*; data planes are full Node gateways
and run the complete config (policy, DLP, quotas, plugins…).
