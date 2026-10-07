<div align="center">

# mcp-gateway

**轻量级、开源的 MCP 服务器统一网关。**

路由 · 鉴权 · 限流 · 监控 — 用一个端点管理所有 [MCP](https://modelcontextprotocol.io) 服务器。

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](../LICENSE)
[![Node.js](https://img.shields.io/badge/node-%3E%3D20.0.0-brightgreen.svg)](https://nodejs.org)
[![npm version](https://img.shields.io/npm/v/@winstonsayno/mcp-gateway.svg)](https://www.npmjs.com/package/@winstonsayno/mcp-gateway)

[English](../README.md) · **中文** · [文档](.) · [示例](../examples/)

</div>

---

> **在线演示：** 用模拟流量体验控制面板 — <https://harrisoncn.github.io/mcp-gateway/>（完全在浏览器内运行）。

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
| **面向客户端的 MCP 端点** | `/mcp` 实现 MCP Streamable HTTP（2025-06-18 / 2025-03-26），Claude Code、Cursor 等任意 MCP 客户端通过一个服务器即可使用所有上游工具，并共享鉴权、限流与指标 |
| **全部 MCP 传输方式** | 上游服务器支持 `stdio`、`streamable-http`（最新规范）、旧版 `sse`（HTTP+SSE）和 `websocket`，可为每个服务器配置请求头用于上游鉴权 |
| **自动重连** | 崩溃或断开的服务器按指数退避 + 随机抖动自动重连，状态可在 `/servers`、`/health`、面板和 Prometheus 中查看 |
| **鉴权** | 支持 API Key（常量时间比较）、JWT（HS256/384/512）或无鉴权模式；配置错误时拒绝启动 |
| **可选保护 health / metrics** | `/health`、`/metrics` 默认公开，可通过 `auth.protect` 要求鉴权；面板支持输入 API Key |
| **限流** | 按 Key 的滑动窗口限流，标准 `X-RateLimit-*` 响应头 |
| **按 Key 的权限范围** | 可将 API Key（或通过 claims 的 JWT）限制在部分服务器 / 工具上，并设置独立限流；REST 与 `/mcp` 均生效 |
| **健康监控** | 基于 MCP `ping` 的周期性健康检查（含延迟），间隔可配置 |
| **配置热更新** | 服务器、API Key / 鉴权、限流、CORS、重连策略修改后无需重启即可生效 |
| **指标收集** | 兼容 Prometheus 的 `/metrics` 端点 + JSON 聚合 |
| **工具发现** | `GET /api/v1/tools` 列出所有服务器的所有工具 |
| **resources 与 prompts** | 所有服务器的 `resources/*`、`prompts/*` 在 REST 与 `/mcp` 上聚合透传 |
| **持久化审计日志** | 可选 SQLite 请求历史（内置 `node:sqlite`，无新依赖），可通过 `GET /api/v1/requests` 和面板查询 |
| **LLM 工具 schema** | `GET /api/v1/tools?format=openai\|openai-responses\|anthropic` 直接返回可用于函数调用的工具定义 |
| **客户端库** | 零依赖 TypeScript 客户端（[`clients/js`](../clients/js)，浏览器 + Node）和 Kotlin/JVM/Android 客户端（[`clients/kotlin`](../clients/kotlin)） |
| **YAML 配置** | 简洁的声明式配置，支持环境变量覆盖 |
| **Docker 支持** | 官方 Docker 镜像，附带 Compose 示例 |

## 作为 MCP 服务器使用（`/mcp`）

网关本身就是一个 MCP 服务器：`http://<host>:4000/mcp` 实现
[Streamable HTTP 传输](https://modelcontextprotocol.io/specification/2025-06-18/basic/transports)（协议 `2025-06-18`，兼容 `2025-03-26`）。
客户端看到的是聚合、过滤后的统一工具列表；调用会被路由到对应的上游服务器，并复用网关的鉴权、限流、`maxConcurrency`、超时、指标和请求日志。

**Claude Code**

```bash
claude mcp add --transport http gateway http://localhost:4000/mcp \
  --header "Authorization: Bearer your-secret-key"
```

**Cursor**（`~/.cursor/mcp.json` 或项目内 `.cursor/mcp.json`）

```json
{
  "mcpServers": {
    "gateway": {
      "url": "http://localhost:4000/mcp",
      "headers": { "Authorization": "Bearer your-secret-key" }
    }
  }
}
```

只支持 stdio 的客户端可用 [`mcp-remote`](https://www.npmjs.com/package/mcp-remote) 桥接：
`npx mcp-remote http://localhost:4000/mcp --header "Authorization: Bearer your-secret-key"`。

| | |
|---|---|
| `POST /mcp` | JSON-RPC：`initialize`、`ping`、`tools/list`（分页）、`tools/call`、通知（含 `notifications/cancelled`），支持批量，响应为 `application/json` |
| `GET /mcp` | SSE 通知流：聚合工具列表变化时发送 `notifications/tools/list_changed`（上游新增工具、服务器连接、热更新删除服务器等） |
| `DELETE /mcp` | 结束会话 |
| 会话 | `initialize` 返回 `Mcp-Session-Id`，之后的请求必须携带（缺失 `400`，未知或过期 `404`）。会话与创建它的 API Key / JWT 主体绑定，空闲超过 `mcp.sessionIdleTimeoutSeconds` 自动过期 |
| 工具命名 | `toolNaming: auto`（默认）仅在多个服务器有同名工具时改为 `<serverId>__<tool>`；`prefix` 则全部加前缀。顺序确定（按服务器 id、工具名排序）。`auto` 模式下 `tools/call` 也接受带前缀的名字 |
| 错误 | 未知工具 / 参数错误 → JSON-RPC `-32602`；限流 → `-32029`（`data.retryAfter`）；服务器离线或超时 → 返回 `isError: true` 的普通结果；上游 JSON-RPC 错误原样转发；取消 → `-32800` |
| 取消 | `notifications/cancelled`（或客户端断开 HTTP 请求）会取消上游调用，上游会收到自己的 `notifications/cancelled` |
| 安全 | 与 REST API 使用相同的 `auth`。带 `Origin` 头的请求必须匹配 `mcp.allowedOrigins`（默认取 `corsOrigins`），否则返回 `403`；网关监听在可访问地址时请务必配置 |

```yaml
mcp:
  enabled: true               # 修改需重启
  path: /mcp                  # 修改需重启；不能是 "/" 或位于 /api、/dashboard 下
  toolNaming: auto            # auto | prefix
  pageSize: 500               # 每页 tools/list 数量
  sessionIdleTimeoutSeconds: 1800
  maxSessions: 1000           # 超出时淘汰最久未使用的空闲会话
  # allowedOrigins: ["https://your-app.com"]
  # instructions: "ACME 工作区的工具"   # 在 initialize 中返回
```

## resources 与 prompts 透传

声明了 `resources` / `prompts` 能力的服务器，会在连接时列出其资源、资源模板和提示词（收到 `notifications/*/list_changed` 时刷新）。

| REST | `/mcp` |
|---|---|
| `GET /api/v1/resources`（`?server=`，重复 URI 只保留一份） | `resources/list` |
| `GET /api/v1/resources/templates` | `resources/templates/list` |
| `POST /api/v1/resources/read` `{"uri", "server"?}` | `resources/read` |
| `GET /api/v1/prompts` | `prompts/list`（名字规则同 `toolNaming`） |
| `POST /api/v1/prompts/get` `{"name", "server"?, "arguments"?}` | `prompts/get` |

- 资源 URI 原样透传；多个服务器列出同一 URI 时，服务器 id 最小的胜出。`resources/read` 依次按精确 URI、资源模板、唯一的资源服务器路由。
- 读取 / 获取会实时转发（使用服务器的 `timeout`），计入限流，并以 `kind: "resource"` / `"prompt"` 记入指标与历史。
- Key 的权限范围按**服务器**（`servers`）生效；`tools` 通配和 `servers[].tools` 过滤只作用于工具。
- `/mcp` 会发送 `notifications/resources/list_changed` 与 `notifications/prompts/list_changed`；不支持 `resources/subscribe`。

## 持久化审计日志

默认请求历史只保存在内存中（`monitor.retentionHours`）。开启审计日志后可跨重启保存在 SQLite 中：

```yaml
audit:
  enabled: true
  path: ./data/mcp-gateway-audit.db   # 默认 mcp-gateway-audit.db（WAL 模式）
  retentionDays: 30                   # 每小时清理；0 = 永久保留
```

- 使用 Node 内置的 `node:sqlite`（**Node 22.5+**）：无额外依赖、无需编译原生模块。Node 20 上开启会拒绝启动并说明原因。Node 可能会打印 `ExperimentalWarning`。
- 只保存元数据：时间、服务器、工具 / URI / 提示词、类型、耗时、成功与否、错误信息、client id、`via`（`rest` / `mcp`）。不保存参数和结果。
- 开启后 `GET /api/v1/requests` 从数据库读取（`"source": "audit"`），支持过滤（`server`、`tool`、`client`、`success=true|false`、`via=rest|mcp`、`kind=tool|resource|prompt`、`since` / `until`，ISO 或毫秒时间戳）和分页（`nextCursor` → `?cursor=`）。受限 Key 只能看到自己的记录。面板的 *Request History* 提供相同的过滤和 *Load older* 按钮。
- 修改 `audit` 需要重启。

## LLM 工具 schema 与客户端库

`GET /api/v1/tools?format=openai`（Chat Completions）、`openai-responses`（Responses API）或 `anthropic`（Messages API）
返回调用方可用工具的函数调用定义，以及从 LLM 工具名映射回网关服务器 / 工具的 `mapping`：

```json
{
  "format": "anthropic",
  "tools": [{ "name": "github__create_issue", "description": "…", "input_schema": { "type": "object", "properties": {} } }],
  "mapping": { "github__create_issue": { "server": "github", "tool": "create_issue" } },
  "total": 1
}
```

把 `tools` 直接传给模型；模型调用工具时，通过 `mapping` 找到 `server` / `tool`，再调用 `POST /api/v1/tools/call`（客户端的 `callLlmTool()` 已封装）。
名字遵循 `mcp.toolNaming`，并会规范为 `^[a-zA-Z0-9_-]{1,64}$` 且去重；会移除 `$schema`，`parameters` 始终是 object schema。权限范围和 `?server=` / `?tag=` 过滤同样生效。

| 客户端 | 说明 |
|---|---|
| **TypeScript / JavaScript**（[`clients/js`](../clients/js)） | `@winstonsayno/mcp-gateway-client`：零依赖、基于 `fetch`（浏览器、Node 18+、Deno、Bun、React Native），类型完整的 `health`、`servers`、`listTools`、`toolSchemas`、`callTool`、`callLlmTool`，以及简易的 `/mcp` 会话助手 |
| **Kotlin / JVM / Android**（[`clients/kotlin`](../clients/kotlin)） | OkHttp + kotlinx.serialization，Java 11 字节码；API 相同，`McpSession` 用于 `/mcp` |

两者都在本仓库中，尚未发布到 npm / Maven Central。

## 按 Key 的权限范围（scopes）

为每个应用分配独立的 Key，只开放它需要的工具。纯字符串 Key 保持完全访问；对象形式可以加以限制（除 `key` 外都可选）：

```yaml
auth:
  strategy: api-key
  apiKeys:
    - "admin-key"                       # 不受限
    - key: ${AURA_GATEWAY_KEY}          # 对象形式的 key 支持 ${VAR} 展开
      name: aura                        # 日志、指标、会话中的 client id 为 "key:aura"（需唯一）
      servers: ["github", "fs-*"]       # 服务器 id 通配
      tools: ["read_*", "github/create_issue"]   # 工具名通配；含 "/" 时匹配 "server/tool"
      rateLimit: { limit: 30, windowSeconds: 60 } # 独立限流桶，替代全局 rateLimit
```

- 工具必须同时通过服务器自身的 `tools` 过滤、Key 的 `servers` 和 `tools` 列表。未配置列表表示不限制；空列表表示全部禁止。
- **发现接口隐藏**无权使用的内容：`GET /tools`、`GET /servers`、`GET /servers/:id`（→ `404`）、`/mcp` 的 `tools/list`。
- **调用被拒绝**：`POST /tools/call`、`POST /servers/:id/reconnect` → `403`；`/mcp` 的 `tools/call` → JSON-RPC 错误 `-32003`。自动路由只在该 Key 可用的服务器中查找。
- `/mcp` 的同名冲突前缀按该 Key 可见的工具计算（只限一个服务器的 Key 看到的是原始名字）。
- 受限 Key 在 `GET /requests` 中只能看到自己的请求。
- **JWT**：在 `mcp_servers` / `mcp_tools` claims 中放通配（数组，或空格/逗号分隔的字符串），格式错误的 claim 视为全部禁止。
- 支持热更新：修改后下一个请求即生效；已打开的 `/mcp` 会话会收到 `notifications/tools/list_changed`，被删除 Key 的会话会被关闭。

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
| `reconnect`、`logLevel` | `mcp.enabled`、`mcp.path`、`audit` |
| `mcp.toolNaming` / `pageSize` / 会话设置 / `allowedOrigins` | |

配置文件无效时会被拒绝，继续使用当前配置。

### 面板

访问 `http://localhost:4000/dashboard`。首次打开会进入新手引导：用 API Key 连接、查看上游服务器、通过按 JSON Schema 自动生成的表单调用一个工具，并复制 Claude Desktop、Cursor、Claude Code、JS / Kotlin 客户端或 curl 的接入配置；之后可随时点击 **?** 重新打开。仪表盘实时展示请求速率、p50 / p95 延迟、错误率、热门工具、各密钥用量、实时请求流、服务器健康状态（可一键重连）以及可筛选分页的请求历史。整个面板是一个静态文件，无需构建、不依赖 CDN，支持中英文切换、深色 / 浅色主题和手机浏览。实时数据来自 `GET /api/v1/stats` 与 SSE 流 `GET /api/v1/events`。

开启鉴权后，在页头输入 API Key（或 JWT）：默认只保存在当前标签页（`sessionStorage`），勾选 “remember” 则保存在 `localStorage`，并以 `Authorization: Bearer …` 发送给每个 API 请求。设置 `dashboard.enabled: false` 可关闭面板。

## 文档

- [API 参考](api-reference.md)（REST、`/mcp`、错误码、稳定性策略）
- [配置参考](configuration.md)
- [部署指南](deployment.md)（Docker、Kubernetes、反向代理、安全清单）

Docker 镜像：每次发布都会构建多架构镜像 `ghcr.io/harrisoncn/mcp-gateway:<版本>`（`1.0.0`、`1.0`、`1`、`latest`，基于 Node 22）。

## API 稳定性

自 **1.0.0** 起遵循[语义化版本](https://semver.org/lang/zh-CN/)。1.x 期间，`/api/v1` REST API、`/mcp` 端点行为、配置项、CLI 命令与参数、包根导出以及 Prometheus 指标名只做向后兼容的改动（可能新增字段、端点和选项——请忽略未知字段）。深层导入路径、日志格式、面板以及审计数据库表结构不在保证范围内。详见 [api-reference.md#stability-and-versioning](api-reference.md#stability-and-versioning)。

## 路线图

- ✅ stdio 传输
- ✅ SSE 传输
- ✅ WebSocket 传输
- ✅ Streamable HTTP 传输（暂不使用独立的 GET 通知流）
- ✅ 自动重连（指数退避）
- ✅ 配置热更新（服务器、鉴权、限流、CORS）
- ✅ Web 可视化面板
- ✅ 下游 MCP 端点 `/mcp`（v1.0）
- ✅ 按 Key 的权限范围与限流（v1.0）
- ✅ JS / Kotlin 客户端，OpenAI / Anthropic 工具 schema（v1.0）
- ✅ resources / prompts 透传，持久化审计日志（v1.0）
- ✅ 稳定 API、文档、容器镜像（v1.0）
- 📋 Redis 限流后端
- 📋 OAuth2 / OIDC 鉴权
- ✅ 工具级权限控制（通过按 Key 的 scopes，v0.6）
- 📋 OpenTelemetry 追踪

## 许可证

MIT © 2026 [HarrisonCN](https://github.com/HarrisonCN)
