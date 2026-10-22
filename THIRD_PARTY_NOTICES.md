# 第三方许可与来源

本项目原创部分使用 MIT，见 LICENSE。参考项目固定提交见 references.lock.json；为清晰保留所阅读 MIT 项目的完整署名与许可证于 licenses/。本项目未捆绑这些项目的 Agent、桥接运行时、二进制或模型调用逻辑。

- Tencent/openclaw-weixin：MIT，Copyright (C) 2026 Tencent。微信协议字段、媒体 AES-128-ECB/PKCS7、CDN 上传下载以及消息构造依据该参考重新实现，保留其声明。
- Arcueid77/dot-qq-bridge：MIT，Copyright (c) 2026 A2KT。QQ 稳定身份、被动回复和网关状态设计参考该实现。其整体 MIT **不覆盖**第三方扫码依赖。
- `@tencent-connect/qqbot-connector@1.2.0`：上游 THIRD_PARTY_NOTICES 记录 package metadata 为 **UNLICENSED**，没有独立 LICENSE；本项目不依赖、不安装、不复制、不分发它。任何后续扫码集成都要单独核对授权范围。
- cd233ljx/wechat-dot-bridge、RerrentLinden/dots-wechat-bridge：各自 MIT；阅读其 NOTICE，保留参考许可证，未打包其 Python 依赖或音频组件。
- NousResearch/hermes-agent：MIT，Copyright (c) 2025 Nous Research；只参考 SessionSource 会话来源设计，不引入 Hermes 运行时。
- Node.js 24（含 SQLite、OpenSSL 等组件）由操作员从官方发行版安装，保留官方发行包全部许可证。项目没有第三方 npm 运行依赖。Python 3 部署脚本仅使用标准库。
- OpenAI tunnel-client 从 https://github.com/openai/tunnel-client/releases/latest 独立安装，遵从其发行包 LICENSE/NOTICE；本项目既不分发也不重新许可该客户端。
- Standard Webhooks 签名格式按公开协议自行实现，没有复制库源代码。MCP/OpenAI 文档仅为协议依据，不复制其文档全文。

项目为私人部署准备，源代码许可不授予微信、QQ、OpenAI 服务访问权限或替代相关平台条款。无任何厂商背书。
