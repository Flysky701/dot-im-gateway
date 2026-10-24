# dot-im-gateway

把本人 QQ / 微信私聊接到已有的 OpenAI dot，让它读取消息、处理任务，再回到原渠道回复。

网关只负责连接和传递消息，不创建 Agent，也不调用模型 API。

## 能做什么

- **私聊收发**：只连接已绑定的本人账号，不支持群聊或其他收件人。
- **自然回复**：普通消息直接回复；耗时任务可以先发进度。连续短句可合并处理。
- **主动通知**：常驻模式下，Agent 可以向本人发送文字通知；定时触发由 Agent 安排。
- **文件传递**：常驻模式支持 QQ 图片及文件、微信图片及 PDF，单个文件最大 4 MiB。
- **自动恢复**：常驻服务支持断网重连、进程重启与开机启动；临时微信连接支持短暂网络故障重试。
- **状态查询**：查看消息是否入队、平台是否接受，以及各阶段耗时。结果不确定时不盲目重发。

## 选一种用法

| | Windows 临时连接 | Linux 服务器常驻 |
|---|---|---|
| 适合 | 先试用、偶尔使用 | 希望持续在线 |
| 收发范围 | 一个渠道的本人文字私聊 | QQ、微信可共用一个实例，支持文件与主动通知 |
| 来信处理 | 主动让 dot 查看消息 | 配置事件订阅后自动触发 dot |
| 退出后 | 关机、睡眠或退出程序即断开，重启需重新连接 | 由系统服务继续运行，需开启自启动 |
| 凭据 | 登录凭据只保留在内存中 | 保存在服务器的私有凭据文件中 |

## 快速开始

需要本人 QQ / 微信、可使用私人插件及 Tunnel 的 ChatGPT 工作区，以及 Windows x64 电脑或可 SSH 登录的 Linux x64 服务器。

### 让 Agent 帮你连接

把下面这段发给能操作终端的 Agent，例如 Codex，把运行方式和平台改成自己的选择：

```text
请按这个 Skill 帮我连接已有的 dot：
https://github.com/Flysky701/dot-im-gateway/blob/v0.1.1/skills/connect-dot-im-gateway/SKILL.md

运行方式：Windows 临时连接 / Linux 服务器常驻（选一个）
平台：QQ / 微信（选一个）
优先复用已有实例和配置。你完成技术操作，需要我登录、扫码或确认时再提示。
```

Agent 会按实际权限选择操作方式；登录、扫码和平台要求的本人确认仍由你完成。

### 自己操作

1. 从 [Releases](https://github.com/Flysky701/dot-im-gateway/releases) 获取源码。本次 `v0.1.1` 是**源码发布**，不附带预编译程序；Windows 按[单文件构建说明](docs/PORTABLE.md#维护者构建用户不需要)构建，服务器按[部署 Skill](skills/deploy-dot-im-gateway/SKILL.md)安装。
2. 创建或复用 [OpenAI Tunnel](https://platform.openai.com/settings/organization/tunnels)，准备仅有 `Tunnels: Read + Use` 权限的受限密钥。密钥直接填连接页，不发到聊天或仓库。
3. 启动连接程序，选择 QQ 或微信，按页面提示扫码、确认绑定。服务器模式沿用同一实例追加平台即可。
4. 在 ChatGPT 添加私人插件：Connection 选择对应 Tunnel，Authentication 选择 None，并在目标 dot 中启用。
5. Windows 模式让 dot「用这个插件查看并回复我的新消息」。服务器模式让 dot 订阅该插件的 `message.created`，指定 `platform=qq` 或 `platform=weixin`，收到后读取并回复。

Windows 开着代理时若出现 `non_public_destination`，可使用可选的 `--public-dns` 参数；它只影响连接程序，不修改系统 DNS。详见[连接程序说明](docs/PORTABLE.md)。

## 使用前了解

- 主动消息受 QQ / 微信平台权限和频率限制；微信无上下文发送属于实验能力，不保证任意时间可达。
- `accepted` 表示平台接口接受，不等于手机送达。`uncertain` 表示可能已发送，先核对聊天记录，不要换标识反复重发。
- 临时模式没有来信自动唤醒、文件传递或主动通知。常驻模式的事件触发也不保证实时响应。
- 凭据过期或平台解除绑定后，需要更新凭据或重新绑定；不要同时启动两个实例争用同一机器人或 Tunnel。
- 本项目源码采用 MIT；QQ 扫码 SDK 的元数据为 `UNLICENSED`，不随本次源码 Release 再分发。来源与许可见[第三方声明](THIRD_PARTY_NOTICES.md)。

## 详细说明

- [单文件连接与构建](docs/PORTABLE.md) · [服务器部署](docs/DEPLOYMENT.md) · [故障处理、备份与恢复](docs/OPERATIONS.md)
- [主动通知与延迟查询](docs/NOTIFICATIONS.md) · [回复与消息合并](docs/CONVERSATION.md) · [QQ 文件](docs/QQ_MEDIA.md)
- [安全边界](docs/SECURITY.md) · [开发验证记录](docs/VALIDATION.md) · [历史实测记录](PROGRESS.md)

历史测试只代表对应版本和账号的一次结果，不代表所有账号或长期运行都已验证。本项目独立开发，不隶属 OpenAI 或腾讯。
