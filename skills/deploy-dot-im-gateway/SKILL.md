---
name: deploy-dot-im-gateway
description: Fully automated 24x7 server deployment for beginners over SSH via 3-tier automation (Plan A full browser automation, Plan B assisted browser navigation, Plan C server-side guided).
---

# 服务器全自动部署：7×24 在线，来消息自动叫醒 dot

完成后服务器上有两个 systemd 用户服务：`dot-im-gateway.service`（收发消息、队列、事件推送）和 `dot-im-tunnel.service`（官方 tunnel-client）。它们崩溃自动重启、断网自动重连、开机自启（需开启 linger）；本人发到 QQ/微信的消息会通过事件自动唤醒原 dot。

用户是完全的新手。**你（Agent）负责全部技术操作**。

---

## 3 种执行模式（Agent 在第 0 步自检工具权限并选择）

Agent 在开始前自动检测自身具备的工具能力，自动匹配最高可用等级（或遵照用户指定）：

### Plan A（全权代操模式 — Agent 具备「终端/SSH + 已登录浏览器页面操控工具」如 Browser / Playwright / CDP）
- **小白只需做 2 件事**：① 发一次提示词并回复「同意」（未登录网页时登录一下）；② 拿起手机扫一次码。其余全自动连好！
- **Agent 自动执行**：
  1. SSH 登录服务器部署常驻服务并开启 `linger`；
  2. 在用户已登录的浏览器自动打开 [OpenAI Platform Tunnels](https://platform.openai.com/settings/organization/tunnels) 复用或新建关联当前 ChatGPT 工作区的 Tunnel；在 [API Keys](https://platform.openai.com/settings/organization/api-keys) 新建 `Restricted`（仅 `Tunnels: Read + Use`）运行密钥，直接填入 `127.0.0.1` 本机连接页 DOM（**严禁将密钥读入聊天上下文、日志或文件**）；
  3. 自动在连接页选好平台并点击「开始连接」，提示用户拿起手机扫码；
  4. 移交常驻服务后，自动在浏览器打开 [ChatGPT Plugins](https://chatgpt.com/plugins) 点击 Add custom MCP server，添加 `dot-im-gateway`（`Connection: Tunnel` 选对应 `tunnel_hint`，`Authentication: None`，勿选 OAuth；若弹出官方免责确认框且需要人工确认则请用户点一下，或在获全授权时自动完成）；
  5. 自动切回原 dot 对话，关闭旧同名测试插件、启用新插件并发送简短订阅指令；
  6. 终端轮询 `server-status.sh` 核验 `"ok": true`、`mcp_requests >= 1` 且 `queue.subscriptions >= 1`（连接页两项状态同步变绿）；
  7. 请用户拿手机发一句「你好」实测验收！

### Plan B（半自动领航模式 — Agent 具备「终端/SSH + 打开本机浏览器/写剪贴板」，无网页内代点权限）
- **小白只需做「点确定、复制、粘贴、扫码」**：不用找入口、不用敲命令、不用打字。
- **Agent 自动执行**：
  1. SSH 部署服务端并自动在用户电脑弹出 `127.0.0.1` 本机连接页；
  2. 引导用户按连接页内清晰的两步指引操作，依次用系统默认浏览器帮用户弹出 Tunnels 页面与 API Keys 页面；
  3. 用户填入两项并手机扫码交接；
  4. 扫码成功后，Agent 自动弹出 `https://chatgpt.com/plugins`，并将 `dot-im-gateway` 写入系统剪贴板（引导用户粘贴名称、选页面显示的 `tunnel_xxxxxx...`、选 `None`、点确定）；
  5. 后台轮询 `server-status.sh` 检测到 `mcp_requests >= 1` 后，自动将订阅指令写入剪贴板，提醒用户去原 dot 按 `Ctrl+V` 发送；
  6. 检测到 `queue.subscriptions >= 1`（连接页两项全绿）即提示验收！

### Plan C（服务端代配 + 分步向导模式 — Agent 仅能访问服务器或受限终端，无法打开用户本机浏览器）
- **Agent 全自动配好服务器常驻与监控，每次只给一步极简指引**：
  1. SSH 完成服务端部署与自检；
  2. 给出一句本地端口转发命令供用户在自己电脑终端运行打开连接页；
  3. 用户扫码移交后，Agent 根据 `server-status.sh` 的 `tunnel_hint`、`mcp_requests`、`queue.subscriptions` 实时盯盘；
  4. 一步一句引导用户完成 ChatGPT 插件添加（强调 `Authentication: None`）与订阅验收。

---

## 规则

1. **一次确认**：第 0 步确认后，本文件内的步骤直接执行，不再逐个询问。只有超出范围时再问：用 sudo 安装系统软件包或开启 linger、换服务器、换绑另一个账号/机器人、卸载。
2. **秘密不进聊天**：Tunnel 运行密钥、QQ AppSecret、二维码、手机验证码、连接页链接（`#` 后是一次性令牌）不复述、不截图、不写进文件或命令参数。密钥只在 `127.0.0.1` 连接页里输入。
3. **安全底线**：不关闭 SSH 主机密钥校验；不改防火墙、不开放公网端口；服务不用 root 运行；不读取 `runtime.env`、`tunnel-runtime.env` 的内容。
4. **自动排错**：每一步都看输出中的 JSON 和错误码，按 [故障恢复](#故障恢复) 处理；同一错误最多自动重试一次，仍失败再用一两句话告诉用户原因和下一步。
5. **证据才算完成**：[验收](#第-7-步验收) 两项（服务与自动唤醒）都有证据之前不说「已完成」。

## 第 0 步：一次确认

先问清两件事：服务器登录方式（`ssh <别名>` 或 `用户名@地址`）、平台（QQ 或微信，以后可以再加另一个）。然后发：

> 我将为你：① 在服务器 `<HOST>` 的当前用户下安装 dot-im-gateway（不需要 root，目录 `~/.local/lib/dot-im-gateway`）；② 把机器人凭据和 Tunnel 运行密钥保存在该服务器上只有你能读的文件里（权限 0600）；③ 设置崩溃自动重启、断线重连和开机自启（可能需要你输入一次 sudo 密码）；④ 开启来信事件，只允许推送到 chatgpt.com / openai.com；⑤ 只处理你本人发给自己机器人的私聊：QQ 仅文字；微信是文字和图片/PDF（单个不超过 4 MiB，在服务器保存 7 天），dot 也能用图片/PDF 回复你。之后随时可以一条命令卸载，数据会保留。回复「同意」开始。

下文 `<HOST>` 指用户给出的 SSH 目标。

## 第 1 步：检查服务器

```sh
ssh -o BatchMode=yes -o ConnectTimeout=15 <HOST> 'uname -sm; id -un; id -u; systemctl --user is-system-running 2>&1; loginctl show-user "$USER" -p Linger --value 2>&1; for c in git python3 curl xz tar; do command -v $c >/dev/null || echo "missing:$c"; done'
```

- **连不上 / 要密码 / 主机密钥未知**：让用户在自己的终端运行一次 `ssh <HOST>`，按提示确认主机指纹、输入密码后退出；可选帮用户运行 `ssh-copy-id <HOST>` 配置免密。不要加 `StrictHostKeyChecking=no`。
- **不是 `Linux x86_64`**：停止，说明目前只支持 Linux x64。
- **uid 是 0（root）**：服务不能用 root 运行。请用户确认后创建普通用户（例如 `adduser dot`），之后用该用户登录。
- **有 `missing:`**：经用户同意后安装，Debian/Ubuntu 用 `ssh -t <HOST> 'sudo apt-get update && sudo apt-get install -y git python3 curl xz-utils'`，RHEL/Fedora 用 `sudo dnf install -y git python3 curl xz tar`（`-t` 让用户直接在终端输入 sudo 密码）。
- **`systemctl --user` 报错**：先做第 3 步开启 linger，再重新 SSH 登录检查。

## 第 2 步：拉取固定版本并一键安装

先在服务器上取得源码，并列出可选版本（最新的 `v*` 标签和 main 的最新提交）：

```sh
ssh <HOST> 'D=$HOME/dot-im-gateway-src; [ -d $D/.git ] || git clone -q https://github.com/Flysky701/dot-im-gateway $D; cd $D && git fetch -q --tags --force origin && echo "tag=$(git tag --sort=-v:refname -l "v*" | head -1)" && echo "main=$(git rev-parse origin/main)"'
```

`REF` 默认用输出的 `tag`（有对应 Release 时可直接下载与之匹配的连接程序，省去构建）；没有标签，或用户明确要最新开发版时，用 `main` 的提交号。然后安装（可重复运行；已安装并在用时会自动备份后升级）：

```sh
ssh <HOST> 'cd ~/dot-im-gateway-src && git checkout -q --detach <REF> && echo "commit=$(git rev-parse HEAD)" && bash scripts/server-bootstrap.sh'
```

记下输出的 `commit`，汇报时要用。[server-bootstrap.sh](../../scripts/server-bootstrap.sh) 会：检查系统 → 安装固定版本 Node 24.21.0（校验 SHA256，只装在用户目录）→ 离线自检并安装或升级服务 → 取得**与该提交完全一致**的单文件程序（Release 的 `.sha256` 和 `.build.json` 里的源码提交都对上才使用，否则在服务器上按固定依赖构建，约 1～3 分钟）→ 自检。它不接触任何账号凭据。最后一行 JSON 里记下 `prefix`、`connect_binary`、`linger`。以 `STOP:` 开头的输出给出了原因和 `HINT`，照做后重跑。

## 第 3 步：开机自启（linger）

第 2 步输出 `"linger":"yes"` 就跳过。否则：

```sh
ssh -t <HOST> 'sudo loginctl enable-linger "$USER"'
```

用户没有 sudo 权限时继续后面的步骤，但要告诉用户：「退出 SSH 登录或服务器重启后服务会停，需要管理员执行上面这条命令。」

## 第 4 步：准备 Tunnel（首次，两步搞定）

重新绑定、补加另一个平台时，服务器已保存配置，连接页会显示「已沿用现有 Tunnel（点击更换）」，跳过本步。

首次只需两步（直接填进连接页，无需组织 ID，**不要发到聊天里**）：

1. **① Tunnel ID**（`tunnel_` 开头）：打开 [Platform Tunnel 设置](https://platform.openai.com/settings/organization/tunnels)，有可用的就复用，没有就新建一个并关联到原 dot 所在的 **ChatGPT 工作区**，复制 `tunnel_...` 编号（新建通道本身不会生成 Key）。
2. **② 受限运行密钥（API Key）**：打开 [API keys 页面](https://platform.openai.com/settings/organization/api-keys)，点 **Create new secret key**，切换到 **Restricted**，仅将 **Tunnels** 设为 **Read + Use**（其余全 None）。复制生成的 `sk-...` 密钥直接填入连接页。

页面提示「Tunnels access required」或没有新建按钮：说明账号缺少权限，需要组织所有者授予权限。参考 [官方指南](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels)。

## 第 5 步：打开一次性绑定页（handoff）

在用户电脑上**后台**运行，并保持运行（用第 2 步得到的 `connect_binary` 和 `prefix`）：

```sh
ssh -o ExitOnForwardFailure=yes -L 127.0.0.1:8789:127.0.0.1:8789 <HOST> '<connect_binary> --handoff <prefix> --port 8789 --no-browser'
```

- 输出中 `Open in your own browser` 的下一行是连接页链接。**直接用本机默认浏览器打开它，不要把链接贴进聊天**：Windows `Start-Process '<链接>'`，macOS `open '<链接>'`，Linux `xdg-open '<链接>'`。
- 本机 8789 端口被占用：两处 8789 都换成 8799。
- 用户在页面操作：选 QQ（推荐扫码）或微信 → 填 Tunnel 两项（首次） → 勾选同意 → 点开始连接 → 手机扫码确认。
- 移交常驻服务后，页面展示**实时状态清单**（`✓ 服务器常驻已启动`、等待插件连通、等待事件订阅）和**两步极简配置卡片**。

## 第 6 步：在 ChatGPT 添加插件并订阅（首次）

已添加过插件、只是重新绑定时跳过添加，只在新加平台时补订阅。

1. 打开 [ChatGPT Plugins](https://chatgpt.com/plugins) → 加号 → **Add custom MCP server**。
2. 名称填 `dot-im-gateway`；**Connection** 选 **Tunnel**，选连接页展示的同一个通道（`tunnel_...`）。
3. **Authentication** 选 **None**（勿选 OAuth）：网关令牌由服务器上的 tunnel-client 自动附带。
4. 阅读风险提示 → **I understand and want to continue** → **Create as a plugin**。
5. 在原 dot 中启用这个插件，把连接页给出的极简订阅提示词发给原 dot：

   ```text
   请订阅私人插件 dot-im-gateway 的 message.created 事件（platform=weixin）。收到微信消息后按插件说明读取，先回 ack“收到”，处理完再回 final。
   ```
   （如果是 QQ，把 `weixin`/微信 换成 `qq`/QQ）。

页面上的 `⏳ 等待 ChatGPT 连接插件…` 和 `⏳ 等待原 dot 完成事件订阅…` 会实时自动变成绿色对勾 `✓`！

## 第 7 步：验收

两项都有证据才算完成：

1. **服务器状态**：`ssh <HOST> 'bash ~/dot-im-gateway-src/scripts/server-status.sh'` 输出 `"ok": true`、`mcp_requests >= 1` 且 `queue.subscriptions >= 1`，连接页清单显示全部完成。
2. **自动唤醒实测**：让用户用手机给机器人发「你好」，**不要**在聊天里手动叫 dot；手机上先收到 ack（「收到」），处理完成后收到 final 回复。

## 汇报

用 4～6 行告诉用户：服务器、平台、部署提交号、验收结果、linger 状态，以及以后常用的三句话：
- 「重新扫码 / 凭据失效」：让 Agent 重新执行本 Skill 第 5 步（Tunnel 留空即沿用）。
- 「查看状态」：让 Agent 运行 `server-status.sh`。
- 「升级 / 卸载」：见下文。

## 日常维护（都由 Agent 执行）

| 需求 | 做法 |
|---|---|
| 查看状态 | `ssh <HOST> 'bash ~/dot-im-gateway-src/scripts/server-status.sh'` |
| 看日志 | `ssh <HOST> 'journalctl --user -u dot-im-gateway -u dot-im-tunnel -n 100 --no-pager'`（日志不含消息正文和密钥） |
| 重新扫码、换密钥、凭据失效 | 重复第 5 步。换 Tunnel 或运行密钥时两项都重新填写 |
| 再加另一个平台 | 重复第 5 步，选另一个平台；两个平台共用同一服务；再做第 6 步第 5 点的订阅 |
| 升级 | 重复第 2 步，选新的 `REF`（自动备份、保留数据和凭据，重启服务，并换上同一提交的连接程序），再运行状态检查 |
| 回滚 | `ssh <HOST> 'cd ~/dot-im-gateway-src && PATH=$HOME/.local/share/dot-im-gateway-tools/node-v24.21.0-linux-x64/bin:$PATH python3 scripts/deploy.py rollback --apply'` |
| 卸载（需用户确认） | 把上一行的 `rollback` 换成 `uninstall`：停止并移除两个服务，保留数据、配置和凭据文件。要彻底删除凭据，再经用户确认删除 `~/.local/lib/dot-im-gateway` |
| 换绑另一个 QQ 号/微信号或机器人 | 同一数据目录不允许换人（错误码 `different_owner_requires_new_data_directory`），防止旧消息发给别人。经用户确认后先卸载，再用新目录重装：`PREFIX=$HOME/.local/lib/dot-im-gateway-2 bash scripts/server-bootstrap.sh`，之后第 5 步改用新目录 |

## 故障恢复

| 现象 / 错误码 | 原因 | 处理 |
|---|---|---|
| `STOP: user_systemd_unavailable` | 没有 systemd 用户会话 | 做第 3 步，重新 SSH 登录后重跑第 2 步 |
| `STOP: node_checksum_mismatch` / `release_checksum_mismatch` | 下载损坏或被篡改 | 重跑一次；仍失败就停止并告诉用户，不要跳过校验 |
| `service_not_installed` / `gateway_unit_missing` | 服务没装好或目录不对 | 重跑第 2 步；确认第 5 步用的是第 2 步输出的 `prefix` |
| `data_directory_in_use` 或页面打不开 | 服务器上已有另一个连接程序在运行 | 结束之前的第 5 步 SSH 会话后重试 |
| `invalid_identifier` | Tunnel ID 或 AppID 格式有误 | Tunnel ID 需以 `tunnel_` 开头；两项要么都填，要么（已保存时）都留空 |
| `tunnel_auth_failed` | Tunnel ID 不存在或运行密钥缺少权限 | 检查 API Key 是否为 Restricted 且勾选 Tunnels: Read + Use |
| `tunnel_settings_required` | 首次绑定没填 Tunnel 两项 | 做第 4 步后重新第 5 步 |
| `unsupported_secret_characters` | 密钥含单引号或换行 | 新建一个密钥再填 |
| `qq_qr_expired` / `qq_qr_timeout` / `binding_timeout` | 扫码或确认超时 | 重新第 5 步，拿到二维码后两分钟内完成 |
| `qq_qr_app_mismatch` / `qq_qr_selection_rejected` | 手机上选错了机器人 | 重新第 5 步，选正确的机器人 |
| `qq_token_rejected` / `qq_qr_credentials_rejected` | 机器人凭据无效或被重置 | 重新第 5 步扫码；手动方式要在 [QQ 开放平台](https://q.qq.com/) 核对 AppSecret |
| `different_owner_requires_new_data_directory` | 想换绑另一个人或机器人 | 见「日常维护」最后一行 |
| `unrelated_tunnel_unit_exists` | 服务器上已有别的 `dot-im-tunnel.service`（`~/.config`、`/etc/systemd/user` 或临时 unit） | 不要覆盖；把该文件的用途告诉用户，由用户决定 |
| `gateway_unit_not_ours` | systemd 实际加载的 `dot-im-gateway.service` 不是本安装那份（例如来自临时 unit） | 不要停止它；运行 `systemctl --user show -p FragmentPath dot-im-gateway.service`，把结果告诉用户 |
| `systemd_user_unavailable` | 当前登录方式连不上用户级 systemd（常见于 `su` / `sudo -u` 切换用户） | 直接用该用户 SSH 登录后重试 |
| `gateway_not_healthy` | 网关没能以 live 模式启动 | 看 `journalctl --user -u dot-im-gateway -n 50`；修复后重新第 5 步 |
| `tunnel_not_ready` | 运行密钥权限不对、Tunnel 被删除 | 看 `journalctl --user -u dot-im-tunnel -n 50`；核对第 4 步两项，重新第 5 步填写 |
| `systemctl_failed` / `service_stop_failed` | 用户级 systemd 异常 | `systemctl --user status dot-im-gateway dot-im-tunnel`；检查 linger 后重试 |
| 第 5 步中途 SSH 断开 | 绑定没完成 | 程序会恢复原来在运行的服务；直接重新第 5 步。若服务仍停着：`systemctl --user start dot-im-gateway dot-im-tunnel` |
| `ok` 为 false，服务为 `failed`/`activating` | 服务反复重启 | 看日志；网络恢复后会自动重连，无需重新绑定 |
| 消息到了但 dot 没反应 | 没订阅、订阅失效或插件没启用 | 检查连接页 `chk-sub` 或 `server-status.sh`；把订阅提示词再发给原 dot |
| 回复显示 `uncertain` | 可能已发送但未确认 | 不要自动重发；见 [运维手册](../../docs/OPERATIONS.md) 的 reconcile |

更多背景：[部署手册](../../docs/DEPLOYMENT.md)、[运维手册](../../docs/OPERATIONS.md)、[单文件程序](../../docs/PORTABLE.md)、[安全边界](../../docs/SECURITY.md)。

## 第三方组件

QQ 扫码使用打包进单文件程序的腾讯官方 `@tencent-connect/qqbot-connector` 1.2.0（UNLICENSED，不属于本项目 MIT 许可范围），详见 [第三方声明](../../THIRD_PARTY_NOTICES.md)。不要复制其私有接口或修改品牌信息。
