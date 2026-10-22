# QQ 本人文字限时测试

这是独立于正式服务的 Linux 交互入口。本次本人文字已通过真实原 dot 与客户端实收验收，见[脱敏记录](TEXT_ACCEPTANCE_2026-10-22.md)；合成测试不能替代其他账号的准入、送达或生产验收。

## 身份路径与威胁模型

使用用户自己管理的官方机器人 AppID / AppSecret，通过官方 access token 和 Gateway WSS 接口接收 C2C 消息。没有二维码登录器、第三方 Agent 或 UNLICENSED 依赖；不代替用户登录个人 QQ。接口依据：[官方鉴权](https://bot.q.qq.com/wiki/develop/api-v2/dev-prepare/access-token.html)、[官方 WSS 与事件](https://bot.q.qq.com/wiki/develop/api-v2/dev-prepare/interface-framework/event-emit.html)、[AppID 与 openid](https://bot.q.qq.com/wiki/develop/api-v2/dev-prepare/api-call-guide.html)，2026-10-22 复核。应用是否允许该方式仍需控制台及真人验证。

1. 可信本地终端随机生成 192 位一次性挑战，有效期最多 120 秒。用户确认手机中的目标 QQ 账号及机器人后，仅向该机器人私聊发送挑战，不发到群、聊天工单或截图。
2. 网关只接受官方已鉴权 WSS 连接上的纯文字 C2C 事件，取得该 AppID 下的 `user_openid`。未知人普通消息、自称本人、昵称、群聊、附件均不能绑定。此阶段没有数据库、MCP 监听或 Tunnel 客户端。
3. 操作者必须在独立终端输入完整 `CONFIRM <AppID> <user_openid>`。QQ 消息不能执行确认。若已有可信本人 ID，使用 `--expected-owner` 进一步锁定；挑战来自错误预期身份、出现两个不同候选或过期均失败关闭。相同候选的重放不重复提示。
4. 确认后才建立新的私有 SQLite、四工具 MCP 入口及官方 Tunnel 客户端。绑定挑战不落任务库，不产生 ack/final。当前会话固定 AppID/owner，不能通过工具重绑；重开测试需重新确认。

该流程证明操作者控制发送秘密挑战的 QQ 账号，不证明法定身份，也不把控制台管理员 QQ 数字号码直接当作 C2C openid。信任终端、SSH（若使用）、官方 TLS、选定机器人凭据及操作者的账号核对。无法抵御已攻陷的同 UID/root 主机、终端记录器、QQ 账号被盗或操作者把挑战转给他人。不要将挑战及候选确认文本作为跨聊天自动授权材料。没有自动“第一条消息认主”。

## 明确批准后才运行

需确认选定机器人不会与其他使用它的服务冲突，以及目标服务器/目录、临时凭据使用、本人测试消息经 QQ→私有服务器→OpenAI、插件工具增加读取和发送能力。仅“继续开发”不授权真实运行。本脚本不创建账号、key、Tunnel、插件或订阅；它会连接已经指定的真实服务，因此不要为检查安装而运行它。

Node 24.21+、Python 3.10+；官方 `tunnel-client` 本入口按已验证 **0.0.17** 参数配置，升级需重新核对官方 CLI。必须从官方发行源校验安装，不能指向来历不明程序。保留既有只读入口与旧提交用于恢复，先确认前一客户端已停止，不能同时争用同一 Tunnel。

先创建并批准一个本用户所有的 0700 测试父目录，提供经过 discovery/官方资料核实的精确 QQ WSS hostname。以下占位符由操作者替换，路径参数不能包含任何秘密；它不是部署或安装命令：

```sh
python3 scripts/qq_private_test.py \
  --parent /ABS/PRIVATE/TEST_PARENT \
  --node /ABS/OFFICIAL/NODE24/bin/node \
  --tunnel-client /ABS/OFFICIAL/tunnel-client \
  --app-id APPROVED_APP_ID \
  --gateway-host VERIFIED_WSS_HOST \
  --tunnel-id EXISTING_PRIVATE_TUNNEL_ID \
  --organization-id VERIFIED_ORGANIZATION_ID \
  --maximum-seconds 1800
```

可选 `--expected-owner VERIFIED_USER_OPENID`。不提供昵称或其他机器人的 openid。仅支持 documented 官方 API profile，不能用此入口自动切换腾讯 SDK 私有契约。

脚本要求真实交互 TTY，隐藏输入 QQ application secret 和已有 Tunnel Read+Use key。输入无法隐藏就失败，不回退到明文。QQ secret 通过匿名 stdin pipe 进入 Node 闭包；Tunnel key 和随机 gateway bearer 只在必要的子进程环境中使用。最小子进程环境不继承其他账号凭据，禁止 core dump，不打印原始错误、客户端日志或响应正文。不要在带终端录制的环境运行。运行时仍有内存副本，不能承诺密码学意义的内存擦除，也不能抵御主机管理员读取进程环境。

绑定成功后输出 `gateway_ready` 表示本地入口及客户端进程已启动，**不代表 Tunnel 鉴权、原 dot 调用或 QQ 真人送达通过**。经批准刷新既有私人插件的工具发现，并逐一核对只含以下四个工具：

- `gateway_status`
- `list_pending`
- `read_message`
- `reply`：只接受原 message_id、ack/final 与文字，无平台、收件人、路径、URL 或媒体参数。

入口不广告或处理 events/resources，不允许微信、附件或任意命令。原 dot 手动读取新测试消息后发送 ack/final；本地窗口仍为 4 分钟，超时拒绝，不切换渠道。排队与 accepted/uncertain 语义沿用正式服务，uncertain 不盲重发。

## 停止、数据与恢复

总窗口包括绑定过程，最长 1800 秒，使用单调时钟；绑定最多 120 秒。输入 `STOP`、Ctrl+C、stdin 关闭、监督进程收到 SIGTERM/SIGHUP 或到期均触发退出。拒绝新的工具调用/收发，关闭 socket 并取消正在执行的 HTTP 请求。已被平台接收或在途消息无法撤回，因此停止不是“保证没发出”。

每次在父目录下创建随机 `qq-test-*` 目录，0700；SQLite 0600，暂存本人消息、身份绑定哈希及回复状态。没有长期 secret/config 文件。停止自己的 Node/官方客户端进程组（超出 3 秒终止宽限则强制结束）后，只删除本轮新建目录；清理验证目录 inode、父目录和符号链接，不删除历史数据或父目录。`.qq-test.lock` 是空锁文件，可保留。输出 `data_removed=true` 才确认清理成功；失败报告残留路径，不打印数据。

SIGKILL、断电或监督进程崩溃无法执行 finally；若客户端残留或目录保留，必须按本轮进程/路径核实后处理，不能盲删。备份、平台侧 QQ/OpenAI 历史、已创建插件/Tunnel 和 key 不因本地清理自动删除。脚本不修改插件权限，结束后需由已获授权的操作者恢复先前只读连接；未来重启 Tunnel 前重新核对工具面。没有 systemd、自启、长期订阅或会话自动续期。

## 离线验证

`node --test test/qq-test.test.js` 用模拟 QQ 传输与真实 loopback HTTP 验证绑定、越权、去重、ack/final、EOF 和超时。不调用 QQ/OpenAI。`python3 -m unittest discover -s test -p '*_test.py' -v` 的 Linux 项使用合成输入、PTY 和惰性子进程检验隐藏输入、超时、精确清理；Windows 明确跳过 Linux 专属部分。完整 CI 同时运行两平台。

本次已核实有效凭据、官方返回的 WSS hostname、挑战账号对应、私人插件四工具发现、QQ 收发及实际送达。MCP Events 自动触发不属于本入口范围，仍待独立明确授权与验收。每次新环境仍须核对精确 WSS hostname；本次官方 REST 新域名发现返回 api.sgroup.qq.com，不能只将文档示例 api.bot.qq.com 当成唯一 WSS 结果，也不能放开任意域名。
