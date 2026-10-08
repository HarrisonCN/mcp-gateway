# Roadmap

Post-5.0 plan for mcp-gateway. Every minor release stays backward compatible within 5.x; v6.0 is the next breaking
release. (The 4.x → 5.0 plan is complete; see the [CHANGELOG](../CHANGELOG.md).)

- ✅ v5.1：MCP 规范跟进（新版本协议协商、授权扩展透传）与协议一致性测试套件
- ✅ v5.2：多区域主动-主动集群（共享状态复制、跨区域故障转移）
- ✅ v5.3：边缘节点托管：控制面主动推送配置、仪表盘边缘节点视图
- ✅ v5.4：插件与工具市场：签名插件分发与供应链校验
- ✅ v5.5：智能体会话录制、回放与回归评测
- v5.6：数据防泄漏（DLP）：PII 分类与按租户脱敏策略
- v5.7：SDK 发布到 PyPI / Go 模块标签 / Swift Package Index，补齐流式结果与 MCP 会话
- v5.8：自适应路由 2.0：按成本与质量选择上游与模型
- v5.9：v6 弃用警告与 `migrate --to 6`
- v6.0：（破坏性）schema v6、移除插件 API v3、Node 22+ 基线、迁移指南
