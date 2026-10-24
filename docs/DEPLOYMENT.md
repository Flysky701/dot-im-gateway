# Linux 部署手册

## 快速路径（推荐，可全自动）

新手直接把 [服务器部署 Skill](../skills/deploy-dot-im-gateway/SKILL.md) 交给有终端能力的 Agent。手动执行时只有三步：

```sh
# 1. 服务器上，从固定提交的检出运行（幂等；已绑定在用时自动备份并升级）
bash scripts/server-bootstrap.sh
# 2. 可选但推荐：退出登录后和开机后仍运行（需要 sudo 一次）
sudo loginctl enable-linger "$USER"
# 3. 自己电脑上：打开一次性绑定页，完成后结果移交常驻服务
ssh -L 127.0.0.1:8789:127.0.0.1:8789 <服务器> '<BIN> --handoff <PREFIX> --port 8789 --no-browser'
```

`server-bootstrap.sh` 检查 Linux x64、普通用户、`systemd --user`、Python 3.10+、curl/xz；把固定版本 Node 24.21.0（校验 SHA256）装到 `~/.local/share/dot-im-gateway-tools`，不改系统；离线自检后用 `deploy.py install --apply` 安装服务；取得与当前源码**提交完全一致**的单文件程序：Release 的 `.sha256` 和 `.build.json` 中的 `sourceCommit` 都匹配才使用，否则（含工作区有改动时）按固定依赖本机构建；已有同提交的程序时跳过；最后输出一行 JSON，含 `prefix`、`connect_binary`、`linger` 和下一步命令。它不接触任何账号凭据。可用环境变量 `PREFIX`、`TOOLS`、`PORT`、`CONNECT_BINARY` 覆盖默认值。

handoff 的行为见 [单文件程序](PORTABLE.md#移交常驻服务--handoff)：写入 0600 凭据文件、切换 `mode=live`、开启订阅并合并默认回调白名单（`chatgpt.com`、`.chatgpt.com`、`openai.com`、`.openai.com`，以 `.` 开头只匹配子域名），安装带归属标记的 `dot-im-tunnel.service`，重启并等待两个服务健康。之后：

```sh
bash scripts/server-status.sh    # 一行 JSON：服务状态、live、tunnel 就绪、已启用平台、linger、队列计数；不含秘密
```

最后在 [ChatGPT Plugins](https://chatgpt.com/plugins) 添加 Connection 为 Tunnel 的插件（认证选无，网关令牌由 tunnel-client 自动附带），把连接页给出的订阅提示词发给原 dot，连接页会实时显示 ChatGPT 连通与事件订阅状态，并做一次手机实收验收。

下面是各步骤的底层说明，供手动排查或不使用 handoff 时参考。所有 `deploy.py` 命令默认只展示计划；`--apply` 才修改选定 prefix 和本用户的 systemd unit。

## 准备与离线安装

1. 核实目标 Linux、服务账号、磁盘、现有 dot 网关/同名 systemd unit 和端口占用。Node.js 24.21.0 或更新 24.x 从官方发行版安装并验证官方校验和；Python 3.10+。不自行修改防火墙、代理或安全策略。
2. 从本仓库检出用户审阅的提交，核对 commit SHA。`npm ci --offline --ignore-scripts && node scripts/release-check.js`；全部不依赖外部账号。
3. 选择专用目录，例如 `$HOME/.local/lib/dot-im-gateway`。路径不能包含空格或 shell 字符。已有目录必须有本项目安装 marker，否则拒绝接管。

```sh
python3 scripts/deploy.py install --prefix "$HOME/.local/lib/dot-im-gateway"
# 审核计划且已获目标部署授权后：
python3 scripts/deploy.py install --prefix "$HOME/.local/lib/dot-im-gateway" --apply
```

脚本将选定源码复制到按内容哈希命名的 `releases/<hash>`，核对每个文件后切换 `current` 软链接，创建离线配置和 0700 数据目录，生成 systemd **用户**服务并 enable；首次安装不启动服务，不创建任何密钥。重复 install 核对既有 release，不覆盖运行配置。`--no-systemd` 仅用于离线临时目录演练，不安装/启动系统服务。

## 必须有人交互的授权关卡

### A. 平台扫码、账号和稳定 ID

用户自行在官方 QQ bot / 微信 iLink 支持的授权流程中扫码，确认具体账号和凭据持久化范围。网关不附带二维码登录器、不导入别的 Agent 的凭据目录。优先使用已批准的官方凭据。

- QQ：填入 bot `appId`、本人 `ownerId=user_openid`、secret 的环境变量名。官方文档配置使用 `apiProfile=documented`；已批准且与 SDK 端点契约匹配时可选 `tencent-sdk`。从实际官方 Gateway discovery 核实 WSS hostname 后填精确 `gatewayHosts`；不得用通配符或猜测域名。
- 微信：填入 `ownerId=ilink_user_id`、`botId=ilink_bot_id` 和 token 环境变量名。API 默认 `ilinkai.weixin.qq.com`，CDN 默认 `novac2c.cdn.weixin.qq.com`；如官方返回新 API host，单独核实其腾讯域名和授权范围再改配置。没有可核实稳定 ID 就停在本关，不能用昵称、头像或“第一条消息是谁”自动绑定。
- QQ 扫码由单文件程序内置的腾讯官方 `@tencent-connect/qqbot-connector@1.2.0` 完成（UNLICENSED，见[第三方声明](THIRD_PARTY_NOTICES.md)）；常驻服务本身不安装它。handoff 会自动填入上述 ID 和 `gatewayHosts`（`api.bot.qq.com`、`api.sgroup.qq.com`）。

### B. 长期凭据

使用 handoff 时以下文件由程序自动写入（0600，原子替换），无需手动编辑。


用户在目标主机私有编辑器/秘密管理器内提供环境文件 `prefix/runtime.env`，权限 0600；里面仅需所启用平台的 secret 和 gateway bearer。环境变量名见 `config.example.json`，不要把值复制到终端命令参数、聊天或工单。不将 env 文件提交 Git。

Gateway bearer 至少 32 字符，使用用户批准的随机凭据。环境文件包含 `DOT_GATEWAY_TOKEN`、启用 QQ 时的 `DOT_QQ_SECRET`、启用微信时的 `DOT_WEIXIN_TOKEN`。用户应知道这些凭据会长期保存在目标主机，知道如何撤销；未确认就不写入或启用 live。

先保持 `mode=offline`，启动 loopback 服务后 `doctor` 和只读 MCP 调用验证本地鉴权。需要真人测试时经授权将目标平台 `enabled=true`、`mode=live`。修改配置要重启服务；数据目录绑定不可悄悄变更。

### C. 官方 Secure MCP Tunnel 与原 dot

使用 https://github.com/openai/tunnel-client/releases/latest 或 Platform Tunnel 设置的官方下载；记录实际下载版本和校验和，保留发行包许可证。不复制社区安装脚本执行。

运行 `tunnel-client help quickstart`，对照 [官方最新指南](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels) 配置命名 profile。MCP 本地地址是 `http://127.0.0.1:8788/mcp`。按当前官方支持的 profile/auth 配置安全转发 gateway bearer；不把 bearer 放在 `ExecStart` 参数里，不为“先跑通”禁用本服务鉴权。

明确目标 Platform organization、ChatGPT workspace、已存在的原 dot、tunnel ID。检查是否可复用现有 Tunnel。创建/修改 Tunnel 需要 Read+Manage；运行官方客户端需要 Read+Use；不要扩大权限或复制其他项目的运行密钥。本阶段没有执行这些操作。

使用 handoff 时，程序把内置官方客户端安装到 `prefix/bin/tunnel-client`，Tunnel 设置写入 `prefix/tunnel-runtime.env`，并安装 `dot-im-tunnel.service`（与单文件程序相同的参数，健康检查 `127.0.0.1:8790`），无需下面的手动步骤。不使用 handoff 时，经用户授权配置后执行 `tunnel-client doctor --profile dot-im-gateway --explain`，独立运行 `tunnel-client run --profile dot-im-gateway`。`deploy/tunnel-client.service.example` 需要替换经过核实的绝对路径，单独安装；其 runtime 环境文件与 gateway 分开。不由本项目自动创建 Tunnel 或调用内部 API。

在目标 ChatGPT 中添加/复用私人自定义 MCP 连接（Connection: Tunnel），绑定同一个 Tunnel。让**原 dot** 执行只读 gateway_status；仅工具结果成功才算隧道工具链路通过。不调用模型 API 替代原 dot。若当前 tunnel-client 没有满足必要 header 转发的官方配置机制，报告具体版本/能力阻塞，不猜参数。

### D. 真实事件订阅

向用户展示订阅行为：分别订阅 `message.created`、filter `platform=qq` 与 `platform=weixin`，事件进入同一个原 dot；触发后优先读信，普通对话直接自然回复 final，耗时任务才按需发有意义的进度 ack，最终结果回原渠道。将规则保存在原事件任务的说明中，网页回复不算渠道回信；升级保留原任务和订阅，详见[事件回信规则](../skills/deploy-dot-im-gateway/references/event-replies.md)。无跨平台广播。

handoff 成功即视为用户同意订阅：`allowSubscriptions=true`，回调白名单默认 `chatgpt.com`、`.chatgpt.com`、`openai.com`、`.openai.com`。手动配置时同样把 `allowSubscriptions` 改为 true，并填写白名单；精确条目只匹配该主机名，以 `.` 开头的条目只匹配其子域名（不匹配 `evil-openai.com` 或 `openai.com.evil`）。未知 callback 将失败关闭。让用户在原 dot 请求建立订阅；网关验证签名 challenge 后才持久化。不能由部署脚本伪造订阅来源或代替原 dot 创建事件任务。

## 常驻和验收

```sh
systemctl --user start dot-im-gateway.service
systemctl --user status dot-im-gateway.service
journalctl --user -u dot-im-gateway.service --since today
```

官方 tunnel-client 服务运行后（handoff 自动完成），执行 [真人验收清单](ACCEPTANCE.md)。用户服务随登出/开机保活需要 linger：`sudo loginctl enable-linger "$USER"`；bootstrap 和 handoff 都会报告当前 linger 状态，但不会自行修改。服务器重启、断网和 token 失效应在用户测试环境验证。
