# Roadmap

Post-3.0 plan for mcp-gateway. Every minor release stays backward compatible within 3.x; v4.0 is the next breaking
release.

- v3.1：MCP 采样（sampling）/ elicitation / roots 请求透传到下游客户端，补齐双向能力
- v3.2：请求回放与调试器：在仪表盘中按审计记录一键重放、对比上游响应
- v3.3：WASM 插件沙箱，插件可用多语言编写并按租户隔离运行
- v3.4：智能路由：按延迟/成本/错误率动态选择上游，支持金丝雀与 A/B 流量切分
- v3.5：密钥与凭据托管：集成 Vault / KMS，上游令牌自动轮换与按租户注入
- v3.6：联邦网关：多区域网关互联、目录同步与跨区域故障转移
- v3.7：合规套件：PII 检测与脱敏、数据驻留策略、审计报表（SOC2 / GDPR）
- v3.8：开发者门户：自助申请 API Key、用量看板、交互式工具文档
- v3.9：v4 弃用警告与配置迁移工具（`mcp-gateway migrate`），性能基准与压测报告
- v4.0：（破坏性）配置 schema v4、插件 API v3、移除 v3 弃用项、全面文档与迁移指南
