# mcp-gateway documentation

Start with the project README: [English](../README.md) · [简体中文](../README.zh-CN.md)

| | |
|---|---|
| [Getting started](guides/getting-started.md) | first gateway in five minutes |
| [Configuration reference](configuration.md) | every config key, env overrides, scopes, hot reload |
| [Deprecations](deprecations.md) | fields scheduled for removal, runtime warnings and how to silence them; schema v12 inventory (13.9) |
| [Config schema v12 design (draft)](design/schema-v12.md) | what 14.0 changes: unified module lifecycle, capabilities, migration preview |
| [API reference](api-reference.md) | REST `/api/v1`, MCP endpoint `/mcp`, errors, **stability & versioning policy** |
| [Deployment guide](deployment.md) | Docker / ghcr.io image, Kubernetes, reverse proxy, security checklist, systemd |
| [Guides](guides) | one page per feature module, plus migration guides |
| [Security](../SECURITY.md) | supported versions, advisories, hardening |
| [Threat model](security/threat-model.md) · [Supply chain](security/supply-chain.md) · [stdio isolation](security/stdio-isolation.md) · [Incident response](security/incident-response.md) | security documentation |
| [Remote servers](guides/remote-servers.md) | Streamable HTTP, SSE and WebSocket upstreams, reconnect |
| [Client compatibility](guides/client-compatibility.md) | MCP client × revision test matrix (13.6), negotiation rules, Motionary E2E |
| [Benchmarks](benchmarks.md) | kernel and gateway benchmarks |
| [Roadmap](ROADMAP.md) | release plan (in Chinese) |
| [Contributing](CONTRIBUTING.md) | development workflow |

Client libraries: [TypeScript](../clients/js/README.md) · [Kotlin / Android](../clients/kotlin/README.md) ·
[Swift](../clients/swift/README.md) · [Python](../clients/python/README.md) · [Go](../clients/go/README.md)
