# MCP Gateway 17.x 维护计划

更新时间：2026-11-06。本轮基线为 `17.0.3`，main `0a9e84a9a81ab215f53e0f68071148673c5168fc`。
以当前源码、开放 PR、CI 和 [release gates](release-gates.md) 为依据。
目标版本是范围，不是已发布承诺；每项独立验收并更新状态。

## 执行原则

- 保持 Node 24、配置 v13、插件 API v6 与 SDK 导出面的现有约定；17.x 修复优先兼容已有客户端。
- 优先资源边界、租户隔离、请求取消、重试正确性与可恢复性，再完善运维和集成。
- 不降低覆盖率、性能和发布闸门；本机单测不能替代 Redis 多实例或官方 SDK 互通检查。
- A（专用硬件 72 小时 soak）、B（同机性能基线）、C（独立外部安全评审）仍未完成。
  共享开发环境或内部回归通过不会改变这三项状态。
- 一个修复主题一个 PR；每轮必需 CI 通过且无已知重大缺陷后直接合并，按 SemVer 发布 npm / 镜像 / Release 并提供可下载包体，无需逐次确认。发布仍须满足现有 CI 闸门；外部条件阻塞时明确保留未发布状态。

## 迭代顺序与验收

| 顺序 / 目标版本 | 工作项 | 优先级 | 交付与验收 | 状态 |
| --- | --- | --- | --- | --- |
| G17-001 / 17.0.x | SSE 单行 / 多行事件资源上限与异常清理 | P0 | 已换行和未换行的超限行都被拒绝；多行事件累计数据有界；合法多事件大 chunk 不误拒绝；CRLF 跨空 chunk 不改变事件；异常取消 reader 并释放锁；官方 SDK 传输回归通过 | [PR #249](https://github.com/HarrisonCN/mcp-gateway/pull/249) 已合并；随 17.0.2 发布（17.0.1 未发布） |
| G17-002 / 17.1 | 传输生命周期、取消与重连一致性 | P1 | 对 SSE、Streamable HTTP、WebSocket、stdio 建立相同取消 / deadline / 断连语料；无悬挂 inflight；非幂等调用不因重连重复执行；两实例 Redis 故障测试通过 | 17.0.3 已覆盖四种传输的排队取消与超时，17.0.4 修复 SSE 启动超时导致的进程退出，断连与重连重放矩阵继续分项验收 |
| G17-003 / 17.2 | Motionary 17.x 互通和提案审计 | P1 | 固定双方版本；工具发现、Scene v3 校验、提案、失败回传与取消可重复；租户不混淆，requestId 可匹配 lineage，未经人确认不写入 Motionary 工程 | 待双方基础修复通过 |
| G17-004 / 17.3 | 运维诊断与恢复证据 | P1 | 对既有健康检查 / readiness / 指标补充可复现故障场景；热重载失败保留旧配置，敏感值不进入日志；Redis 分区与恢复报告包含失败模式和恢复时间 | 待 G17-002 通过 |
| G17-005 / 17.4（条件） | 已公布 MCP 修订与 SDK 兼容收尾 | P1 | 依据官方规范逐项核对尚未完成的 MRTR / tasks / 上游新协议支持；先列明确支持矩阵，再实现有测试的兼容增量；JS / Python / Kotlin 等客户端契约验证 | 需先做协议范围复核 |
| 持续维护 / 17.x patch | 依赖与供应链 | P1 | 分别审查现有 Dependabot PR #236（Kotlin Gradle）与 #237（Actions），验证 runner / 构建兼容再合并；不在本轮重复修改它们；审计及包 / 镜像检查继续阻断 | 待独立审核 |
| G17-006 / 17.0.2 | 依赖安全公告（10/21 起 PR CI 的 audit / Trivy 阻断） | P0 | undici、body-parser、qs、ip-address、fast-uri 升级；zod 3 → 4（GHSA-mrhx-c7xc-m3w5，3.x 无补丁）且配置解析结果与 zod 3 逐字节一致；`npm audit --audit-level=high` 通过；完整测试、构建、文档检查、SDK 导出面与内核基准通过 | [PR #258](https://github.com/HarrisonCN/mcp-gateway/pull/258) 16 项检查全部通过，已合并至 `67d73cb7efb3d6f5c35a9e8eceec6783e22f553f`；17.0.2 发布 |
| 独立验证轨道 | A / B / C 闸门 | P0 验证债务 | 按原标准运行专用硬件长稳、同机基线和独立外部评审；记录原始证据与签字；现有 17.0 所有者发布决定不被改写 | 等待硬件与外部评审条件 |

## G17-001 验收记录

- 复现：`test/sse-parser-limits.test.ts`，15 个用例；原基线 **10 失败、5 通过**。
- 原因：原来的行长度检查发生在完整行已经被消费之后；`dataLines` 没有事件级累计限制。
  空字符串 push 会丢失待处理的 CR 状态；读取失败时仅解锁 reader，没有取消源。
- 修复范围：内部 SSE parser / stream reader、回归测试与文档。既有构造参数仍可用；默认上限以 JavaScript 字符串长度（UTF-16 code units）计量，不能写成内存字节上限。
- 本地验证：新增回归与官方 SDK 传输测试 **29/29 通过**；类型检查、构建及文档检查通过（0 findings）。
- 完整覆盖率命令已执行：**1,715 通过、25 失败、34 跳过**；未取得通过的覆盖率报告。
  失败集中在 `tsx` 子进程启动的 CLI / 模块加载检查；本地 Unix IPC 被运行环境拒绝（`listen EPERM`），这些检查已由 PR #249 的 Node 24 CI 验证通过。
  文档检查通过支持的 `node --import tsx scripts/docs-check.ts` 方式执行。真实 Redis、兼容矩阵、部署示例、安全回归与供应链检查均已在 PR CI 通过。
- 合并状态：[PR #249](https://github.com/HarrisonCN/mcp-gateway/pull/249) 的 16 项检查全部通过，已合并至 `869d072cd33ec7235b6be4ec12b1b82e65193e2d`；17.0.1 准备后未发布（无 tag / Release / npm），随 17.0.2 发布。

## G17-006 验收记录

- 复现：main `4e46d62` 上 `npm audit --audit-level=high` 报 3 个 high（undici、zod，以及之后披露的 body-parser）；
  PR #252–#257 的 CI 均在 Node 24 job 的 Dependency audit 和 Supply chain 的 Trivy 步骤失败（其他 job 通过）。
- 修复：非破坏性升级单独一个提交；zod 4 迁移：41 处单参数 `z.record()` 补 key schema；40 处对象字面量
  `.default({…})` 改为 `.prefault({…})`（zod 4 的 `.default()` 不再解析默认值，嵌套默认值会丢失）；API key union
  内只做 `${VAR}` 检查、展开放到 union 之后（zod 4 不选 transform 失败的分支，会把"not set"吞成 `Invalid input`）；
  配置错误中的缺失字段保持 `Required`（单次解析的 error 参数，不改全局 `z.config`）。
- 等价性：docs / examples / README 中 377 份配置及每个 feature 段 `{}` 在 schema v13 与 v12 迁移读取下，与 zod 3
  输出逐字节一致；反向对照（把 `.prefault` 改回 `.default`）出现 10 处差异，说明比对有效。
- 本地验证（Node 22，CI 为 24）：类型检查、构建通过；完整测试 **1,759 通过、19 跳过、0 失败**（与 main 基线相同）；
  docs-check 0 findings；`sdk-surface` 0 missing；`v13-surface` 无缺失；CLI 冒烟与 `examples/*` `--strict` 校验通过；
  `npm audit --audit-level=high` 通过（剩余 1 项 moderate 为 vitest 开发依赖，由 Dependabot PR #255 处理）。
- 内核基准：zod 4 任一公开入口都加载 64 个 locale 模块，`modules` / `moduleKb` 超过 10% 门槛（+85 模块 / +699 KB）。
  经所有者决定（2026-11-05）只重录这两项基线；时间和内存基线不变，实测约 +40 ms 导入、+15 MB RSS，在既有门槛内。
- 真实 Redis 多实例、MCP 兼容矩阵、部署示例、Kotlin 客户端、Trivy 依赖与镜像扫描、CodeQL 均在 [PR #258](https://github.com/HarrisonCN/mcp-gateway/pull/258) CI 通过（16/16）。

## G17-002 排队取消与超时

本轮 G17-002 排队回归记录在 `test/transports.test.ts` 与 `test/proxy.test.ts`。17.0.2 在四种传输的八个
取消和超时用例中均保留了已经退出的等待项，在截止时间与放行交错时仍向上游发送了有副作用的调用。
17.0.3 会立即释放排队名额，并在转发前复核截止时间。`test/utils.test.ts` 另覆盖队列中段取消后的放行顺序。

## G17-002 SSE 启动超时

- `test/sse-lifecycle.test.ts` 通过独立 Node.js 子进程复现上游一直不返回响应头的情况。
  17.0.3 的子进程因为未处理的 readiness Promise 拒绝而以状态码 1 退出，调用方的 catch 未能接住错误。
- 17.0.4 在打开 HTTP 的同时等待 readiness，将连接失败和 endpoint 超时汇入同一启动结果，并在失败时取消请求。
- 六个回归用例覆盖响应头阻塞、endpoint 阻塞、主动关闭、HTTP 错误、错误的 Content-Type，以及超过启动截止时间后
  仍可使用的正常 SSE 连接。官方 SDK 传输和真实 Redis 回归继续作为合并检查。

## 每轮完成条件

1. 读取最新 main、开放 PR 与测试状态；记录基线 SHA 和本轮任务编号。
2. 先记录可复现失败，再实现限定范围的修复和必要文档。
3. 类型检查、针对性回归、完整测试、覆盖率和构建；受影响部分运行真实 Redis / SDK / 文档检查。
4. 审查 PR diff、作者信息和 CI；红灯不合并，不通过调低门槛消除失败。
5. 更新本页状态、证据、PR 和下一项，发布时再更新版本及 CHANGELOG。

## 双仓库联动

Motionary M17-004 与本仓库 G17-003 成对验收。已有 gateway interop workflow 继续保留；禁止以工具调用成功替代
多租户隔离、人工确认和编辑溯源的断言，也不把实验性 Studio / MCP 接口标成稳定。
