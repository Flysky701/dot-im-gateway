---
name: connect-dot-im-gateway
description: One-sentence entry for beginners to connect QQ or Weixin private chat to an existing OpenAI dot via 3-tier automation (Plan A full browser automation, Plan B assisted browser navigation, Plan C server-side guided).
---

# 一句话接入：把我的 QQ / 微信私聊连到已有的 dot

用户是完全的新手。**你（Agent）负责全部技术操作**：判断路线、下载、校验、运行、排错、验收。不要让用户读文档、改文件或自己拼命令。

---

## 3 种执行模式（Agent 在第 0 步自检工具权限并选择）

Agent 在开始前自动检测自身具备的工具能力，自动匹配最高可用等级（或遵照用户指定）：

### Plan A（全权代操模式 — Agent 具备「终端/SSH + 已登录浏览器页面操控工具」如 Browser / Playwright / CDP）
- **小白只需做 2 件事**：① 发一次提示词并回复「同意」（未登录网页时登录一下）；② 拿起手机扫一次码。其余全自动连好！
- **Agent 自动执行**：SSH 部署常驻服务与 `linger` → 在已登录浏览器自动打开 OpenAI Platform Tunnels 复用或新建关联当前 ChatGPT 工作区的 Tunnel、在 API Keys 新建 `Restricted`（仅 `Tunnels: Read + Use`）运行密钥并直接填入 `127.0.0.1` 连接页 DOM（**严禁将密钥读入聊天上下文、日志或文件**）→ 点击开始连接供用户手机扫码 → 交接后自动在浏览器打开 `https://chatgpt.com/plugins` 添加 `dot-im-gateway`（`Connection: Tunnel` 匹配 `tunnel_hint` 前缀，`Authentication: None`，勿选 OAuth；风险确认框若需人工点击则停在该按钮请用户点一下，或获全授权后完成创建）→ 自动切回原 dot 对话关闭旧同名测试插件、开启 `dot-im-gateway` 并发送订阅指令 → 终端轮询 `server-status.sh` 核验 `"ok": true`、`mcp_requests >= 1` 且 `queue.subscriptions >= 1`（连接页两项同步变绿）→ 请用户手机发一句「你好」验收！

### Plan B（半自动领航模式 — Agent 具备「终端/SSH + 打开本机浏览器/写剪贴板」，无网页内代点权限）
- **小白只需做「点确定、复制、粘贴、扫码」**：不用找入口、不用敲命令、不用打字。
- **Agent 自动执行**：部署服务端并自动在浏览器弹出 `127.0.0.1` 连接页 → 按步骤依次用默认浏览器帮用户弹出 Tunnels 页与 API Keys 页 → 扫码交接后自动弹出 `https://chatgpt.com/plugins` 并先把 `dot-im-gateway` 写入系统剪贴板（用户粘贴名称、选页面显示的 `tunnel_xxxxxx...`、选 `None`、点确定）→ 后台轮询 `server-status.sh` 检测到 `mcp_requests >= 1` 后，自动将订阅指令写入剪贴板提醒用户去原 dot 按 `Ctrl+V` 发送 → 检测到 `queue.subscriptions >= 1` 即通知就绪！

### Plan C（服务端代配 + 分步向导模式 — Agent 仅能访问服务器或受限终端，无法打开用户本机浏览器）
- **Agent 全自动配好服务器常驻与监控，每次只给一步极简指引**：配好服务端后给出一条本地转发命令 → 用户扫码后，Agent 根据 `server-status.sh` 的 `tunnel_hint`、`mcp_requests`、`queue.subscriptions` 实时盯盘，一步一句引导用户完成插件添加（强调 `Authentication: None`）与订阅验收。

---

## 规则

- **一次确认**：开始动手前，把要做的事列成一段话，让用户回复「同意」一次。之后同一范围内的步骤直接执行，不再逐个询问；超出范围（换服务器、安装系统软件包、换绑另一个账号、卸载）才再问。
- **秘密不进聊天**：运行密钥、AppSecret、二维码、手机验证码、连接页链接（`#` 后面是一次性令牌）都不复述、不截图、不写入文件。需要打开连接页时，直接调用本机浏览器打开，不把链接贴出来。
- **只连本人**：只处理用户本人与自己机器人之间的私聊；不绑定第一个发消息的人、昵称或群聊。Windows 一次性模式只收发文字；服务器常驻模式 QQ 仅文字，微信另支持图片/PDF（单个不超过 4 MiB，保存 7 天），确认时要如实说明。
- **出错先自救**：看输出里的错误码，对照 [服务器部署 Skill 的故障恢复表](../deploy-dot-im-gateway/SKILL.md#故障恢复) 自动处理，同一错误最多自动重试一次；仍失败时告诉用户错误码、原因和下一步，一两句话即可。
- **证据才算完成**：没有看到手机实际收到回复之前，不说「已完成」。

## 第 1 步：选路线（最多问一个问题）

先检查本机有没有可用的 SSH 配置（如 `~/.ssh/config` 中的主机）。然后问用户：

> 你有一台能用 SSH 登录的 Linux 服务器吗？有的话可以 7×24 小时在线、来消息自动叫醒 dot；没有的话就用这台 Windows 电脑临时连接，电脑关机、睡眠或关掉窗口就会断开。

- **有服务器** → 读取并完整执行 [服务器部署 Skill](../deploy-dot-im-gateway/SKILL.md)。推荐路线。
- **没有服务器，用 Windows x64** → 继续下面的「Windows 一次性连接」。
- 其他系统（macOS、ARM）→ 说明暂不支持本机连接，建议使用服务器路线。

## Windows 一次性连接

特点：不安装任何东西、不保存凭据、不开机自启、**不会自动唤醒 dot**（来消息后要用户主动让 dot 去看）。连接期间窗口要一直开着。

### 一次确认模板

> 我将在这台电脑上：下载并校验 dot-im-connect 单文件程序 → 打开本机连接页 → 你在页面里填 Tunnel 两项（通道编号与受限密钥）、用手机扫码 → 连接你本人的 QQ/微信私聊文字到原 dot。密钥只留在程序内存，关闭窗口即断开并清理临时数据。回复「同意」开始。

### 步骤

1. **下载并校验**（PowerShell）：

   ```powershell
   $d="$env:LOCALAPPDATA\dot-im-connect"; New-Item -ItemType Directory -Force $d | Out-Null
   $r=Invoke-RestMethod https://api.github.com/repos/Flysky701/dot-im-gateway/releases/latest
   foreach($n in 'dot-im-connect-win32-x64.exe','dot-im-connect-win32-x64.exe.sha256'){ $a=$r.assets|?{$_.name -eq $n}; Invoke-WebRequest $a.browser_download_url -OutFile "$d\$n" }
   $want=(Get-Content "$d\dot-im-connect-win32-x64.exe.sha256").Split(' ')[0]
   if((Get-FileHash "$d\dot-im-connect-win32-x64.exe" -Algorithm SHA256).Hash -ne $want.ToUpper()){ throw 'checksum_mismatch' }
   & "$d\dot-im-connect-win32-x64.exe" --self-test
   ```

   记录 Release 版本号和 SHA256。没有已发布的 Release 时，告诉用户「维护者还没发布 Windows 版本」，建议改走服务器路线；只有用户同意安装 Node 24.21.0 和 Python 3 时，才按 [维护者构建](../../docs/PORTABLE.md) 在本机构建。Windows 可能提示「未知发布者」，让用户自己决定是否继续，不要替用户绕过。

2. **启动**：在一个保持打开的终端窗口运行 `& "$d\dot-im-connect-win32-x64.exe"`。程序会自动打开本机浏览器连接页。端口被占用时加 `--port 8799`。
3. **准备 OpenAI 两项**（首次）：按 [服务器 Skill 的「准备 Tunnel」](../deploy-dot-im-gateway/SKILL.md#第-4-步准备-tunnel首次两步搞定) 指导用户：① `Tunnel ID` + ② `受限运行密钥（Tunnels: Read + Use）`；直接填进连接页，无需组织 ID。
4. **用户在页面操作**：选 QQ（推荐扫码）或微信 → 填两项 → 勾选同意 → 开始连接 → 用手机扫码确认。QQ 扫码后在页面核对机器人 AppID；没有官方身份返回时，页面会给出一串验证文字，让用户用本人 QQ 发给机器人，再在页面确认。
5. **在 ChatGPT 添加插件**（首次）：同 [服务器 Skill 第 6 步](../deploy-dot-im-gateway/SKILL.md#第-6-步在-chatgpt-添加插件并订阅首次)，Connection 选 Tunnel，Authentication 选 None，**不需要订阅**：一次性模式没有事件推送。
6. **验收**：用户用手机给机器人发「你好」→ 让用户对原 dot 说「用 dot-im-gateway 读取我刚发的消息，先 ack 再 final 回复」→ 用户确认手机收到两条回复。
7. 告诉用户：可以关掉网页，但**终端窗口要一直开着**；断开后重新运行同一个程序即可；需要 7×24 在线和自动唤醒时改走服务器路线。微信侧的绑定要在手机上自行解除。

## 汇报格式

完成或停止时，用 3～6 行告诉用户：路线（服务器/Windows）、平台、程序版本与 SHA256（或提交号）、手机实收结果、断开后怎么恢复。被卡住时只说卡在哪一步、错误码、下一步要用户做什么。

## 第三方组件

QQ 扫码使用打包进程序的腾讯官方 `@tencent-connect/qqbot-connector` 1.2.0（通过其公开回调 API，页面显示通用「第三方机器人」）。该 SDK 标注为 UNLICENSED，不属于本项目 MIT 许可范围，详见 [第三方声明](../../THIRD_PARTY_NOTICES.md)。不要复制其私有接口或修改品牌信息。
