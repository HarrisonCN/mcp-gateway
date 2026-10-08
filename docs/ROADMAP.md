# Roadmap

Post-6.0 plan for mcp-gateway. Every minor release stays backward compatible within 6.x; v7.0 is the next breaking
release. (The 5.x → 6.0 plan is complete; see the [CHANGELOG](../CHANGELOG.md).)

- ✅ v6.1：GraphQL / gRPC 上游：把 GraphQL 操作与 gRPC 方法暴露为 MCP 工具
- ✅ v6.2：工作流引擎：多工具 DAG 编排（依赖、并行、条件分支、失败重试）
- ✅ v6.3：OpenTelemetry GenAI 语义约定：工具调用与模型调用的标准 span / 指标
- ✅ v6.4：企业级 SSO / SCIM：OIDC 单点登录与用户、组的自动同步
- ✅ v6.5：策略模拟与演练（dry-run）：用历史流量评估策略变更的影响
- ✅ v6.6：异常检测：滥用、突发流量与提示注入特征识别
- ✅ v6.7：用量计费与账单：按租户计量、价目表与发票导出
- ✅ v6.8：Kubernetes Operator 与 Helm Chart：声明式部署与自动扩缩
- ✅ v6.9：v7 弃用警告与 `migrate --to 7`
- v7.0：（破坏性）控制面 / 数据面分离、schema v7、迁移指南
