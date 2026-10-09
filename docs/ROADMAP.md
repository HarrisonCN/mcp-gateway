# Roadmap

Post-9.0 plan for mcp-gateway. Every minor release stays backward compatible within 9.x; v10.0 is the next breaking
release. (The 8.x → 9.0 plan is complete; see the [CHANGELOG](../CHANGELOG.md).)

- ✅ v9.1：多模态工具：图片 / 音频等二进制内容的流式传输、大小限制与内容类型策略
- ✅ v9.2：边缘 WASM 运行时 2.0：在边缘节点运行插件与轻量工具，冷启动更快、资源配额更细
- v9.3：机密计算 / TEE：在可信执行环境中运行敏感工具，远程证明（attestation）后才放行调用
- v9.4：全球工具注册中心：跨组织发布、发现与签名校验工具，支持镜像与版本固定
- v9.5：SLA 监控与赔付报告：按服务器 / 租户统计可用性与延迟目标，生成 SLA 违约与赔付报告
- v9.6：自愈：基于 SLO 与异常检测自动回滚、限流与摘除故障上游
- v9.7：后量子 TLS：支持混合后量子密钥交换（X25519MLKEM768）与证书策略
- v9.8：生态市场 GA：插件与工具市场正式可用，评分、审核与发布者认证
- v9.9：v10 弃用警告与 `migrate --to 10`
- v10.0：（破坏性）统一网关内核、schema v10、长期支持（LTS）版本、迁移指南
