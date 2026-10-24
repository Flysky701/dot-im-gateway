# 上游审查（2026-10-22）

2026-10-24 对话流程与 QQ 文件更新另固定核实了腾讯 `qqbot-nodejs`、`qqbot-agent-sdk` 和 Hermes 当前文件模块。采用点与固定 commit 见[对话流程](CONVERSATION.md#自然回复与连续短句)和 [QQ 文件参考](QQ_MEDIA.md#参考与验证)。仅参考协议和队列机制，没有复制实现或引入运行时依赖。

固定版本见 `references.lock.json`，不随 main 自动漂移。仅读取仓库文件，没有运行第三方安装器或复制其整个运行时。

| 项目 | 固定 commit | 阅读内容与采用点 |
|---|---|---|
| Arcueid77/dot-qq-bridge | b403176c980d460ecffa87dcd722dd8740fb6c37 | LICENSE、THIRD_PARTY_NOTICES、src/qq.js、src/gateway.js。采用稳定 openid、被动回复、连接状态/不确定结果边界。 |
| cd233ljx/wechat-dot-bridge | 67c726e15ae2de8b60d293d6f5e81107bd0b6ebc | LICENSE、NOTICE、transport.py、mcp.py；参考持久化和媒体/传输模块分界。 |
| RerrentLinden/dots-wechat-bridge | b00ebf8ae009556959917bdc802a8ed202e28d1e | LICENSE、NOTICE、probe/weixin.py；参考 owner-only 和脱敏连接错误。 |
| Tencent/openclaw-weixin | 874637a0dbc24050f72d1385add4fc6170a2d726 | LICENSE、docs/protocol.md、api/types/api、cdn/aes-ecb/cdn-upload/cdn-url/upload/pic-decrypt、messaging/send/send-media。实际微信协议主要依据。包版本 2.4.10。 |
| NousResearch/hermes-agent | 4e58c721c8cf9b51c46636ea84ea6a5cb540880a | LICENSE、gateway/session.py，核实真实项目。采用明确平台/会话来源、稳定身份与路径隔离的设计思路，不引入 Agent runtime。 |

用户提到的 Harmes 可能指 Hermes Agent。已核实 NousResearch/hermes-agent 是实际存在且包含 messaging gateway 的项目；这里只借鉴网关边界，不能声称用户已经确认其拼写含义。

腾讯 protocol 文档明确：客户端可选字段不构成完整服务器契约。因此本实现按实际字段和保守约束编码，`context_token` 必须存在，图片/PDF 上传后每条消息一个 item。服务端授权、窗口、限额和新平台版本行为必须真实验收。

OpenAI 协议依据：

- https://developers.openai.com/plugins/build/mcp-events
- https://developers.openai.com/api/docs/guides/secure-mcp-tunnels
- https://modelcontextprotocol.io/specification/2026-07-28/server/discover
- https://modelcontextprotocol.io/specification/2026-07-28/server/tools
- https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http

官方 MCP 2.0 `resultType` 在 `result` 内，能力探测使用 `server/discover`；每个 HTTP 请求含 metadata 和镜像头。事件为扩展方法，按 OpenAI 当前支持子集实现 webhook，不广告 poll/stream/gap/terminated 支持。官方 tunnel-client 单独运行；随部署查看官方最新 release 与 CLI help，再固定实际安装二进制版本和校验和，不将本项目的参考版本误当官方客户端固定版本。
