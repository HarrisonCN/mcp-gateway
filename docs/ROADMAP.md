# Roadmap

版本 / 状态 / 验收追踪表（2026-10-13 更新：15.0 之后到 17.0 的计划）。已发布版本的详细内容见 [CHANGELOG](../CHANGELOG.md)；10.x 之前与 10.x – 13.0 的历史计划保留在文末“历史计划”。

状态：✅ 已发布 · 🧪 预发布（npm `next` / `canary`） · ⏳ 进行中 · ⬜ 未开始 · ⛔ 需要维护者提供的资源 · ✖ 取消 · [条件] 只在需要时发布

## 当前版本线

| 版本 | 主题 | 状态 | 验收 |
|---|---|---|---|
| 13.9.x | v13 LTS（`v13-lts`，GHCR `:13`） | ✅ 维护中 | 安全与关键缺陷修复，至少维护到 15.0.0 发布后且不早于 2027-04-30 |
| 14.0 | 核心架构 v2，配置 schema v12 成为运行时 schema | ✅ | v11 文件内存迁移；`config migrate --to v12` / `config rollback` |
| 14.1 | 集群协调 | ✅ | 配置代次、数据面滚动发布与自动回滚测试 |
| 14.2 | 租户隔离强化 | ✅ | 跨租户矩阵测试 |
| 14.3 | 插件安全运行时（worker / process，limits、permissions、签名） | ✅ | MGW-2026-016 回归测试 |
| 14.4 | 持久化任务执行（durable task graphs、幂等、DLQ） | ✅ | kill -9 / Redis 故障下恰好一次执行测试 |
| 14.5 | 多区域一致性 | ✅ | 区域新鲜度 / 吊销复制测试 |
| 14.6 | Edge Autonomy 正式化 | ✅ | 离线队列加密与对账测试 |
| 14.7 | GitOps 与治理 | ✅ | bundle / release manifest、策略模拟 |
| 14.8 | 运维控制台 | ✅ | 集群状态、调用追踪、拒绝解释、故障向导 |
| 14.9 | v15 候选线：15.0 API / 配置冻结、15.0 变更提前告警、升级 / 回滚 / 安全回归 / 模糊 / soak 验证 | ✅ 14.9.2（`latest`） | [冻结清单](v15/freeze.md)；soak 发现 durable 状态无界增长：14.9.0 修复 sweep 开销与保留期（`retentionHours`），内存增长在 14.9.1 修复（sweep 分块读取、索引清理；30 分钟 soak +97 MB/h），14.9.2 限制内存中的 run id（每实例最多 5 万，其余从存储索引读取） |
| 14.10 – 14.13 | — | ✖ 取消 | 后续工作改为 GA 之后的 15.1 / 15.2 |
| 15.0.0-rc.1 | 15.0 候选：只包含 14.9 公告的四项变更（拒绝 v11 配置、模块插件默认 `worker`（`runtime: inline` 显式保留）、拒绝未知顶层键、移除 `schema/v12-draft`） | 🧪 rc.4 在 npm `next`，GHCR `:15.0.0-rc.4`（rc.3 `:15.0.0-rc.3`，rc.2 `:15.0.0-rc.2`，rc.1 `:15.0.0-rc.1`） | 13.9.x / 14.8 / 14.9 → rc.1 的迁移与回滚（SQLite + Redis）；冻结面无其他 API 变化 |
| 14.9.3+ | 稳定线维护（`latest`，分支 `maint/14.9.x`） | ⬜ [条件] | 只修安全 / 回归 / 数据正确性；冻结面不变；#224 的 Docker 构建修复随下一个 14.9.x 发布 |
| 15.0.0-rc.4 | 发布产物候选：#225 的 `$BUILDPLATFORM` 构建阶段进入 release 镜像（arm64 不再在 QEMU 下 `npm ci` / tsc） | 🧪 npm `next` | 冻结面不变；只在 `next` / `:15.0.0-rc.4`；闸门 A 应在这个（或之后的）候选产物上运行 |
| 15.0.0 | Governed AI Infrastructure（GA） | ⛔ | 需要下列 v15 发布闸门 A / B / C 全部关闭并由维护者签字；见下方“闸门的处理” |
| 15.1 | 调用因果追踪：`GET /api/v1/admin/ops/lineage/:requestId`（身份、租户、配置代次、策略决定、目标、上游状态、费用），接受客户端关联 id；租户成本汇总；控制台 lineage 视图 | 🧪 15.1.0-canary.0（npm `canary`）：`/admin/ops/lineage` + 客户端关联 id；🧪 15.1.0-canary.1：租户范围的查看者（`controlPlane.console.tenantViewers`）、成本汇总 `GET /admin/ops/costs`、/mcp lineage 测试、控制台 Lineage & costs 视图 | 每次调用唯一可追溯；租户运维者只看本租户；冻结面零变化（只做新增） |
| 15.2 | 插件生态与 SDK：`plugin init` 模板、`plugin doctor` 权限自检、可复现签名校验、兼容矩阵、插件测试工具 | 🧪 15.2.0-canary.0（npm `canary`）：`plugin init` + `plugin doctor`；🧪 15.2.0-canary.1：可复现签名校验（`plugin verify --rebuilt`）、兼容矩阵（[guide](guides/plugin-compatibility.md)）、`/testing` 导出、第三方示例插件 `examples/plugins/tool-quota`（安装 → 更新 → 撤销 → 崩溃恢复，worker + process）、`/mcp` 的 `_meta.correlationId` | 第三方示例插件在 worker / process 沙箱中完成安装、更新、撤销、崩溃恢复；不新增顶层 CLI 命令 |
| 15.3 | AI 生成治理：上游工具 `outputSchema` 校验（可选）、工具 schema 版本固定、按租户生成预算、审批与 lineage 关联 | 🧪 15.3.0-canary.0（npm `canary`）：`policy.toolSchemas` — `outputSchema` 校验（`off` / `audit` / `enforce`，违规拒绝并审计）、工具 schema 固定（`pins`，漂移在上游调用前拒绝或 `onDrift: audit`）、`GET /admin/ops/tool-schemas`；🧪 15.3.0-canary.1：按租户生成预算（`costs.budgets[]` `perTenant` / `tools` / `measure: calls`）、审批与 lineage 双向关联、提示注入回归语料（工具输出不扩大权限；上游不能伪造 `mcp-gateway/flags`）、Motionary 14.8 interop（MCP 2.x outputSchema，enforce + pins） | 未授权工具不执行；schema 违规不透传；Motionary interop 通过 |
| 15.4 | 闸门 / RC 反馈修复 | ⬜ [条件] | 只在需要新增内容时发布 |
| 15.9 | v16 准备：16.0 删除项运行时告警、`config migrate --to v13`、`docs/migrating-to-v16.md`、16.0 冻结清单；`16.0.0-alpha.1` | ⬜ npm `canary` | 每个删除项都有告警 + codemod + 文档 + 升级 / 回滚测试 |
| 16.0 | （破坏性，提案）配置 schema v13：去掉 `isolation` 别名、模块插件 `runtime: inline` 需显式允许；`/mcp` 不再接受协议修订 `2024-11-05`；Node ≥ 24 | ⬜ 预发布 / ⛔ 稳定版 | v12 文件在 16.x 内存迁移并告警；稳定版需要 v16 闸门（A / B 对比 15.0，C 外部增量复核） |
| 16.1 | 下一版 MCP 协议修订 + 工具 schema 协商（以官方规范为准） | ⬜ [条件] | MCP compat matrix 全绿 |
| 16.2 | 多区域控制面 2.0：lineage / 成本跨区域汇总、吊销延迟告警 | ⬜ npm `canary` | 区域新鲜度测试；lineage 跨区域唯一 |
| 16.9 | v17 准备：plugin API v5 → v6 告警与 codemod、`docs/migrating-to-v17.md`；`17.0.0-alpha.1` | ⬜ npm `canary` | 同 15.9 |
| 17.0 | （破坏性，提案）plugin API v6（模块插件只在 worker / process / wasm 运行）、拒绝 `version: 12`、SDK 冻结；15.x 成为 LTS | ⬜ 预发布 / ⛔ 稳定版 | 稳定版需要 v17 闸门 A / B / C |

## 发布通道

| 通道 | npm dist-tag | 镜像标签 | 分支 | 内容 |
|---|---|---|---|---|
| 稳定 | `latest` | `<version>`、`14.9`、`14`、`latest` | `maint/14.9.x` | 14.9.x（15.0.0 GA 后改为 15.x） |
| GA 候选 | `next` | 只有 `15.0.0-rc.N` | `main`，rc.4 之后 `release/15.0.x` | 15.0.0 候选，冻结面不变 |
| 开发线 | `canary` | 只有 `<version>` | `main` | 15.1 → 15.9、16.0.0-alpha、17.0.0-alpha |
| LTS | `v13-lts`、`v12-0`、`v10-lts` | `13`、`12`、`10` | `lts/*` | 不变 |

任何预发布都不会发布到 `latest` 或 `:latest` / `:15` / `:15.0`。15.1 及以后的稳定版排在 15.0.0 GA 之后。

## 闸门的处理（2026-10-13）

闸门 A / B / C 的定义不变，也不放宽：

- A 要求一次连续 72 小时的运行，B 要求固定专用硬件上的同机基线，C 要求独立的外部评审；开发用的共享环境做不到这三项，那里的 30 – 90 分钟 soak、2 小时演练和内部安全回归只作为辅助证据，**不算闸门证据**。
- 闸门未关闭之前，15.0 保持 RC（`next`），稳定线保持 14.9.x（`latest`），15.1 起的开发以 `canary` 预发布推进。
- 16.0 / 17.0 的稳定版同样需要闸门：A / B（同一 harness，对比上一稳定 major）和 C（至少针对该 major 变更面的外部增量复核）。

关闭 15.0 闸门需要维护者提供：

1. **A + B**：一台专用 Linux 机器（≥ 4 核、8 GB 内存、SSD），约 80 小时只运行闸门（6 h 基线 + 72 h soak），不休眠、不自动更新或重启；Node.js 22、git、`redis-server`；注册为仓库的 self-hosted runner（labels `self-hosted`、`linux`、`soak`），或提供一个可运行 `scripts/gate-a.sh` 的 shell。
2. **B 的阈值**：确认或修改 [v15 gates](v15/gates.md#gate-b--comparison-with-the-v133-baseline-on-fixed-hardware) 中的提案（p95 / p99 ≤ +10 %，吞吐 ≥ −5 %，恢复时间 ≤ +20 %）。
3. **C**：一位独立于代码作者的外部安全评审人或机构，以及范围与时间约定（范围 = [冻结清单](v15/freeze.md)）。
4. **签字**：查看证据后在本页关闭 A / B / C。

## v15 发布闸门

详见 [release gates](release-gates.md#v15-gates)。

| 闸门 | 要求 | 状态 | 证据 / 说明 |
|---|---|---|---|
| A | 72 小时负载 + 故障注入，至少两个实例共享 Redis；无跨租户访问、无非幂等调用重复执行 | ⬜ 未关闭 | 仅有本地 soak（`scripts/soak.mjs`，2 实例 + Redis，非固定硬件）：无跨租户访问、无重复执行。14.9.0 / rc.1 内存增长约 600 MB/h（13.3.0 约 30 MB/h），根因为 durable sweep 全量读取，14.9.1 / rc.2 已修复。rc.2 90 分钟 soak（2026-10-12，pass，0 违规）：堆在请求日志达到 10 万条上限（约 64 分钟）后持平（60–90 分钟堆底 −2.4 MB/h、RSS −13.5 MB/h）；进程内 harness 测得剩余增长为每个保留的 durable run id 约 196 B（6 runs/s 约 4 MB/h，168 h 保留期约 680 MB），14.9.2 / rc.3 已限制（每实例最多 5 万个 id，60 000 runs 堆持平）。72 小时运行需要 self-hosted `soak` runner：harness `scripts/gate-a.sh` / workflow `gate-a.yml`，说明见 [v15 gates](v15/gates.md)（尚未运行） |
| B | 在固定硬件、等价负载下与 v13.3 基线比较 p95 / p99 / 吞吐 / 内存增长 / 恢复时间 | ⬜ 未关闭 | 本地 30 分钟对比仅供参考（共享沙箱、负载不固定，不是基准）；需在固定硬件上用同一 harness（`--impl` 指向 13.3.0）重跑 |
| C | 独立安全审计，或至少一位外部专家评审，范围内高危问题全部关闭 | ⬜ 未关闭 | 尚未安排 |
| D | 13.x / 14.x → 15 的迁移与回滚验证 | ⏳ | `test/upgrade-14-9-0.test.ts`、`test/rc-migration-14-9-0.test.ts`、`test/upgrade-15-0-0-rc.test.ts` |

## 历史计划

v10.0 之后的计划（历史）。10.x 是长期支持（LTS）版本线：10.x 内每个次版本都保持向后兼容（配置 schema v10 不变），
活跃支持至 2027-10-31，安全维护至 2028-10-31。v11.0 是下一个破坏性版本（已发布：配置 schema v11、按需加载的模块化内核、移除 10.x 弃用项；10.x 的 LTS 日期不变）。（9.x → 10.0 的计划已全部完成，见 [CHANGELOG](../CHANGELOG.md)。）

安全加固（10.1 → 10.4，只做加固、测试、缺陷修复与文档，不加新功能）：

- ✅ v10.1：安全基线：威胁模型、子进程 / 认证 / 租户 / mTLS 审计与修复、CodeQL、OpenSSF Scorecard、`npm audit` 阻断
- ✅ v10.2：测试深度：fast-check 属性 / 模糊测试（配置解析、JSON-RPC 分帧、参数大小限制、JWT 解析）、管理接口鉴权矩阵、回归测试
- ✅ v10.3：如实标注与安全默认值：TEE 与后量子 TLS 标为实验性，非回环地址未开启认证时拒绝启动（`--insecure` 例外），Helm Chart 默认要求 API Key
- ✅ v10.4：供应链与响应：SBOM、Trivy 扫描、cosign 无密钥签名镜像、Dependabot、事件响应流程

功能计划（10.5 → 10.8，每个次版本两项；全部向后兼容配置 schema v10，新功能均在 `features:` 下按需开启，不配置则行为不变）：

- ✅ v10.5：**内核插件 SDK**（用与内置模块相同的接口编写功能模块：配置 schema、管理路由、调用钩子；从目录 / npm 包加载，带签名信任与隔离）+ **策略即代码 2.0**（Cedar 子集策略的内置求值器、对接外部 OPA 的 Rego 策略、策略单元测试与基于审计日志的变更影响分析）
- ✅ v10.6：**全链路回放与时间旅行调试**（基于事件溯源存储重建任意时刻的网关状态与调用链，并对比重放结果）+ **实时成本与碳排放预算**（按租户 / 智能体 / 密钥设预算，超限前预警、超限后降级或拒绝；碳排放为基于可配置系数的估算）
- ✅ v10.7：**多智能体编排 2.0**（跨网关的智能体任务图、检查点与断点续跑、失败重试与补偿）+ **边缘自治**（实验性：边缘节点断网时本地执行策略 / 缓存 / WASM 工具，恢复后对账）
- ✅ v10.8：**隐私计算**（实验性：工具结果的差分隐私聚合与联邦查询，原始数据不出域）+ **后量子身份**（实验性：ML-DSA 签名用于插件、工具清单与审计日志，经典 + 后量子混合签名过渡；依赖运行时的 OpenSSL 支持）

排序理由：插件 SDK 与策略引擎是后续功能的底座（10.5）；回放与预算依赖已有的事件溯源存储和计量（10.6）；编排 2.0 复用回放的检查点，边缘自治复用策略与 WASM（10.7）；隐私计算与后量子身份最依赖外部标准与运行时，放在最后并标为实验性（10.8）。

- ✅ v10.9：v11 弃用警告与 `migrate --to 11`
- ✅ v11.0：（破坏性）配置 schema v11、模块化内核默认按需加载、移除 10.x 弃用项、迁移指南

安全与模块化（11.1 → 13.0）。设计原则：**任何来源（任何传输方式、任何功能模块）的工具调用都必须经过唯一且不可绕过的授权决策点。**

- ✅ v11.1：（安全）中央授权器 `authorize()`：REST、`/mcp`、OpenAI / A2A 桥接、工具链、任务图、智能体委托、插件、联邦、边缘运行时全部经由调用管线入口统一鉴权，缺少主体（principal）即拒绝；智能体委托令牌不得超出委托方自身权限（P0）；作用域收窄改为严格子集（P1）
- ✅ v11.2：（安全）多模态 blob 绑定所有者与租户、读取时重新鉴权、全局与租户字节预算；智能体令牌吊销写入共享状态存储（Redis / SQLite / 事件日志），存储不可用时默认拒绝（fail-closed）；新增 SQLite 状态存储
- ✅ v12.0：（破坏性）stdio 子进程环境变量改为白名单，支持独立 uid/gid、工作目录与沙箱包装（bubblewrap / firejail / 容器 / 自定义模板，可禁用网络）；多模态单项上限下调；热重载失败自动回滚；内核基准（启动时间、内存、已加载模块数）与负载 / 内存压力测试进入 CI
- v12.x：按需修复
- ✅ v13.0：（破坏性）真正的模块化内核：功能模块仅在启用时通过 `import()` 清单加载（未配置任何功能时 0/47 个模块被执行），配置 schema 拆分到 `src/features/schemas/`，配置加载器与管理接口不再导入任何功能模块；模块生命周期契约（init / reconfigure / disable / dispose / health）、显式依赖声明（billing→genai-otel、sanitize→anomaly、edge-autonomy→edge-runtime+offline、task-graphs→a2a-federation）、按依赖排序与故障隔离（失败模块返回 503，其余照常运行）；新增精简入口 `./gateway`；模块加载追踪测试保证未启用模块从不被执行；中央授权器保持唯一且不可绕过

13.0 之后：

- v13.x：按需修复；视需要把更多核心依赖（如 jose、yaml）改为按需加载，进一步缩短冷启动
- v10.9.1（10.x LTS 回移）：把 11.1–12.0 的 P0/P1 安全修复（中央授权器、严格作用域收窄、共享吊销存储、多模态 blob 所有权、stdio 环境变量白名单）适配到配置 schema v10 后发布；GHCR `10` 标签指向 10.9.1，npm 使用独立 dist-tag（不改 `latest`）
- 说明：ES 模块一经执行无法从内存卸载；“禁用”即卸下路由（404）、停止调用钩子并调用 `disable()` 释放资源
