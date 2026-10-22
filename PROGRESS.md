# 阶段记录

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
