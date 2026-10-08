# Roadmap

Post-4.0 plan for mcp-gateway. Every minor release stays backward compatible within 4.x; v5.0 is the next breaking
release.

- ✅ v4.0：（破坏性）配置 schema v4、插件 API v3（ctx.secrets、租户信息、onConfigChange）、移除 v3 弃用项、迁移指南
- ✅ v4.1：MCP 规范更新（结构化工具输出/资源链接/工具注解透传、协议协商）
- ✅ v4.2：工具链与多智能体编排
- v4.3：按 LLM 调用的成本核算与预算告警
- v4.4：流式工具结果与背压
- v4.5：上游 mTLS 零信任（SPIFFE、证书轮换）
- v4.6：仪表盘图形化配置编辑器
- v4.7：Python/Go/Swift SDK
- v4.8：离线/边缘同步
- v4.9：v5 弃用警告与 `migrate --to 5`
- v5.0：（破坏性）schema v5、插件 API v4、移除 v4 弃用项、迁移指南
