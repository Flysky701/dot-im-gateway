# 验证记录

开发环境：Windows PowerShell，Node.js 24.21.0，SQLite 3.53.4，Python 3.13.15。全新独立目录，不修改其他仓库。没有运行第三方安装脚本或创建真实账号授权。

2026-10-22 第一轮：37 个 Node test runner 项（其中一个是 helper 文件加载项）通过。覆盖 QQ/微信 owner/bot 绑定、QQ 附件拒绝、微信 PNG/PDF 加解密和 upload/send 字段、uint64、持久去重、事务 cursor、ack/final 顺序幂等、uncertain 保守恢复、签名挑战/轮换/续期/撤销、SSRF 地址校验和 DNS pin、私有媒体清理、备份恢复隔离、真实 loopback HTTP MCP 调用。

初始沙箱禁止回环 TCP，两个测试报 EACCES；经自动批准审查允许仅运行本项目回环测试后通过。未修改防火墙、网络或安全设置。测试过程没有真实 QQ/微信、Tunnel、原 dot 或真人消息。

Skill 自带 quick_validate.py 在当前 Python 缺 PyYAML，未能运行。项目提供无第三方依赖的 skill/frontmatter/link 检查与部署脚本测试作为补充；不能把它称为原验证器通过。

CI 在 GitHub Actions 的 Linux/Windows 上运行 Node 测试与语法检查，Linux 额外运行部署生命周期测试；最终 CI 状态和提交号以交付报告的远端记录为准。本文件不伪造尚未发生的 CI/真人验收结果。
