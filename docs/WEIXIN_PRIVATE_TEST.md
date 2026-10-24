# 微信本人文字限时连接

独立 Linux 交互入口，Node 24.21+、Python 3.10+，不安装 OpenClaw。协议参考 Tencent/openclaw-weixin 固定提交 874637a0dbc24050f72d1385add4fc6170a2d726 的 login-qr.ts/protocol.md；客户端协议参考不保证所有账号/地区准入。

用户先批准目标目录、官方扫码绑定、本人消息经私人服务器/OpenAI读取和回复、临时凭据与清理范围。先正常退出使用同一 Tunnel 的其他测试；脚本检测到同路径官方客户端仍在运行会拒绝启动，不自动停止其他服务。

```sh
python3 scripts/weixin_private_test.py \
  --parent /ABS/PRIVATE/TEST_PARENT \
  --node /ABS/OFFICIAL/NODE24/bin/node \
  --tunnel-client /ABS/OFFICIAL/tunnel-client \
  --tunnel-id EXISTING_PRIVATE_TUNNEL_ID \
  --organization-id VERIFIED_ORGANIZATION_ID \
  --maximum-seconds 1800
```

父目录须本人所有、0700。用户在真实终端隐藏输入已有 Read+Use runtime key，终端绘制官方 QR 内容（不保存图片或传给第三方图片服务），用本人手机扫码确认；若手机显示数字，在终端隐藏输入。没有微信 AppID/AppSecret，没有首条消息认主；owner/bot ID 只取官方 confirmed 返回。信任官方 TLS、公网 DNS 固定及受信终端；不能抵御同 UID/root 主机被攻陷或二维码转给别人。

二维码最多等待 5 分钟，验证码最多 3 次，过期/被阻断/已绑定但无本地 token 则明确停止。重定向/base URL 限定 HTTPS、weixin.qq.com 下主机、默认端口、无用户名密码/路径/query/fragment，并执行公网 DNS 固定。不会执行响应内容或任意 URL。

绑定后创建私有 SQLite，只接收本人纯文字；拒绝其他身份、群聊和附件。仅开放 gateway_status/list_pending/read_message/reply，回复固定来信会话和 context_token。原 dot 手动读信，先 ack 再 final，用户确认手机实收。gateway_ready 只是本地入口及客户端启动，不能替代 Tunnel 或真人验收。

最长 30 分钟包含扫码。STOP/Ctrl+C/EOF/SIGTERM/SIGHUP/到期停止自己创建的进程并删除新建会话目录；回执 data_removed=true / processes_remaining=false 才算清理完成。SIGKILL/断电无法保证 finally；需按残留核验，不盲删。平台绑定不会随退出撤销，用户可在手机 ClawBot 管理中断开。无媒体、Events、自启、长期凭据文件或自动续期。

二维码库为 [vendor 的未修改 qrcode 8.2 wheel](../vendor/README.md)，校验 SHA256 后只加载终端渲染，无安装脚本、Pillow 或系统 Python 修改。
