<div align="center">

# mcp-gateway

**轻量级、开源的 MCP 服务器统一网关。**

路由 · 鉴权 · 限流 · 监控 — 用一个端点管理所有 [MCP](https://modelcontextprotocol.io) 服务器。

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](../LICENSE)
[![Node.js](https://img.shields.io/badge/node-%3E%3D20.0.0-brightgreen.svg)](https://nodejs.org)

[English](../README.md) · **中文** · [文档](.) · [示例](../examples/)

</div>

---

## 为什么需要 mcp-gateway？

随着 [MCP（模型上下文协议）](https://modelcontextprotocol.io) 成为 AI Agent 与工具交互的事实标准，团队往往需要同时运行十几个 MCP 服务器——文件系统、GitHub、数据库、Slack、搜索等等。管理这些服务器非常混乱：

- 每个 AI 客户端需要独立连接每个服务器
- 没有统一的鉴权和访问控制
- 无法看到哪些工具被调用了、被谁调用、调用了多少次
- 没有限流保护，失控的 Agent 可能打垮你的 API

**mcp-gateway 解决了这些问题。** 它作为一个单一的、可观测的、安全的入口，位于你的 AI 客户端和 MCP 服务器之间。

## 快速开始

### 安装

```bash
npm install -g @winstonsayno/mcp-gateway
```

### 初始化配置

```bash
mcp-gateway init
# 生成 mcp-gateway.yml 配置文件
```

### 启动

```bash
mcp-gateway start
# → mcp-gateway 监听在 http://0.0.0.0:4000
# → ✓ Filesystem — 8 个工具可用
# → ✓ GitHub — 26 个工具可用
```

### 调用工具

```bash
# 列出所有可用工具
curl http://localhost:4000/api/v1/tools

# 调用工具（自动路由到正确的服务器）
curl -X POST http://localhost:4000/api/v1/tools/call \
  -H "Content-Type: application/json" \
  -d '{"tool": "read_file", "arguments": {"path": "/tmp/hello.txt"}}'
```

## 核心功能

| 功能 | 说明 |
|------|------|
| **统一 API 端点** | 一个 URL 访问所有 MCP 工具，按工具名自动路由 |
| **全部 MCP 传输方式** | 上游服务器支持 `stdio`、`streamable-http`（最新规范）、旧版 `sse`（HTTP+SSE）和 `websocket`，可为每个服务器配置请求头用于上游鉴权 |
| **自动重连** | 崩溃或断开的服务器按指数退避 + 随机抖动自动重连，状态可在 `/servers`、`/health`、面板和 Prometheus 中查看 |
| **鉴权** | 支持 API Key（常量时间比较）、JWT（HS256/384/512）或无鉴权模式；配置错误时拒绝启动 |
| **可选保护 health / metrics** | `/health`、`/metrics` 默认公开，可通过 `auth.protect` 要求鉴权；面板支持输入 API Key |
| **限流** | 按 Key 的滑动窗口限流，标准 `X-RateLimit-*` 响应头 |
| **健康监控** | 基于 MCP `ping` 的周期性健康检查（含延迟），间隔可配置 |
| **配置热更新** | 服务器、API Key / 鉴权、限流、CORS、重连策略修改后无需重启即可生效 |
| **指标收集** | 兼容 Prometheus 的 `/metrics` 端点 + JSON 聚合 |
| **工具发现** | `GET /api/v1/tools` 列出所有服务器的所有工具 |
| **YAML 配置** | 简洁的声明式配置，支持环境变量覆盖 |
| **Docker 支持** | 官方 Docker 镜像，附带 Compose 示例 |

## 远程服务器与自动重连

```yaml
reconnect:                    # 自动重连（默认值如下）
  enabled: true
  initialDelayMs: 1000        # 首次重试延迟
  maxDelayMs: 60000           # 退避上限
  multiplier: 2               # 每次失败后延迟乘以该系数
  jitter: 0.2                 # ±20% 随机抖动
  maxAttempts: 0              # 0 = 无限重试；否则放弃并标记为 offline

auth:
  strategy: api-key
  apiKeys: ["your-secret-key"]
  protect:
    health: false             # true → /api/v1/health 需要鉴权（/api/v1/health/live 与 /api/v1/health/ready 始终公开）
    metrics: false            # true → /api/v1/metrics 需要鉴权（需为 Prometheus 配置凭据）

servers:
  - id: remote
    name: 远程服务器
    transport: streamable-http   # MCP 2025-03-26+，支持 Mcp-Session-Id 会话
    url: https://mcp.example.com/mcp
    headers:
      Authorization: "Bearer ${REMOTE_MCP_TOKEN}"   # 从网关环境变量展开 ${VAR}

  - id: legacy
    name: 旧版 SSE 服务器
    transport: sse            # MCP 2024-11-05 HTTP+SSE
    url: http://localhost:8080/sse

  - id: socket
    name: WebSocket 服务器
    transport: websocket      # 每帧一条 JSON-RPC 消息，子协议 "mcp"
    url: ws://localhost:8081
```

服务器状态 `health.status`：`online`（在线）、`degraded`（已连接但健康 ping 失败）、`reconnecting`（连接丢失，正在/即将重试）、`offline`（已放弃或禁用重连）、`unknown`。
`GET /api/v1/servers/:id` 还会返回 `health.reconnect`（`state`、`attempt`、`nextAttemptAt`、`lastError`、`reconnects`）和 `session`（传输方式、协商的协议版本、服务器信息）。
`POST /api/v1/servers/:id/reconnect` 可立即重连并重置退避。

新增 Prometheus 指标：`mcp_gateway_server_up`、`mcp_gateway_server_status`、`mcp_gateway_server_reconnects_total`、`mcp_gateway_server_reconnect_attempt`、`mcp_gateway_server_ping_ms`。

### 热更新

| 立即生效 | 需要重启 |
|----------|----------|
| `servers`（增 / 改 / 删 / 禁用） | `port`、`host` |
| `auth`（策略、API Key、JWT 密钥、`protect`） | `monitor.retentionHours` |
| `rateLimit`（变更时计数器重置） | `healthCheckIntervalMs` |
| `corsOrigins`、`monitor.requestLog`、`monitor.prometheus` | `dashboard` |
| `reconnect`、`logLevel` | |

配置文件无效时会被拒绝，继续使用当前配置。

### 面板

访问 `http://localhost:4000/dashboard`。开启鉴权后，在页头输入 API Key（或 JWT）：默认只保存在当前标签页（`sessionStorage`），勾选 “remember” 则保存在 `localStorage`，并以 `Authorization: Bearer …` 发送给每个 API 请求。设置 `dashboard.enabled: false` 可关闭面板。

## 路线图

- ✅ stdio 传输
- ✅ SSE 传输
- ✅ WebSocket 传输
- ✅ Streamable HTTP 传输（暂不使用独立的 GET 通知流）
- ✅ 自动重连（指数退避）
- ✅ 配置热更新（服务器、鉴权、限流、CORS）
- ✅ Web 可视化面板
- 📋 Redis 限流后端
- 📋 OAuth2 / OIDC 鉴权
- 📋 工具级 RBAC 权限控制
- 📋 OpenTelemetry 追踪

## 许可证

MIT © 2026 [HarrisonCN](https://github.com/HarrisonCN)
