# Deployment guide

Every example on this page is a file in [`examples/deploy/`](../examples/deploy) that CI boots on each change
([`deploy-examples.yml`](../.github/workflows/deploy-examples.yml): `docker compose up` and a kind cluster with the
plain manifests and the Helm chart), so what you copy here is known to start.

## Images and tags

Images are published to GitHub Container Registry for every release (`linux/amd64`, `linux/arm64`), signed with
cosign (keyless, GitHub Actions identity) and shipped with an SBOM:

```
ghcr.io/harrisoncn/mcp-gateway:13.7.0   # exact release — immutable, use this (or a digest) in production
ghcr.io/harrisoncn/mcp-gateway:13.7     # latest patch of 13.4
ghcr.io/harrisoncn/mcp-gateway:13       # latest 13.x (current line, config schema v11)
ghcr.io/harrisoncn/mcp-gateway:latest   # newest release of the current line
ghcr.io/harrisoncn/mcp-gateway:12.0     # 12.0.x security maintenance line (npm dist-tag v12-0)
ghcr.io/harrisoncn/mcp-gateway:10       # 10.x LTS line (npm dist-tag v10-lts, config schema v10)
```

Which tag to use:

- **Production**: pin the exact release, or better its digest, and update deliberately. A digest pin cannot change
  under you even if a tag is moved:

  ```bash
  docker buildx imagetools inspect ghcr.io/harrisoncn/mcp-gateway:13.7.0 --format '{{json .Manifest.Digest}}'
  # → use ghcr.io/harrisoncn/mcp-gateway@sha256:<digest> (or 13.4.0@sha256:<digest> to keep the version readable)
  cosign verify ghcr.io/harrisoncn/mcp-gateway@sha256:<digest> \
    --certificate-identity-regexp '^https://github.com/HarrisonCN/mcp-gateway/.github/workflows/docker.yml@refs/tags/v' \
    --certificate-oidc-issuer https://token.actions.githubusercontent.com
  ```

- **Staging / evaluation**: `:13` (or `:13.4`) follows patch and minor releases of the current line.
- `:latest` moves to a new major line when one ships (breaking config changes): never use it in production.
- Release digests are listed in each GitHub release and in [SECURITY.md](../SECURITY.md#supported-versions) lists
  which lines receive fixes. See [supply-chain security](security/supply-chain.md) for signatures and SBOMs.

## Docker

```bash
docker run -d --name mcp-gateway -p 4000:4000 \
  -v "$PWD/mcp-gateway.yml:/app/mcp-gateway.yml:ro" \
  -v mcp-gateway-data:/app/data \
  -e MCP_GATEWAY_API_KEYS="$(openssl rand -hex 24)" \
  -e GITHUB_TOKEN \
  ghcr.io/harrisoncn/mcp-gateway:13.7.0
```

- The image runs as the unprivileged `node` user, listens on `4000`, and has a `HEALTHCHECK` on the always-public
  `/api/v1/health/live`. Its entrypoint is `mcp-gateway`; the default command `start` reads `/app/mcp-gateway.yml`.
- `/app/data` is a writable directory for the audit log (`audit.path: /app/data/audit.db`) and file-based stores.
- `stdio` servers run **inside** the container: the image contains Node.js/npm (so `npx` servers work); install
  anything else (Python, `uvx`, …) in a derived image:

  ```dockerfile
  FROM ghcr.io/harrisoncn/mcp-gateway:13.7.0
  USER root
  RUN apk add --no-cache python3 py3-pip && pip install --break-system-packages uv
  USER node
  ```

- Config hot reload works with a bind-mounted file (the gateway watches it).
- Build locally: `docker build -t mcp-gateway .`

### Docker Compose

[`examples/deploy/compose/docker-compose.yml`](../examples/deploy/compose/docker-compose.yml) runs the gateway with
the config [`examples/deploy/compose/mcp-gateway.yml`](../examples/deploy/compose/mcp-gateway.yml) and a small example
stdio server; replace the `servers` list with your own.

```bash
cd examples/deploy/compose
export GATEWAY_API_KEY="$(openssl rand -hex 24)"
docker compose up -d --wait
curl -s -H "Authorization: Bearer $GATEWAY_API_KEY" http://localhost:4000/api/v1/tools
curl -s -X POST -H "Authorization: Bearer $GATEWAY_API_KEY" -H 'content-type: application/json' \
  -d '{"server":"echo","tool":"echo","arguments":{"hello":"world"}}' http://localhost:4000/api/v1/tools/call
```

The Compose file uses `${MGW_IMAGE:-ghcr.io/harrisoncn/mcp-gateway:13}`: set `MGW_IMAGE` to an exact release or digest
to pin it. [`examples/docker/`](../examples/docker) has a larger setup with Prometheus and a Postgres MCP server.

## Kubernetes

### Helm

The chart in [`deploy/helm/mcp-gateway`](../deploy/helm/mcp-gateway) (see also [guides/kubernetes.md](guides/kubernetes.md)
for the operator) deploys the image of its `appVersion` — the release it was published with. It requires an API key
(since 10.3): put `MCP_GATEWAY_API_KEYS` in a Secret and pass it as `existingSecret`.
[`examples/deploy/helm/values.yaml`](../examples/deploy/helm/values.yaml) is a complete values file:

```bash
kubectl create secret generic gw-secrets --from-literal=MCP_GATEWAY_API_KEYS="$(openssl rand -hex 24)"
helm install gw ./deploy/helm/mcp-gateway -f examples/deploy/helm/values.yaml
kubectl rollout status deployment/gw-mcp-gateway
```

Pin by digest with `--set image.tag=13.4.0@sha256:<digest>`. The gateway itself refuses to start on `0.0.0.0` without
auth, so keep the Secret (or an `auth` block in `config`), or opt out explicitly with `security.insecure: true` on a
trusted network.

### Plain manifests

[`examples/deploy/kubernetes/mcp-gateway.yaml`](../examples/deploy/kubernetes/mcp-gateway.yaml) contains a Secret
(placeholder — create a real one), a ConfigMap with the gateway config, a hardened Deployment (non-root, read-only root
filesystem, no capabilities, liveness / readiness probes) and a Service:

```bash
kubectl create secret generic mcp-gateway --from-literal=MCP_GATEWAY_API_KEYS="$(openssl rand -hex 24)"
kubectl apply -f examples/deploy/kubernetes/mcp-gateway.yaml   # after deleting its placeholder Secret document
kubectl rollout status deployment/mcp-gateway
```

The essential parts of the Deployment:

```yaml
containers:
  - name: mcp-gateway
    image: ghcr.io/harrisoncn/mcp-gateway:13.7.0   # or @sha256:<digest>
    args: ["start", "-c", "/config/mcp-gateway.yml", "--no-watch"]
    ports: [{ name: http, containerPort: 4000 }]
    envFrom: [{ secretRef: { name: mcp-gateway } }]
    livenessProbe: { httpGet: { path: /api/v1/health/live, port: http } }
    readinessProbe: { httpGet: { path: /api/v1/health/ready, port: http } }   # add ?min=N if some servers are optional
```

Notes:

- **Config reload**: the example passes `--no-watch` and expects a rollout on config changes (config-hash
  annotation or `kubectl rollout restart`). Without `--no-watch`, ConfigMap updates reach the mounted file after the kubelet sync period (Kubernetes swaps a
  symlink; the watcher re-attaches on rename events). If an update is not picked up in your setup, use
  `kubectl rollout restart deployment/mcp-gateway`, or a config-hash annotation so changes roll the pods.
- **Readiness** answers `503` while upstream servers are still connecting and during shutdown (SIGTERM →
  `shutting_down`), so rolling updates drain cleanly.
- **Replicas**: rate limits, `/mcp` sessions and in-memory history are per instance. With more than one replica,
  use session affinity for `/mcp` (MCP sessions live in one process) — e.g. an Ingress with cookie or
  `Mcp-Session-Id`-header hashing — and expect per-replica rate limits. stdio servers are started in every replica.
- **Audit log**: SQLite is single-node. Mount a `PersistentVolumeClaim` at `/app/data` and keep `replicas: 1`, or
  leave `audit` off and ship logs elsewhere.
- **Ingress / proxies** in front of `/mcp` must not buffer `text/event-stream` (e.g. nginx
  `proxy_buffering off;`, generous `proxy_read_timeout`). The gateway sends `X-Accel-Buffering: no` and SSE
  keep-alives every 25 s.

## Multiple instances (horizontal scaling)

Run several replicas behind a load balancer and point them at one Redis:

```yaml
store:
  backend: redis
  redis: { url: "redis://redis:6379" }
```

A single instance can keep the same state across restarts without Redis: `store: { backend: eventlog }` (9.0).

Rate limits, auth lockouts and MCP session metadata are then shared (see *Shared state* in the configuration
reference). Each replica connects to the upstream MCP servers itself. The `GET /mcp` notification stream is served by
the replica that accepted it; clients reconnect with `Last-Event-ID` after a failover. `/api/v1/health` reports
`"state": "redis"`.

What holds across replicas (13.7.0, verified in CI against a real Redis with injected faults — job *Multi-instance
reliability (real Redis)*, `test/multi-instance-13-7-0.test.ts`):

| Behaviour | Guarantee |
|---|---|
| MCP session opened on replica A, next request on B | B adopts it from the store (same client only) |
| Session terminated (`DELETE /mcp`) on A | rejected (404) on every replica within 1 s; a refresh elsewhere cannot re-create it |
| Redis restarted without persistence / failover | live sessions keep working; the replica that holds one re-publishes it on its next request (≤ 1 s) |
| Agent-token revoked on A | rejected on every replica from the next call (no caching of "not revoked") |
| Replica cut off from Redis | revocation checks fail closed (503) by default; once healed the replica answers from the store after the 1 s breaker cooldown |
| Rate limits | one limit across all replicas, also under concurrent bursts (denied requests are not counted) |
| `notifications/cancelled` arrives on another replica | the replica running the request stops it within ~250 ms |
| Progress / result of a request | stay on the HTTP response of the replica that accepted the request |

Not shared: the `Last-Event-ID` replay buffer of a `GET /mcp` stream (per replica). Run Redis with persistence
(`appendonly yes`) if revocations must survive a Redis restart: without it a restart forgets them.

## Behind a reverse proxy

```nginx
location / {
  proxy_pass http://127.0.0.1:4000;
  proxy_http_version 1.1;
  proxy_set_header Host $host;
  proxy_set_header Connection "";
  proxy_buffering off;          # SSE on GET /mcp
  proxy_read_timeout 1h;
}
```

## Security checklist

- Enable `auth` (API keys or JWT) whenever the gateway is reachable from anything but localhost; give each app its own
  scoped key. Since 10.3 this is enforced: without auth the gateway starts only on a loopback address, unless you pass
  `--insecure` (`security.insecure: true`).
- Browser and mobile apps: never embed a long-lived key — proxy through your backend or issue short-lived scoped JWTs
  (`auth.jwt.requireExp`, `maxTokenAgeSeconds`, `mcp_servers` / `mcp_tools` claims) and list origins in `cors.origins`.
- Set `cors.origins` / `mcp.allowedOrigins` to the browser origins that may call the gateway (DNS-rebinding
  protection for `/mcp`).
- Store API keys as digests (`mcp-gateway gen-key` / `hash-key` → `sha256:…`), give keys an `expiresAt`, and
  rotate by adding the new key before removing the old one (hot reload).
- For JWT, set `auth.jwt.issuer`, `audience` and `requireExp`; prefer `jwksUrl` / `publicKey` over a shared secret.
- Turn on `security.authLockout` against key guessing.
- Behind a reverse proxy set `security.trustProxy` to the proxy's address (not `true`) so `req.ip`, rate limits,
  lockout and `ipAllowlist` see real client addresses; add `security.hsts: true` when TLS terminates there.
- Restrict who can connect: `security.ipAllowlist` (CIDRs) and `security.allowedHosts` (your public hostname).
- A local gateway without auth: bind it to `127.0.0.1` — since 10.2 `security.dnsRebindingProtection` is then on by default (Host + Origin checks, loopback-only CORS).
- Cap payloads with `security.maxBodyBytes` / `maxToolArgumentsBytes`.
- Keep secrets in the environment (`${VAR}`), not in the config file; `/servers` redacts env / header values and
  secret-looking args, and logs / the request log mask token-shaped strings (add your own with
  `security.redactPatterns`).
- Consider `auth.protect.metrics` if metrics labels (server ids, tool names) are sensitive.
- Terminate TLS at a proxy / Ingress.
- Run `mcp-gateway validate --strict` in CI to fail on security warnings, and check `GET /api/v1/security`.

## npm / systemd

```bash
npm install -g @winstonsayno/mcp-gateway
mcp-gateway init && mcp-gateway start
```

```ini
# /etc/systemd/system/mcp-gateway.service
[Unit]
Description=mcp-gateway
After=network-online.target

[Service]
User=mcp
WorkingDirectory=/opt/mcp-gateway
EnvironmentFile=/opt/mcp-gateway/.env
ExecStart=/usr/bin/env mcp-gateway start -c /opt/mcp-gateway/mcp-gateway.yml
Restart=on-failure
KillSignal=SIGTERM

[Install]
WantedBy=multi-user.target
```
