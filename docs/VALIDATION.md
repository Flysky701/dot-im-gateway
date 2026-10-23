# 验证记录

本地环境：Windows PowerShell、Node.js 24.21.0、SQLite 3.53.4、Python 3.13.15。全新独立目录，未修改其他仓库。没有运行第三方安装脚本或创建真实账号授权。

2026-10-22 最终离线验证命令：

```sh
npm run check
npm test
python -m unittest discover -s test -p '*_test.py' -v
```

Node test runner 共 46 项（45 个显式测试，另含一个 helper 文件发现项）。覆盖 QQ/微信 owner/bot 绑定、QQ 附件拒绝、微信 PNG/PDF 加解密和 upload/send 字段、uint64、持久去重、事务 cursor、ack/final 顺序幂等、uncertain 重启恢复、签名挑战/轮换/撤销/过期、SSRF 地址校验与 DNS pin/超时、私有媒体限制、备份恢复隔离、独立服务启动关闭、真实 loopback HTTP MCP 调用与编码请求头。

Python 部署测试共 5 项：Windows 执行 4 项，通过后跳过 Linux 专属生命周期；Linux 全部执行。Linux 测试在临时隔离目录使用 `--no-systemd`，覆盖安装及重复安装、升级及重复升级、回滚、卸载保留数据。新增两个 prefix 的归属负向测试：安装、升级、回滚、卸载均必须在调用任何 systemctl 或更改目标目录前拒绝无关 unit。没有把隔离文件部署测试称为真实 systemd 验收。

独立审查回归：先在旧实现复现超过 10 条受阻 final 导致新回复饥饿，以及第二附件 503 导致首附件重复占满配额；修复后覆盖 36 条 rejected/cancelled/uncertain ack 的 final、人工核实后继续、过期不重发、停用平台和瞬时失败入站公平性、持久退避、超过 50 条过期及有效消息的分页、重复媒体下载及永久失败清理。

首个完整实现提交 `7f8ff4a63c7bfccb5288ff8f993919e470b6d48a` 的 [Linux / Windows CI](https://github.com/Flysky701/dot-im-gateway/actions/runs/39726056415) 均已成功。该提交为 40 个 Node runner 项；随后增加编码请求头及 DNS 超时测试。最终交付以 [main 的 Actions 记录](https://github.com/Flysky701/dot-im-gateway/actions) 和交付说明中的精确 SHA 为准。

初始沙箱禁止回环 TCP 导致 EACCES，经自动批准后仅扩大本项目离线/回环测试进程的执行边界。没有修改防火墙或网络安全设置。测试没有真实 QQ/微信、Tunnel 或原 dot 的参与。

通用 Skill 验证已补齐：现有解释器未含 PyYAML，按授权在被 Git 忽略的 `runtime/skill-validator-venv` 中，使用 pip 的官方 `https://pypi.org/simple` 索引和 `--only-binary=:all: --no-deps` 安装 PyYAML 6.0.3；未修改系统 Python。使用该解释器以 `-X utf8` 运行已有 `skill-creator/scripts/quick_validate.py skills/deploy-dot-im-gateway`，退出码 0，输出 `Skill is valid!`。部署 Skill 无需修改。此依赖仅用于本次开发验证，不进入服务依赖或交付包。

2026-10-23 自动化改造（v0.1.1）离线验证：`npm test` 85 项全部通过（新增 handoff 计划/文件权限/恢复/拒绝外部 unit、回调后缀匹配、按平台绑定与旧记录迁移、连接器移交与失败恢复、会话 onBound）；`npm run check` 通过；Python 14 项通过（新增卸载只移除带标记的 tunnel unit）。用官方 Node 24.21.0 实际构建 Linux 单文件，构建内自检通过；在临时 HOME 中用 `deploy.py install` 模拟安装后运行 `--handoff`，页面状态为 `mode=handoff`，未安装时报 `service_not_installed`，非法路径报 `unsafe_prefix`，Ctrl+C 清理完成。真实 systemd、真实 Tunnel、扫码和原 dot 订阅未在此环境运行。

交叉评审修复后离线验证：`npm test` 93 项全部通过，新增覆盖：微信官方身份格式（接受 `@im.wechat`/`@im.bot`，拒绝空白/控制字符/超长）；已绑定且运行中的安装交接失败后，二进制、两个 env、config、unit 逐字节和权限一致，原已启用的 unit 不被禁用，`restore()` 重新启动原来运行的两个服务；首次交接失败时新文件全部删除、仅新 Tunnel unit 被禁用且在删除 unit 文件前执行；等待健康时取消立即回滚，已取消的信号不产生任何写入或 systemctl 调用；外部或符号链接 Tunnel unit 在 summary/prepare/commit 均被拒绝且零次 `stop`；连接器在 handing_off 或提交中被停止时不保存并报告 stopped；连接器与真实 handoff 端到端写入官方格式微信身份并报告 handed_off。用变异法逐一去掉文件恢复、启用状态判断、取消检查、新 ID 校验、提前所有权检查、停止优先和提交信号，对应测试均失败。`npm run check`、Python 14 项、`bash -n`、release.yml YAML 解析通过。

待真人验收：详见 [ACCEPTANCE.md](ACCEPTANCE.md)。官方凭据开通、稳定身份绑定、Tunnel 鉴权转发、原 dot 订阅与执行、本人实际收到 ack/final、微信图片/PDF 收发、真实断网恢复、平台回复窗口及 systemd 常驻均需用户环境证据。
