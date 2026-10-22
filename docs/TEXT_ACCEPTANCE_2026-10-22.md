# 原 dot 本人文字真人验收

时间均为 UTC；证据来自原 dot 工具结果及用户实收确认，不是子线程代发或合成测试。账号稳定 ID、应用/组织/Tunnel ID、地址、聊天内容、二维码及凭据均不写入本记录。

| 平台 | 原 dot 实际操作 | 平台结果 | 用户确认实收 |
| --- | --- | --- | --- |
| QQ | 2026-10-22 16:12:54，list_pending/read_message/reply，同一消息 ack/final 各一次 | 两条 accepted，均有 provider_id，error=null | 16:15:58 |
| 微信 | 2026-10-22 16:21:05，同一原 dot 经私人 MCP 完成 ack/final | 两条 accepted，均有 provider_id，error=null | 16:21:40 |

范围：Linux 隔离目录、现有官方 tunnel-client 0.0.17、最长 30 分钟本人文字、私人插件四工具 gateway_status/list_pending/read_message/reply。QQ 按随机挑战及独立终端确认绑定；微信采用官方扫码 confirmed 稳定 ID 绑定。运行凭据只在必要进程内存/环境，不写代码、仓库或日志。QQ 运行构建 26c24af2a48246c8；微信运行构建 c859b95cc89a84a4（文件 manifest 内容哈希，不是 Git SHA）。

两次结束均对指定测试 supervisor 正常 SIGTERM，核验无残留子进程、官方客户端数 0、临时数据已删除、锁空闲。未停止其他服务，未撤销平台绑定或 key。旧基线 Git 提交 f34a0657ab8ff4849239afbf5c948068faa7d0c1 与旧目录保留。

修复并验证：隐藏输入后的空行不误判为拒绝；连接失败输出安全阶段/状态/退出码；保留 WSS 关闭码，处理服务端心跳、等待 READY 的超时；兼容实际官方发现的确切 WSS 主机；插件实际工具列表已刷新为 Read 3 / Write 1。

未验收：MCP Events 自动唤醒、长期订阅续期/撤销、生产常驻、真实网络故障恢复、微信图片/PDF 真人收发。没有安装第三方 Agent 或调用模型 API 替代原 dot。HTTP accepted 本身不等于用户收到，本次另取得两平台用户实收确认。
