# Deployment guide

## Docker

Images are published to GitHub Container Registry for every release
(`linux/amd64`, `linux/arm64`):

```
ghcr.io/harrisoncn/mcp-gateway:1.0.0   # exact version
ghcr.io/harrisoncn/mcp-gateway:1.0     # latest patch of 1.0
ghcr.io/harrisoncn/mcp-gateway:1       # latest 1.x
ghcr.io/harrisoncn/mcp-gateway:latest
```

```bash
docker run -d --name mcp-gateway -p 4000:4000 \
  -v "$PWD/mcp-gateway.yml:/app/mcp-gateway.yml:ro" \
  -v mcp-gateway-data:/app/data \
  -e MCP_GATEWAY_API_KEYS=change-me \
  -e GITHUB_TOKEN \
  ghcr.io/harrisoncn/mcp-gateway:1
```

- The image runs as the unprivileged `node` user, listens on `4000`, and has a `HEALTHCHECK` on the always-public
  `/api/v1/health/live`.
- `/app/data` is a writable directory for the audit log (`audit.path: /app/data/audit.db`).
- `stdio` servers run **inside** the container: the image contains Node.js/npm (so `npx` servers work); install
  anything else (Python, `uvx`, …) in a derived image:

  ```dockerfile
  FROM ghcr.io/harrisoncn/mcp-gateway:1
  USER root
  RUN apk add --no-cache python3 py3-pip && pip install --break-system-packages uv
  USER node
  ```

- Config hot reload works with a bind-mounted file (the gateway watches it).
- Build locally: `docker build -t mcp-gateway .`

### Docker Compose

`examples/docker/` contains a Compose file with the gateway and Prometheus:

```bash
cd examples/docker
GATEWAY_API_KEY=change-me docker compose up
```

## Kubernetes

```yaml
apiVersion: v1
kind: Secret
metadata: { name: mcp-gateway }
stringData:
  MCP_GATEWAY_API_KEYS: change-me
  GITHUB_TOKEN: ghp_xxx
---
apiVersion: v1
kind: ConfigMap
metadata: { name: mcp-gateway }
data:
  mcp-gateway.yml: |
    port: 4000
    monitor: { prometheus: true }
    mcp: { allowedOrigins: ["https://app.example.com"] }
    servers:
      - id: github
        name: GitHub
        transport: stdio
        command: npx
        args: ["-y", "@modelcontextprotocol/server-github"]
        env: { GITHUB_PERSONAL_ACCESS_TOKEN: "${GITHUB_TOKEN}" }
---
apiVersion: apps/v1
kind: Deployment
metadata: { name: mcp-gateway }
spec:
  replicas: 1
  selector: { matchLabels: { app: mcp-gateway } }
  template:
    metadata:
      labels: { app: mcp-gateway }
      annotations: { prometheus.io/scrape: "true", prometheus.io/port: "4000", prometheus.io/path: /api/v1/metrics }
    spec:
      securityContext: { runAsNonRoot: true, runAsUser: 1000, fsGroup: 1000 }
      containers:
        - name: mcp-gateway
          image: ghcr.io/harrisoncn/mcp-gateway:1
          args: ["start", "-c", "/config/mcp-gateway.yml"]
          ports: [{ name: http, containerPort: 4000 }]
          envFrom: [{ secretRef: { name: mcp-gateway } }]
          volumeMounts: [{ name: config, mountPath: /config, readOnly: true }]
          livenessProbe:
            httpGet: { path: /api/v1/health/live, port: http }
            periodSeconds: 10
          readinessProbe:
            httpGet: { path: /api/v1/health/ready, port: http }   # add ?min=N if some servers are optional
            periodSeconds: 5
          resources:
            requests: { cpu: 100m, memory: 128Mi }
            limits: { memory: 512Mi }
      terminationGracePeriodSeconds: 30
      volumes:
        - name: config
          configMap: { name: mcp-gateway }
---
apiVersion: v1
kind: Service
metadata: { name: mcp-gateway }
spec:
  selector: { app: mcp-gateway }
  ports: [{ name: http, port: 80, targetPort: http }]
```

Notes:

- **Config reload**: ConfigMap updates reach the mounted file after the kubelet sync period (Kubernetes swaps a
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
  scoped key.
- Set `corsOrigins` / `mcp.allowedOrigins` to the browser origins that may call the gateway (DNS-rebinding
  protection for `/mcp`).
- Keep secrets in the environment (`${VAR}`), not in the config file; `/servers` redacts env / header values.
- Consider `auth.protect.metrics` if metrics labels (server ids, tool names) are sensitive.
- Terminate TLS at a proxy / Ingress.

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
