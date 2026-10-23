# 单文件连接程序

`dot-im-connect` 是**一次性入口**，不是管理后台：选 QQ 或微信，填已有私人 Tunnel 的信息，扫码确认本人。它有两种用法：

| | 一次性连接（默认） | 移交常驻服务（`--handoff`，Linux） |
|---|---|---|
| 运行位置 | Windows 本机，或 Linux 前台 | 已用 `scripts/server-bootstrap.sh` 安装常驻服务的 Linux 服务器 |
| 绑定后 | 程序自己桥接消息，窗口关闭即断开 | 把绑定结果写入常驻服务后自动退出，由 systemd 长期运行 |
| 凭据 | 只在内存 | 常驻服务的 `runtime.env` / `tunnel-runtime.env`（0600） |
| Events 自动唤醒 | 不开放 | 开启（回调只允许 chatgpt.com / openai.com 及其子域名） |
| 断线 | 结束，重新运行 | 服务自动重连；凭据失效时重新运行 handoff |

## 一个文件包含什么

- Windows x64：`dot-im-connect-win32-x64.exe`；Linux x64：`dot-im-connect-linux-x64`。
- 内置 Node 24.21.0、内建 SQLite、桥接模块、原生网页、二维码生成器、官方 tunnel-client 0.0.17 和腾讯官方 QQ 扫码 SDK。用户不需要另装 Node、Python、npm 或 pip，运行时不下载依赖。
- 官方客户端是独立子进程：内置压缩资源经 SHA256 校验后解包使用。
- 依赖操作系统、TLS/网络能力及浏览器；Linux 需满足 Node 24 的 glibc 等条件。Node 运行时占主要体积（约 100 MiB）。Windows 文件未做 Authenticode 签名，不自动绕过系统安全提示。

## 获取

从 GitHub Release 下载对应文件及同名 `.sha256`，核对后再运行。Release 由 [release 工作流](../.github/workflows/release.yml) 在推送 `v*` 标签时自动测试、构建、自检并生成草稿，维护者审核后发布。服务器上的 `scripts/server-bootstrap.sh` 会自动下载并校验与源码版本一致的 Release；没有已发布的 Release 时在服务器上按固定依赖构建。

运行 `dot-im-connect --self-test` 只验证内置运行时、SQLite、官方客户端能启动及临时目录清理，不连接账号。

## 一次性连接

1. 在本人终端运行。Windows 默认打开本机页面；Linux 用 `./dot-im-connect-linux-x64 --port 8789 --no-browser`，并在自己电脑上建立 `ssh -N -L 127.0.0.1:8789:127.0.0.1:8789 <服务器>`。页面链接含一次性令牌，只在本机浏览器打开，不贴聊天、不截图。端口占用时两端换成同一个其他端口。
2. 选择渠道，填 Tunnel ID、组织 ID 和只带 Tunnels Read+Use 的运行密钥（页面有官方直达链接）。QQ 默认使用腾讯官方 SDK 扫码，可填已有 AppID 防止选错，在页面核对 AppID；SDK 返回有效 `userOpenid` 时绑定该官方身份，没有返回时用本人 QQ 发随机验证文字并在页面确认。手填 AppID/AppSecret 是备用。微信用本人手机扫描官方二维码，验证码只在本机页面输入。
3. 原 dot 通过私人插件发现 `gateway_status`、`list_pending`、`read_message`、`reply`。发送本人文字，让原 dot 读取、ack、final，并在手机确认收到。
4. 点击「完成并关闭连接页面」后传输进程继续运行；按 Ctrl+C 停止并看到清理结果。没有自启或系统服务。

## 移交常驻服务（--handoff）

前提：服务器已运行过 `bash scripts/server-bootstrap.sh`（它会用 `scripts/deploy.py` 安装服务，并在最后输出要运行的命令）。

```sh
# 在自己电脑上执行；<BIN> 和 <PREFIX> 来自 bootstrap 输出
ssh -L 127.0.0.1:8789:127.0.0.1:8789 <服务器> '<BIN> --handoff <PREFIX> --port 8789 --no-browser'
```

1. 程序先暂停正在运行的常驻服务（同一机器人和 Tunnel 同时只能有一个使用者），打开连接页。
2. 首次需要填 Tunnel 三项；常驻服务已保存时三项留空即沿用，要更换时三项都填。
3. 扫码并确认本人。绑定和凭据验证成功后，程序**不再**启动临时 Tunnel，而是：
   - 写入 `PREFIX/runtime.env`（网关令牌、平台凭据）和 `PREFIX/tunnel-runtime.env`（Tunnel 设置），权限 0600，原子替换；
   - 更新 `PREFIX/config.json`：`mode=live`、启用该平台、`allowSubscriptions=true`，合并默认回调白名单 `chatgpt.com`、`.chatgpt.com`、`openai.com`、`.openai.com`（以 `.` 开头的条目只匹配子域名）；
   - 安装 `PREFIX/bin/tunnel-client` 和带归属标记的 `~/.config/systemd/user/dot-im-tunnel.service`（`Restart=always`，健康检查 `127.0.0.1:8790`）；
   - `daemon-reload`、enable 并重启两个服务，等待网关 `/healthz` 为 live、tunnel-client `/readyz` 就绪。
4. 页面显示「常驻服务已接管」、linger 提示和给原 dot 的订阅提示词（可一键复制）。终端输出 `{"stage":"handed_off","service":"running","events":"enabled","autostart":"enabled","linger":...}`，约 20 秒后程序自动退出。
5. 绑定完成前失败、取消或 SSH 断开时，不写入任何文件，并恢复原来在运行的服务；重新运行即可。文件写入后服务未就绪会报 `gateway_not_healthy` 或 `tunnel_not_ready`，查看 `journalctl --user -u dot-im-gateway -u dot-im-tunnel` 修正后重新运行。

规则：同一安装可以先绑 QQ 再加微信（或反过来），已有数据保留；**已绑定平台不能换成另一个人或机器人**（`different_owner_requires_new_data_directory`），需卸载后用新目录重装。已存在但不属于本安装的 `dot-im-tunnel.service` 不会被覆盖（`unrelated_tunnel_unit_exists`）。

## 当前边界

QQ 扫码通过固定的[官方 connector 1.2.0](https://www.npmjs.com/package/@tencent-connect/qqbot-connector) 公开回调 API 实现；手机页面显示通用「第三方机器人」。二维码只在本机页面展示；取消、过期或两分钟未完成会终止独立 SDK 执行单元，丢弃迟到凭据。程序不创建或替换机器人。

该 SDK 元数据为 UNLICENSED，不属于本项目 MIT 许可范围；保留原来源和声明，不将它重新许可为 MIT。**公开发布包含该 SDK 的二进制前，维护者需自行确认再分发许可**，详见[第三方声明](../THIRD_PARTY_NOTICES.md)。

一次运行连接一个渠道；同一用户同时只允许一个连接程序实例。一次性模式只接收本人文字并原会话回复，附件、Events 和主动发送均不开放；常驻服务的完整能力见 [README](../README.md)。官方客户端 `/readyz` 成功只代表客户端就绪，不能证明原 dot 已读取或手机已收到。突然断电或 SIGKILL 无法保证一次性模式的临时数据清理。

新的扫码包装和 handoff 移交已通过离线/合成测试，尚待真人验收。

## 维护者构建（用户不需要）

在目标平台 x64、Node **24.21.0**、Python 3 环境运行：

```sh
npm ci --prefix packaging --ignore-scripts --no-audit --no-fund
python packaging/fetch.py
node packaging/build.js
```

`packaging/package-lock.json` 固定构建工具和 QR 包完整性；`packaging/fetch.py` 固定官方客户端发布包 SHA256。构建时下载固定资源，运行时不下载。`--licenses` 提供内置 Node、客户端许可证、NOTICE、上游依赖报告及 QR 许可。没有声称跨机器构建产物逐字节完全相同。

参考：[Node 24 SEA](https://nodejs.org/download/release/v24.21.0/docs/api/single-executable-applications.html)、[官方 tunnel-client](https://github.com/openai/tunnel-client/tree/v0.0.17)。
