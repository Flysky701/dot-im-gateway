# 验证记录

本地环境：Windows PowerShell、Node.js 24.21.0、SQLite 3.53.4、Python 3.13.15。全新独立目录，未修改其他仓库。没有运行第三方安装脚本或创建真实账号授权。

2026-10-22 最终离线验证命令：

```sh
npm run check
npm test
python -m unittest discover -s test -p '*_test.py' -v
```

Node test runner 共 42 项（41 个显式测试，另含一个 helper 文件发现项）。覆盖 QQ/微信 owner/bot 绑定、QQ 附件拒绝、微信 PNG/PDF 加解密和 upload/send 字段、uint64、持久去重、事务 cursor、ack/final 顺序幂等、uncertain 重启恢复、签名挑战/轮换/撤销/过期、SSRF 地址校验与 DNS pin/超时、私有媒体限制、备份恢复隔离、独立服务启动关闭、真实 loopback HTTP MCP 调用与编码请求头。

Python 部署测试共 4 项：Windows 执行 3 项，通过后跳过 Linux 专属生命周期；Linux 全部执行。Linux 测试在临时隔离目录使用 `--no-systemd`，覆盖安装及重复安装、升级及重复升级、回滚、卸载保留数据。没有把隔离文件部署测试称为真实 systemd 验收。

首个完整实现提交 `7f8ff4a63c7bfccb5288ff8f993919e470b6d48a` 的 [Linux / Windows CI](https://github.com/Flysky701/dot-im-gateway/actions/runs/39726056415) 均已成功。该提交为 40 个 Node runner 项；随后增加编码请求头及 DNS 超时测试。最终交付以 [main 的 Actions 记录](https://github.com/Flysky701/dot-im-gateway/actions) 和交付说明中的精确 SHA 为准。

初始沙箱禁止回环 TCP 导致 EACCES，经自动批准后仅扩大本项目离线/回环测试进程的执行边界。没有修改防火墙或网络安全设置。测试没有真实 QQ/微信、Tunnel 或原 dot 的参与。

Skill 自带 `quick_validate.py` 因当前 Python 缺 PyYAML 未能运行。项目无第三方依赖的 frontmatter/链接检查、语法检查和部署脚本测试作为补充；不宣称原验证器通过。

待真人验收：详见 [ACCEPTANCE.md](ACCEPTANCE.md)。官方凭据开通、稳定身份绑定、Tunnel 鉴权转发、原 dot 订阅与执行、本人实际收到 ack/final、微信图片/PDF 收发、真实断网恢复、平台回复窗口及 systemd 常驻均需用户环境证据。
