# 运维

所有 CLI 都使用显式配置：`node /prefix/current/bin/gateway.js <command> --config /prefix/config.json`。可给已检验的 bin 脚本设置执行权限，或一直通过 Node 调用。服务仅一个进程，不要同时运行手工 serve 和 systemd serve。

| 命令 | 行为 |
|---|---|
| `config init` | 仅新建配置，拒绝覆盖；离线/关闭平台/关闭订阅 |
| `doctor` | 检查本地配置、Node 版本、secret 是否存在；不输出值、不发网络请求 |
| `status` | DB 队列分类计数。不是活进程/平台连通性证明 |
| `logs` | 最近 100 条固定类别审计，最多保留 10000 条 |
| `backup --to NEW_DIR` | 要求服务停止；数据库快照+媒体+SHA256 清单；目标不得已存在 |
| `restore --from BACKUP --to NEW_DIR` | 哈希验证，新目录恢复；pending/sending 回复变 uncertain，所有订阅撤销 |
| `reconcile --id REPLY_ID --decision accepted` | 服务停止后，人工确认已发送；允许对应 final 继续 |
| `reconcile --id REPLY_ID --decision cancelled` | 人工确认取消；不会重发，若取消 ack 则 final 仍被阻止 |
| `upgrade / rollback / uninstall` | 调用确定性部署脚本，默认只展示计划 |

## 故障处理

`pending` 长时间不动：检查服务、模式、原 dot 是否已订阅/收到事件、是否调用 reply、ack 是否阻塞 final、原消息期限和平台授权。`events=accepted` 只表示 ChatGPT callback 接受，不能证明 dot 已处理。`replies=accepted` 只表示平台接口接受，需真人确认聊天可见。

`uncertain`：任何传输中断、未知 5xx、成功响应格式无法判定，或发送中崩溃都可能触发。**不自动重试**。让用户核对原聊天记录，再 accepted/cancelled；没有查询证据就保留 uncertain。首版不提供任意重新发送命令。需要新的回复尝试时，由用户发送新消息形成新上下文。

`dead` webhook：瞬时错误重试预算耗尽，410 或 413。排查 callback 允许列表、订阅有效期和用户侧连接；必要时用户重新建立订阅或要求原 dot 使用 list_pending 查看积压。已 dead 的同 ID 事件不自动重放。410 会禁用订阅，不能通过后台心跳擅自恢复授权。

微信 session -14：暂停轮询一小时，待用户处理登录授权；不会自动扫码。QQ fatal close：停止该 gateway 循环并留下类别日志，用户核实平台权限/凭据后重启。普通断网使用有上限的退避重连/重试。平台 upstream 不保证补齐从未交付的历史消息。

## 备份和恢复

先停止 gateway 服务，保留 tunnel 服务也不能调用已停止网关。backup 内包含私信、context 和签名密钥，目录必须私有，建议放在可信加密备份介质。

```sh
systemctl --user stop dot-im-gateway.service
node /prefix/current/bin/gateway.js backup --config /prefix/config.json --to /private/backups/run-001
node /prefix/current/bin/gateway.js restore --from /private/backups/run-001 --to /private/recovered-data
```

确认恢复结果后，人工审查并把配置 dataDir 切到新路径。恢复不会覆盖旧目录，不自动重新订阅，不自动重发旧待发送项。验证身份绑定、媒体和不确定队列；重新通过订阅关卡。不要直接复制一个运行中的 SQLite 文件代替备份命令。

## 升级、回滚和卸载

源码 release 必须来自已审阅的本地检出，脚本不下载或跟踪 latest。先跑 plan，再 apply。升级会停服务、测试新 release、保存数据备份、核对文件并原子切换 current，然后启动并检查 systemd active。**active 只说明进程，不代表上游可用**；之后执行 doctor 和真实只读工具检查。若失败，脚本停止并保留旧 release/备份，按最后完成步骤排查。

```sh
node /prefix/current/bin/gateway.js upgrade --prefix /prefix --release /reviewed/source
node /prefix/current/bin/gateway.js upgrade --prefix /prefix --release /reviewed/source --apply
node /prefix/current/bin/gateway.js rollback --prefix /prefix --apply
node /prefix/current/bin/gateway.js uninstall --prefix /prefix --apply
```

回滚仅切换同 `0.1.x`/schema 1 的上一个代码 release，不倒退数据库；跨 schema 迁移需新版本专门方案。卸载停止/disable 本服务、移除本项目 unit/current 链接，**保留 data、config、runtime.env、releases、backups**，不删除官方 tunnel-client 或其他服务。若要撤销外部授权，应由用户另行在原 dot、Tunnel 和平台完成；卸载本地服务不是外部凭据撤销。
