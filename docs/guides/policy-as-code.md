# Policy as code and SIEM export

## Policy files

Keep tool policy in version-controlled files next to the config and test it in CI.

```yaml
# mcp-gateway.yml
policy:
  rules:                      # inline rules are evaluated first
    - name: admins
      effect: allow
      clients: ["key:admin"]
  files:                      # then each file, in order (paths relative to this config)
    - policies/base.yaml
    - policies/deploy.json
```

```yaml
# policies/base.yaml
version: 1
default: deny                 # used when the inline policy sets no default (last file wins)
rules:
  - name: fs-read
    effect: allow
    tools: ["fs/read_*"]
    args: [{ path: path, under: ["/data"] }]
tests:
  - name: reads inside /data are allowed
    call: { client: "key:app", server: fs, tool: read_file, args: { path: /data/a.txt } }
    expect: allow
    rule: fs-read             # optional: also assert which rule decided
  - call: { server: fs, tool: read_file, args: { path: /etc/passwd } }
    expect: deny
```

A file may also be a plain list of rules (YAML or JSON). Unnamed rules are named `<file>#<n>`. Rule syntax is the same
as inline `policy.rules` (see [configuration](../configuration.md#tool-policy)). Files are re-read on every config
reload (file change or `SIGHUP`); an invalid file rejects the reload and keeps the running policy.

### Testing

```bash
mcp-gateway policy test -c mcp-gateway.yml          # ✓ / ✗ per test, exit 1 on failure
mcp-gateway policy test -c mcp-gateway.yml --json   # machine-readable
```

## Audit export to a SIEM

`audit.export` forwards every request record (the same metadata as the audit log, never arguments or results) to
syslog and / or HTTP webhooks. It works with or without the SQLite audit store. Restart required.

```yaml
audit:
  export:
    - type: syslog            # RFC 5424, structured data [mcpgw@32473 …] + JSON message
      host: siem.internal
      port: 6514
      protocol: tls           # udp (default) | tcp | tls (TCP uses RFC 6587 octet counting)
      facility: local0
      appName: mcp-gateway
    - type: webhook           # Splunk HEC, Elastic, Datadog, a Vector / Fluent Bit collector …
      url: https://siem.example.com/ingest
      headers: { Authorization: "Splunk ${HEC_TOKEN}" }
      format: ndjson          # json (default: {"events": [...]}) | ndjson
      batchSize: 100
      flushIntervalMs: 1000
      retries: 2
      failuresOnly: false
      kinds: [tool, resource, prompt]
```

Exported event:

```json
{ "@timestamp": "2026-10-07T12:00:00.000Z", "event": "mcp_gateway.request", "id": "…", "server": "github",
  "name": "search_issues", "kind": "tool", "via": "mcp", "client": "key:aura", "success": true, "durationMs": 84,
  "host": "gw-1" }
```

Export never blocks a request: records are queued (`maxQueue`, default 10000, oldest dropped) and sent in the
background with exponential-backoff retries. Syslog severity is `info` for successes and `warning` for failures.
