# 阶段记录

- 2026-10-23 第二轮评审修复：交接失败/取消时，按平台精确撤销网关为新加平台写入数据库的绑定和同步进度（`binding.*`、`weixin.cursor` 或 `qq.session/qq.seq`），已收到的消息与其他平台不动，失败后可换账号重绑；停止服务前用 `systemctl --user show` 核对实际加载的 unit 文件，`/etc/systemd/user` 或临时同名 unit 一律不碰；构建记录对有未提交修改的源码标 `<commit>-dirty`，bootstrap 不会把它当干净版本复用。Node 97 项通过。
- 2026-10-23 交叉评审修复（v0.1.1）：handoff 接受微信官方 `…@im.wechat` / `…@im.bot` 身份（仍拒空白和控制字符，QQ 保持严格）；提交改为全有或全无——失败或取消时停止本次启动的服务、只禁用本次新启用的 unit、逐字节恢复二进制/env/config/unit（含权限）后再恢复原运行状态；Ctrl+C/停止在交接中途优先，不再写入；外部 Tunnel unit 在暂停任何服务前就被拒绝；页面与 Skill 写明 QQ 仅文字、微信文字和图片/PDF；Release 已发布则拒绝重跑覆盖；bootstrap 只使用 `sourceCommit` 与当前检出一致的 Release 二进制，否则本机构建，Skill 默认检出最新版本标签。Node 93 项、Python 14 项通过。
- 2026-10-23 自动化改造（v0.1.1）：明确「单文件=一次性入口，服务器=常驻连接」。新增 `--handoff PREFIX`：单文件绑定成功后不启动临时 Tunnel，而是把凭据写入常驻服务（0600）、切 live、开启订阅、安装带标记的 `dot-im-tunnel.service`，重启并等待健康；失败恢复原服务。身份绑定改为按平台记录，可在同一安装上追加平台，自动迁移旧记录。回调白名单支持 `.域名` 仅匹配子域名，handoff 默认允许 chatgpt.com / openai.com。新增 `scripts/server-bootstrap.sh`（固定 Node、安装/升级、取 Release 或构建）、`scripts/server-status.sh`、release 工作流（草稿 Release + SHA256）。两个 Skill 重写为新手全自动流程。离线测试 Node 85+、Python 14 通过；handoff 尚未在真实服务器验收。
- 2026-10-22 后续按用户收缩为一次性连接程序，已撤销未提交的管理后台草稿。新增 Node SEA 单文件入口，Windows 包约 98 MiB，内置 Node/SQLite/QR/官方客户端；本机无网络自检通过。一次运行一个渠道，页面完成后关闭，传输进程留在原终端；不保存凭据、不设自启、不开 Events。新增入口需独立真人验收，不继承此前测试程序的真人通过结论。

- 2026-10-22：独立空目录开始；检查进程与任务，不修改其他项目。
- 已核实 GitHub 身份 Flysky701，同名仓库不存在；通过已登录官方网页创建私有仓库，连接器复核 visibility=private。
- 阅读 OpenAI MCP Events / Secure MCP Tunnel 最新文档。协议采用 2026-07-28。
- 五个参考项目固定 commit；核实 QQ 扫码依赖 UNLICENSED 边界，不包含或安装该包。
- 实现阶段：Node.js 24 内置模块、SQLite 队列、独立 QQ/微信适配器；所有真实接入默认关闭。
- 本阶段不扫码、不获取账号凭据、不创建 Tunnel、不创建真实订阅、不改变服务器设置。
- 已写入可运行模块：src/{config,util,network,store,media,events,core,server,runtime,operations}.js，adapters/{qq,qq-gateway,weixin}.js，bin/gateway.js。
- 已写入 scripts/deploy.py、部署 Skill、中文 README/架构/安全/运维/参考审查/真人验收文档、CI workflow。
- 第一轮 Node tests：37/37 通过，包括真实 loopback HTTP。初始沙箱 EACCES 经仅限本项目回环测试的自动审查批准后解决，没有修改网络设置。
- 追加 standalone service lifecycle 与订阅撤销竞争测试；部署 dry-run 临时路径问题修复中；Linux apply 生命周期留给 Linux CI 验证。
- 远端私有仓库已初始化，commit 2941f7c4031da68b0c16fd430f22ce01899b28ee；完整切片待上传，不是空设计任务。
- 原 Skill validator 缺 PyYAML，替代的无依赖 frontmatter/引用路径检查通过；未声称原 validator 通过。
- 05:06 UTC：完整实现已提交 `7f8ff4a63c7bfccb5288ff8f993919e470b6d48a`，私有仓库 https://github.com/Flysky701/dot-im-gateway 。CI https://github.com/Flysky701/dot-im-gateway/actions/runs/39726056415 的 Linux / Windows 均成功；Linux 隔离安装、重复安装、升级、回滚、卸载保留数据测试通过。
- 收尾：补齐 MCP 编码名称请求头、缺失请求头与版本错误测试，以及 DNS 解析超时；更新验证文档后提交并核验最终 SHA 的 CI。部署 dry-run 临时路径问题已修复，没有挂起的安装或真实平台动作。
- 当前边界：本机和 CI 均为离线/模拟/本地回环验证；真实原 dot、官方 Tunnel、订阅与真人 QQ/微信收发等待用户环境。没有获取长期账号凭据。
- 独立审查修复：复现并修正 outbox 的阻塞 final 饥饿、inbox 停用/重试饥饿、待办前 50 条永久占位、多附件重试容量泄漏，以及 systemd 归属校验晚于 stop。新增回归后本地 Node 46/46，Python 4 通过、1 Linux 专属跳过。收尾提交将再次核验双平台 CI。
- 通用 Skill 验证补齐：项目忽略目录中的隔离虚拟环境，通过官方 PyPI wheel 安装仅 PyYAML 6.0.3；原 quick_validate.py 输出 `Skill is valid!`，退出码 0。系统 Python 未修改，未新增运行依赖。
- 2026-10-22 后续：完成独立 QQ/微信限时入口、隐藏输入、身份绑定、四工具白名单及退出清理。原 dot 真实完成两平台本人文字 ack/final，QQ 16:15:58、微信 16:21:40 UTC 用户确认实收；两会话正常退出并核验清理。仅手动文字验收，Events/媒体真人收发/常驻仍待验收。详见 docs/TEXT_ACCEPTANCE_2026-10-22.md。
