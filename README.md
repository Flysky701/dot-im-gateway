# dot-im-gateway

把本人 QQ / 微信私聊接到已有的 OpenAI dot，让它读取消息、处理任务，再回到原渠道回复。

## 功能

- 文字收发、连续消息合并、任务进度回复。
- 常驻模式支持主动文字通知、文件传递和来信自动触发。
- QQ 支持图片及文件，微信支持图片及 PDF，单个文件最大 4 MiB。
- 断网恢复、消息状态及耗时查询。

## 运行方式

| | Windows 临时连接 | Linux 服务器常驻 |
|---|---|---|
| 能力 | 一个渠道的文字收发 | QQ / 微信共用实例，支持完整功能 |
| 来信处理 | 让 dot 主动查看 | 订阅事件后自动触发 |
| 在线方式 | 程序运行时在线 | 系统服务持续运行 |

## 使用

需要本人 QQ / 微信、支持私人插件及 Tunnel 的 ChatGPT 工作区，以及 Windows x64 电脑或 Linux x64 服务器。

**推荐交给 Agent 配置**，把下面这段发给 Codex 等能操作终端的 Agent：

```text
请按这个 Skill 帮我连接已有的 dot：
https://github.com/Flysky701/dot-im-gateway/blob/v0.1.1/skills/connect-dot-im-gateway/SKILL.md

运行方式：Windows 临时连接 / Linux 服务器常驻（选一个）
平台：QQ / 微信（选一个）
复用已有实例和配置，需要我登录或扫码时再提示。
```

**自己配置：**

1. 从 [Releases](https://github.com/Flysky701/dot-im-gateway/releases) 获取源码，按 [Windows 构建说明](docs/PORTABLE.md)或[服务器部署说明](skills/deploy-dot-im-gateway/SKILL.md)安装。`v0.1.1` 暂不提供预编译程序。
2. 准备 Tunnel 和仅有 `Tunnels: Read + Use` 权限的密钥，直接填入连接页，再扫码绑定。
3. 在 ChatGPT 添加私人插件，Connection 选对应 Tunnel、Authentication 选 None，然后在目标 dot 启用。临时模式让 dot 查看消息；常驻模式订阅 `message.created`，指定 `platform=qq` 或 `platform=weixin`。

仅支持已绑定本人私聊。主动消息受平台限制，微信无上下文发送为实验能力；`accepted` 表示平台接受，不等于手机送达。

## 文档

[连接与构建](docs/PORTABLE.md) · [服务器部署](docs/DEPLOYMENT.md) · [故障处理](docs/OPERATIONS.md) · [主动通知](docs/NOTIFICATIONS.md) · [第三方许可](THIRD_PARTY_NOTICES.md)
