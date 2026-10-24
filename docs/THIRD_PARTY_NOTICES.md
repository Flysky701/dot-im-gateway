# 第三方许可与来源

本项目原创部分使用 MIT，见 LICENSE。参考项目固定提交见 references.lock.json；为清晰保留所阅读 MIT 项目的完整署名与许可证于 licenses/。本项目未捆绑这些项目的 Agent、桥接运行时、二进制或模型调用逻辑。

- Tencent/openclaw-weixin：MIT，Copyright (C) 2026 Tencent。微信协议字段、媒体 AES-128-ECB/PKCS7、CDN 上传下载以及消息构造依据该参考重新实现，保留其声明。
- Arcueid77/dot-qq-bridge：MIT，Copyright (c) 2026 A2KT。QQ 稳定身份、被动回复和网关状态设计参考该实现。其整体 MIT **不覆盖**第三方扫码依赖。
- `@tencent-connect/qqbot-connector@1.2.0`：官方 npm 元数据为 **UNLICENSED**，发布包没有独立 LICENSE/NOTICE。便携程序固定使用此版本，仅调用公开 `startQrConnect`，默认通用第三方来源，不伪装其他客户端。来源 https://www.npmjs.com/package/@tencent-connect/qqbot-connector ，完整性 `sha512-FAOUCvgxP4M9UiYbHrtVgJ7BavSlh1CHJPjeEQuTAkP9MZ91lX4yATqv6I/lB9yp15nVq+G2DaGSSJwQTSoSsA==`，锁定于 packaging/package-lock.json。原 package.json、README 随 `--licenses` 保留；该 SDK 不属于本项目 MIT 许可范围。
- 上述 SDK 不在仓库源码中，构建单文件时按 `packaging/package-lock.json` 获取并打包；依赖原声明随程序保留。
- SDK 依赖 `qrcode-terminal 0.12.0`：Apache-2.0，含 Kazuhiko Arase 2009 的 MIT QRCode 实现。保留包 LICENSE、原 QR 算法署名和 MIT 文本于 `--licenses`；实际页面二维码仍使用 qrcode-generator，不把 SDK 控制台二维码输出到日志。
- cd233ljx/wechat-dot-bridge、RerrentLinden/dots-wechat-bridge：各自 MIT；阅读其 NOTICE，保留参考许可证，未打包其 Python 依赖或音频组件。
- NousResearch/hermes-agent：MIT，Copyright (c) 2025 Nous Research；只参考 SessionSource 会话来源设计，不引入 Hermes 运行时。
- 模块化源码模式需要 Node.js 24，Python 3 部署脚本仅使用标准库。便携单文件内置官方 Node.js 24.21.0（含 SQLite、OpenSSL 等），保留完整官方 LICENSE，可通过 `--licenses` 查看；用户无需安装语言运行时。
- 微信临时测试的终端二维码渲染使用未修改 `qrcode 8.2` 官方 PyPI wheel，BSD-3-Clause，含原 QR 算法 MIT 署名；完整许可及固定 SHA256 见 vendor/。只从 wheel 加载，不执行安装脚本或改变系统 Python，不需要 Pillow。该依赖不用于主服务或部署脚本。
- 便携单文件内置未修改的 OpenAI tunnel-client 0.0.17 官方平台二进制，Apache-2.0，保留原 LICENSE、NOTICE 和对应平台依赖许可报告；运行时校验后临时解包，仍作为独立进程。固定下载 SHA256 见 `packaging/fetch.py`。不打包官方发行 ZIP 中的 cloudflared 可执行文件，不重新许可官方客户端。
- 便携页面内置 qrcode-generator 2.0.4，MIT，Copyright (c) 2009 Kazuhiko Arase；许可见 `licenses/qrcode-generator-MIT.txt`。它在本机生成二维码，不调用第三方二维码服务。构建工具 esbuild 0.25.12 / postject 1.0.0-alpha.6 均 MIT，只在构建机器使用，版本和完整性由 packaging/package-lock.json 固定，安装不运行 package scripts。
- Standard Webhooks 签名格式按公开协议自行实现，没有复制库源代码。MCP/OpenAI 文档仅为协议依据，不复制其文档全文。

项目为私人部署准备，源代码许可不授予微信、QQ、OpenAI 服务访问权限或替代相关平台条款。无任何厂商背书。
