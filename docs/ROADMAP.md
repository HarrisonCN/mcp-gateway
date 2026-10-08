# Roadmap

Post-8.0 plan for mcp-gateway. Every minor release stays backward compatible within 8.x; v9.0 is the next breaking
release. (The 7.x → 8.0 plan is complete; see the [CHANGELOG](../CHANGELOG.md).)

- ✅ v8.1：智能体身份与委托授权：为 AI 智能体签发身份，支持代表用户的受限委托（OAuth token exchange / on-behalf-of）
- ✅ v8.2：跨网关 A2A 联邦：网关之间互相发现、转发工具调用与智能体任务，统一信任与审计
- ✅ v8.3：实时协作调试：多人同时观察、断点暂停与重放同一会话中的工具调用
- ✅ v8.4：成本优化顾问：基于用量与缓存命中给出路由、缓存与上游选择的节省建议
- ✅ v8.5：零停机蓝绿升级：双版本并行、健康校验后切流、一键回滚
- ✅ v8.6：数据血缘：追踪工具输入输出在调用链与工作流中的来源与去向
- ✅ v8.7：自然语言配置助手：用自然语言描述意图，生成并校验配置变更（可 dry-run）
- ✅ v8.8：混沌测试：按计划注入延迟、错误与断连，验证重试、熔断与降级策略
- v8.9：v9 弃用警告与 `migrate --to 9`
- v9.0：（破坏性）schema v9、事件溯源状态存储、迁移指南
