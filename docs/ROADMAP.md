# Roadmap

Post-7.0 plan for mcp-gateway. Every minor release stays backward compatible within 7.x; v8.0 is the next breaking
release. (The 6.x → 7.0 plan is complete; see the [CHANGELOG](../CHANGELOG.md).)

- ✅ v7.1：Terraform Provider：用 Terraform 声明式管理服务器、密钥、策略与租户
- v7.2：多租户 SaaS 控制台：租户自助开通、配额与计费视图、组织级管理
- v7.3：提示注入防御与工具输出净化：入站检测、出站内容清洗与隔离标记
- v7.4：语义缓存：基于向量相似度命中工具结果，支持按租户隔离与失效策略
- v7.5：工具版本管理与灰度发布：多版本并存、按比例 / 按客户端逐步切流
- v7.6：离线桌面网关：单机打包、本地工具与断网可用的策略执行
- v7.7：审批 2.0：多级、条件式审批流与超时升级
- v7.8：自动化合规报告：按计划生成 SOC 2 / ISO 27001 / GDPR 证据包
- v7.9：v8 弃用警告与 `migrate --to 8`
- v8.0：（破坏性）插件 API v5（WASM 组件模型）、移除旧插件接口、迁移指南
