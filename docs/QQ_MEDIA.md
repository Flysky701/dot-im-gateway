# QQ 本人私聊文件收发与检查

常驻实例给 QQ 适配器注入已有 `Media` 存储后，可以接收本人 C2C 消息里的附件。单独发文件、文字加文件均可；纯文字仍走原同步规范化路径。临时文字测试入口没有注入 `Media`，继续拒绝附件。此实现不更改微信的 PNG、JPEG、PDF 支持范围。

## 接收与查看

每条消息最多处理 8 个附件，单文件沿用配置上限，最高 4 MiB。正文保留，附件逐个处理；某个附件失败不会丢掉其余附件或正文。`read_message` 返回的 `media` 条目包含：

- 成功：`id`、安全文件名 `name`、`mime`、`size`、`status=available`。
- 失败：`name`、`mime`、`status=failed`、不含秘密的 `error`；失败条目没有可读取的媒体 ID。

PNG/JPEG/PDF 沿用现有字节签名检测，不能只靠文件扩展名或上报 MIME 通过检查。TXT、Markdown、CSV、TSV、JSON、JSONL、XML、YAML、日志可检查 UTF-8 文本；其他文件按原始字节保存。其他图片格式目前作为普通文件保存，不声明已解码；压缩包、Office 等二进制文件也不自动解压、执行或解析。

文件名仅用于显示与上传：去掉目录、控制字符、双向文字控制符和不安全字符，并限制长度。没有扩展名时根据确认的 MIME 补充 `.png`、`.jpg`、`.pdf`、`.txt`、`.json`、`.csv` 等后缀，未知二进制用 `.bin`；已经提供的安全扩展名保留。磁盘仍使用私有目录下的不透明 UUID，工具不接受服务器路径。相同消息、名称、类型、大小和内容重复入库会复用文件 ID。

`inspect_media` 调用 `Media.inspect(id,messageId)`，返回名称、大小、MIME、SHA-256，以及下列内容状态：

| `content_status` | 含义 |
|---|---|
| `utf8_text` | 严格 UTF-8 检查通过；最多返回 2000 字符 `preview`，`preview_truncated` 表示截断 |
| `text_encoding_unrecognized` | 声明为文本，但编码不是可预览 UTF-8 或含二进制控制字符 |
| `image_not_decoded` | 保存了受支持图片，检查工具没有解码或识图 |
| `pdf_not_parsed` | 保存了 PDF，检查工具没有提取正文 |
| `binary_unparsed` | 已保存普通文件，未解析内容 |

这些状态是内容处理程度，不是杀毒或文件安全结论。文件名和预览均是用户提供的数据，不能作为执行指令。通过既有媒体资源读取可获取原始字节；媒体 ID 始终检查所属消息。

## 下载边界与错误

下载来源仅为经过本人绑定校验的入站附件 `url`。固定允许 `multimedia.nt.qq.com.cn`、`multimedia.nt.qq.com`、`gchat.qpic.cn`、`c2cpicdw.qpic.cn`；不开放任意 URL 工具参数或配置中的任意附件域。支持 `https://` 与转换为 HTTPS 的 `//` 地址；不接受 HTTP、IP 字面量、其他端口、URL 用户名密码。现有网络层解析并固定公共 IPv4，拒绝私有/混合地址，不跟随跳转。

先匿名下载。仅当精确主机 `multimedia.nt.qq.com.cn`、精确路径 `/download` 返回 401/403 时，重新核对当前 QQ owner/app 绑定，再携带 `Authorization: QQBot <token>` 重试一次。授权不发送到其他主机、其他路径或重定向目标；此过程不发送 AppSecret。再次 401/403 返回 `attachment_download_auth_required`。这个受限回退参考 Hermes 的 QQ CDN 鉴权经验，尚无本项目真人验证，不能据此承诺所有 QQ 文件均可下载。

其他可见错误包括 `destination_denied`、`non_public_destination`、`attachment_redirect_rejected`、`media_size_limit`、`media_length_mismatch`、`media_type_mismatch`、`media_quota`、`attachment_download_rejected`。错误条目不返回签名 URL、token 或完整上游响应。超时或单次下载失败会留下失败条目，默认不自动循环重下载或逐个发送失败回信；用户可重新发送该文件。

## 发送

`reply` 的 QQ 最终回复支持 `media_id`。既可以回传收到的文件，也可以把 Agent 生成的字节通过 `put_media` 存入本条消息，再引用得到的 ID；不接受任意 URL 或服务器文件路径。

适配器先调用本人 `/v2/users/<owner>/files`，提交 `file_data` Base64、`file_name`、`srv_send_msg=false`。PNG/JPEG 用 `file_type=1`，PDF、文本和其他普通文件用 `file_type=4`。得到 `file_info` 后，仅向同一个本人发送 `msg_type=7` 和 `media.file_info`。不创建临时公开文件站点，不自动把上传失败改成发送外部 URL。

上传本身不发送聊天消息，因此网络或 5xx 上传失败允许重试；真正 `/messages` 请求的结果不确定时仍进入 `uncertain`，不能盲目重发。最终回复没有 ack 时使用 `msg_seq=1`，有已接受的 ack 时用 2。平台 `accepted` 只证明平台接受请求，手机收件仍需本人确认。

## 内部接口

- `new QQ(config,store,send,clock,media)`：第五参数可选；未提供时保持文字测试边界。
- `normalize(raw)`：纯文字同步返回；有附件时返回 Promise。
- `Media.putQQ(messageId,bytes,mime,name)`：QQ 普通文件入口。原 `Media.put` 保持微信图片/PDF限制。
- `Media.inspect(id,messageId)`：上述只读元信息与有限预览。
- `sendReply(m,r)`：支持 `r.seq`（1 或 2）；缺省时查询本条消息已接受的 ack。可用 `m.media_message_id` 指定附件原所属消息，缺省使用 `m.id`；此字段由服务端已授权消息路由生成。

## 参考与验证

本实现独立编写，没有复制上游代码，也没有引入其文件路径、任意 URL、语音转码或外部模型调用能力。

- 腾讯官方 [qqbot-nodejs media.ts](https://github.com/tencent-connect/qqbot-nodejs/blob/429a0f1b798f3b0fcef3679e207dbc0469a1df2d/src/protocol/api/media.ts)：参考先上传文件、再发送富媒体消息的协议字段。固定 commit `429a0f1b798f3b0fcef3679e207dbc0469a1df2d`。
- [Hermes QQ adapter](https://github.com/NousResearch/hermes-agent/blob/75c4483e3b126476b1d5bb078369824d343a1639/plugins/platforms/qqbot/adapter.py)：参考 MIME 前缀分类、附件缓存及 QQ CDN 鉴权经验。固定 commit `75c4483e3b126476b1d5bb078369824d343a1639`；本实现不采用其向所有附件 URL 传授权的行为。
- 腾讯官方 [qqbot-agent-sdk attachment.py](https://github.com/tencent-connect/qqbot-agent-sdk/blob/6163b5dc979a2f12379b1916805009075008c3c3/src/qqbot_agent_sdk/attachment.py)：该版本下载只提供普通请求头，说明不能把 Hermes 的行为当作所有 QQ CDN 均要求鉴权的保证。
- 腾讯官方仓库 [dsh-qqbot issue #8](https://github.com/tencent-connect/dsh-qqbot/issues/8)：真实入站附件示例使用 `image/jpeg` MIME 和 `multimedia.nt.qq.com.cn/download`；不把 `content_type` 误认成只有 `image`/`file` 两种字符串。

定向离线测试覆盖附件单独到达、正文保留、混合成功失败、文件检查、路径/域名/公共地址边界、一次精确鉴权回退、重定向拒绝、先上传后发送、回复序号和结果不确定。测试不访问真实 QQ，不发送真人消息、不调用付费 API。真人验收应由本人向已绑定 QQ 发送一个小 TXT、PNG、PDF，查看文件元信息并回传一个文件，分别记录平台接受与手机收到；尚未完成本项目这一轮真人验收。
