# 单文件连接程序

`dot-im-connect` 是一次性连接入口，不是管理后台。选 QQ 或微信，输入已有私人 Tunnel 的信息和本次凭据，完成本人确认，连接完成后关闭配置页面。桥接进程及官方 tunnel-client 继续传消息；关闭终端或按 Ctrl+C 会断开。断了重新运行，不自动认领账号或修复环境。

## 一个文件包含什么

- Windows x64：`dot-im-connect-win32-x64.exe`。在自己的终端运行，会打开本机浏览器。
- Linux x64：`dot-im-connect-linux-x64`。由 Agent 通过用户已有 SSH 身份复制到指定独立目录，核对 SHA256 后赋予执行权限并运行。
- 内置 Node 24.21.0、内建 SQLite、现有桥接模块、原生网页、二维码生成器和官方 tunnel-client 0.0.17。用户不需要另装 Node、Python、npm 或 pip，也不在运行时下载依赖。
- 官方客户端仍是独立子进程：内置压缩资源经 SHA256 校验后解包到私有临时目录，正常退出后删除。
- 依赖操作系统、系统 TLS/网络能力及浏览器；Linux 需满足 Node 24 的 glibc 等平台条件。SSH 是远程部署/转发工具的前提，不能把这些称为不存在。
- Node 运行时占主要体积，Windows 原型约 98 MiB；单文件不等于只有几 MB。没有 Electron、Python 运行时或前端框架。Windows 文件未做 Authenticode 签名；不自动绕过系统安全提示。

## 连接步骤

1. 从私有仓库成功 CI 的 `dot-im-connect-Windows-x64` / `dot-im-connect-Linux-x64` artifact 获取可执行文件、SHA256 和构建信息。只在私有仓库中交付，不公开发布。
2. 先运行 `dot-im-connect --self-test`。仅验证内置运行时、SQLite、官方客户端能启动及临时目录清理，不连接账号。
3. 在本人终端运行程序。Windows 默认打开页面；Linux 可用 `./dot-im-connect-linux-x64 --port 8789 --no-browser`。笔记本使用既有受信 SSH 配置建立 `ssh -N -L 127.0.0.1:8789:127.0.0.1:8789 <已核实的服务器别名>`。页面能力链接只由本人从终端打开，不贴聊天、不截图给 Agent。端口已占用时选择另一个端口，两端保持一致。
4. 选择渠道，输入已有 Tunnel ID、组织 ID、仅 Read+Use 的运行密钥。QQ 另需自己的官方机器人 AppID/AppSecret；用本人 QQ 发随机验证文字，再在独立本机页面确认对应稳定 ID。微信用本人手机扫码，身份来自官方确认返回；验证码只在本机页面输入。
5. 原 dot 通过同一私人插件发现 `gateway_status`、`list_pending`、`read_message`、`reply`。发送本人文字，让原 dot 读取、ack、final，并在手机确认收到。新包装入口的本地/CI 自检不能代替这次验收。
6. 点击“完成并关闭连接页面”，临时 HTTP 配置入口停止监听，传输进程继续运行。按 Ctrl+C 停止并看到清理结果。没有脱离终端、安装自启或系统服务；SSH 断开也可能结束服务器上的前台程序。

## 当前边界

一次运行连接一个渠道，同一用户同时只允许一个便携实例，避免争用同一 Tunnel。旧模块化服务仍支持独立 QQ/微信适配器；便携入口没有多渠道管理后台。

便携入口只接收本人文字并原会话回复，附件、Events 自动唤醒和主动发送均不开放。不创建 Agent、不调用模型 API、不接受任意服务器路径或命令。页面输入、QR、验证码、凭据只留进程内存；临时 SQLite 保存本次来信/回复，正常退出删除。微信侧绑定需用户在手机上自行断开。

官方客户端 `/readyz` 成功只代表客户端就绪，不能证明原 dot 已读取或手机已收到。连接后仍需原 dot 工具调用和手机实收验收。凭据失效或平台拒绝时结束本次连接，显示短错误，由本人重新运行处理。

全部进程退出后没有消息转发。突然断电、SIGKILL 或强制结束无法保证临时数据清理，应核实无所属进程后清理本程序的临时目录，不读取或上传消息正文。

## 维护者构建（用户不需要）

在目标平台 x64、Node **24.21.0**、Python 3 环境运行：

```sh
npm ci --prefix packaging --ignore-scripts --no-audit --no-fund
python packaging/fetch.py
node packaging/build.js
```

`packaging/package-lock.json` 固定构建工具和 QR 包完整性；`packaging/fetch.py` 固定官方客户端发布包 SHA256。构建时下载固定资源，运行时不下载。`--licenses` 提供内置 Node、客户端许可证、NOTICE、上游依赖报告及 QR 许可。没有声称跨机器构建产物逐字节完全相同。

参考：[Node 24 SEA](https://nodejs.org/download/release/v24.21.0/docs/api/single-executable-applications.html)、[官方 tunnel-client](https://github.com/openai/tunnel-client/tree/v0.0.17)。
