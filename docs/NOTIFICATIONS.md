# 本人主动通知与延迟观测

常驻网关提供 `notify_owner`，向当前已绑定的 QQ / 微信本人发送文字，不需要入站 `message_id` 或 ack/final。它负责立即入队与发送；定时触发由 Agent 已有的定时能力处理，本项目不新增调度平台。没有具体时间要求时不要创建提醒计划。

## 开启与调用

服务器需先运行包含本功能的代码、配置为 `mode=live`，目标平台已经完成本人绑定且 `enabled=true`。沿用当前普通用户、目录、凭据、Tunnel 和插件；升级不要求重新扫码。升级及服务重启按实际授权执行，**本次开发没有部署 Server3，也没有发送真人消息**。更新后在原 dot 刷新工具列表，确认出现 `notify_owner`、`notification_status`、`message_timing`。临时文字测试/一次性入口仍只有原四个工具。

先查 `gateway_status.notification_capabilities`：它报告实现、绑定、模式和本地限速，不代表平台已授予主动权限。无需新增 API Key 权限；不要为测试调用模型 API 或扩大账号访问。

QQ 示例，调用 `notify_owner`：

```json
{"platform":"qq","idempotency_key":"qq-proactive-check-001","text":"QQ 主动通知测试 001","context_mode":"none"}
```

微信无上下文实验，调用 `notify_owner`：

```json
{"platform":"weixin","idempotency_key":"wx-no-context-check-001","text":"微信无上下文主动通知测试 001","context_mode":"none"}
```

微信必须显式选择 `context_mode`：

- `none`：即使本地有旧消息也不读取或携带 `context_token`，不受本地被动回复窗口约束。是否被平台接受以及手机是否收到由本人实测；不保证任意时间可达。
- `latest`：发送时查找该本人仍在本地回复窗口内的最新已存上下文。缺失/过期时返回 `rejected` / `weixin_context_unavailable`，不自动改成无上下文，也不换渠道。这种模式**不能作为无上下文主动能力的证明**。

QQ 的 `context_mode` 可省略，默认 `none`；不支持 `latest`。两平台均不接受收件人、owner、群、入站消息 ID、用户提供的 context_token、文件或媒体参数。通知正文只写入私有队列，不进入诊断输出。

返回不透明 `id` 后，调用 `notification_status`：

```json
{"notification_id":"<notify_owner 返回的 id>"}
```

`queued` 是已入队（数据库内部仍为 `pending`）；`sending` 是发送中；`accepted` 为平台接受；`rejected` 为明确失败或重试预算耗尽；`uncertain` 为结果不确定；`cancelled` 为绑定撤销或人工取消。`phone_delivery=unknown` 始终保留，手机确认由用户给出。人工 reconcile 后的 `accepted` 没有平台接受时间，且带 `operator_reconciled`，不能伪装成平台收据。

同一逻辑通知固定同一个 `idempotency_key`（1–128 位字母、数字、点、下划线、冒号、连字符），重调不会多发；改变正文或上下文模式会报冲突。不要遇到 `uncertain` 就换 key 重发。一个新的提醒发生时使用新的 key；平台端不保证 exactly-once，进程在发送后落库前崩溃仍需人工核实。

本地每平台最多新建 20 条/小时，待发最多 20 条；每平台发送尝试至少间隔 30 秒，明确可重试错误最多 8 次。队列保存 24 小时的发送有效期，超时不补发；**这不是 QQ/微信平台窗口承诺**。上述本地限额不能替代平台权限、频率或额度限制，也不会通过换 key 绕过平台限制。微信 session 失效不自动重新扫码。

## 可直接给原 dot 的提示词

QQ 一条测试（先替换实际插件名）：

> 使用私人插件 `<实际插件名>` 的 notify_owner，platform=qq，context_mode=none，idempotency_key=qq-proactive-check-001，text=“QQ 主动通知测试 001”。只发给已绑定的我，不读取来信来拼回复、不调用 reply、不创建定时计划。查返回 ID 的 notification_status，告诉我状态和错误类别；如果 uncertain 不重发。我会自己确认手机收到。

微信一条无上下文测试：

> 使用私人插件 `<实际插件名>` 的 notify_owner，platform=weixin，明确 context_mode=none，idempotency_key=wx-no-context-check-001，text=“微信无上下文主动通知测试 001”。我是在测试无上下文主动能力，不要改用 latest 或 reply，不要伪造 context_token，也不换 QQ 发送。查询该 ID 的 notification_status；accepted 只报告平台接受，等我确认手机实收。uncertain 不重发，不创建计划。

重复执行同一条测试时保持相同 key；用户明确要另发一条测试时才换新的 key。需要提醒时，用户指定时间后由 Agent 定时调用同一工具，不能拿现在一次接受就承诺长期必达。

## 怎样确认没有借用来信

测试前不先在 QQ/微信发“触发消息”。从原 dot 发起上述工具调用，确认调用的是 `notify_owner`、没有 `message_id`，返回的 `context_mode=none`。QQ 适配器的主动请求不含 `msg_id/msg_seq`；微信的 `none` 不含 `context_token`，本地已有上下文也不会带上。离线测试直接检查真实适配器构造的请求字段，包括“零入站记录”和“旧回复已过期”情况。不要为验证而打印含身份、正文或凭据的完整请求。

再核对该通知的唯一 ID 和状态，由手机确认相同测试文字确实出现。记录“平台接受”和“手机实收”两项；若被拒绝记录无秘密错误类别。微信 `latest` 成功只验证上下文模式，不证明 `none` 支持。QQ 无主动权限/额度、微信拒绝无上下文都是有效的真人测试结果，不能硬编码成成功。

协议依据：QQ 官方 [USAGE 5.2/9.4](https://github.com/tencent-connect/qqbot-nodejs/blob/main/USAGE.md) 与 [sendProactiveMessage/buildProactiveBody](https://github.com/tencent-connect/qqbot-nodejs/blob/main/src/protocol/api/messages.ts) 使用无入站 ID 的主动文本请求，但有平台额度限制。微信官方 [协议 sendMessage](https://github.com/Tencent/openclaw-weixin/blob/main/docs/protocol_zh_CN.md) 和 [发送实现](https://github.com/Tencent/openclaw-weixin/blob/main/src/messaging/send.ts) 允许客户端警告后尝试省略上下文，这不是服务端任意时间接受的承诺。本轮是独立兼容实现与离线请求验证，没有真人平台结果。

## 分段延迟

`message_timing({"message_id":"<不透明消息ID>"})` 不返回正文、账号、回调 URL、密钥或 context。它也不会自己把一次诊断标记成 dot 读信。

| 字段 | 含义 |
|---|---|
| `source_created_at` | 平台给的源时间，时钟域为 `platform`，不能直接当服务器接收时间 |
| `received_at` | 首次写入网关收件队列的服务器时间；重试/重复拉取不刷新 |
| `dot_read_at` | 服务端首次成功处理 read_message 或返回含该消息的 list_pending；不能证明模型已经理解或手机送达 |
| `events[].queued_at / started_at / last_started_at / accepted_at` | 事件入队、首次观察到的投递开始、最近投递开始、回调接受时间 |
| `replies[].queued_at / started_at / last_started_at / accepted_at` | ack/final 各自的入队、首次/最近发送尝试开始、平台接受时间 |
| `attempts / retries` | 已开始的尝试次数及重试次数，不代表网络耗时为零 |
| `phone_delivery_at` | 无手机送达收据，固定为 null |

观测时间是服务器 Unix 毫秒；本地时间倒退形成的负耗时输出 null。旧数据库的时间列是兼容增量，历史缺失值保持 null；升级后重试只能记录新观察，不能还原升级前首次尝试。事件诊断最多列 32 条，通常只有一个目标订阅。

已知服务器段输出 `queue_to_first_send`、`last_send_to_accept`、`first_send_to_accept`；后者可能含重试和退避。消息级 `gateway_to_dot_read` 包含订阅等待、事件与调度过程；`dot_read_to_final_queue` 包含排队、模型处理、工具执行等，**不是纯思考时间**。发送段包括适配器准备（如取 token/上传媒体）、网络与上游处理，不能仅凭这一段认定全是网络。

此前 Server3 的两条微信记录均一次尝试后 accepted，但旧库没有这些时间点。已知首条在订阅建立前到达，所以含初始化等待。按当时 `events.due` 的队列规则推算，源时间到首次事件调度约 263.699 秒和 0.998 秒；这是已有字段推算，既不是端到端耗时，也不能拆分网络/推理/工具耗时。一次尝试不能排除单次网络等待；后半段须升级后重新真人测量。

## 恢复与回滚

通知复用原工作循环、私有 SQLite、备份及 reconcile，不建立另一个服务。发送中崩溃或恢复备份会隔离通知为 uncertain。恢复到旧代码时，新通知表会保留但不被旧代码处理；再次升级可能继续仍有效的 queued 通知，因此回滚前处理完待发项，或在停止服务后按既有备份恢复流程隔离它们。原 ack/final 顺序、回复 TTL、文件/媒体及多用户限制均保留。
