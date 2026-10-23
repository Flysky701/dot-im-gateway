---
name: connect-dot-im-gateway
description: Connect the owner's QQ or Weixin private chat to an existing dot. Select server or temporary Windows operation and Plan A, B or C according to browser access; resume incomplete setup without repeating enrollment.
---

# 将本人 QQ / 微信私聊接到原 dot

Agent 负责技术操作与排错。项目有**两份 Skill、三种执行模式**：本入口负责选路和浏览器分工，[部署 Skill](../deploy-dot-im-gateway/SKILL.md) 负责服务器步骤。模式不改变授权范围。

## 授权与秘密

- 继承当前对话和可信交接中的服务器、平台、目标 dot、操作范围及批准，不重复询问已知信息，也不固定要求再回复「同意」。只补充影响当前步骤的缺失信息。
- 范围内常规开发、安装、调试及可恢复操作直接执行。已授权自启动包含必要的 linger；已明确批准的删除/不备份按原范围执行，不重复问。
- 未获明确批准的实际扣费、重要数据不可逆删除/覆盖、范围外敏感外传、控制权转移或扩大他人对重要资源的访问，暂停对应动作并说明实际后果；其余独立工作继续。Skill 不扩展授权，不绕过环境强制审批。
- 密钥、AppSecret、验证码、二维码和带 capability 的链接不得进入聊天、模型可见工具输出、日志、命令参数或额外临时文件。**允许授权交接程序在服务器写入 0600 凭据文件**（含原子写入暂存文件），与禁止复制秘密到工作文件不同。不输出 env 内容。
- A 仅在工具支持不回显的内存直传时代填秘密：页面值直接传到连接页，不返回值、不截图含秘密区域。不能安全直传时，仅将秘密输入一步交给用户，其余继续；不能先打印给模型再称为直传。
- 只连本人与自己机器人的私聊，不根据首条消息、昵称或群聊决定绑定。QQ 为文字；服务器微信支持文字和图片/PDF（单个 ≤4 MiB，保存 7 天）。

## 选路与分工

先复用已知服务器、SSH 配置、平台及原 dot；未知且影响选路时才询问服务器或临时 Windows 路线。用户指定模式优先，否则按实际能力选择。

| 模式 | Agent | 用户本人 |
|---|---|---|
| A：SSH/终端及已登录浏览器代操 | 部署、打开页面、准备 Tunnel、按秘密边界填表并连接、创建及连接插件、在原 dot 启用实际插件并发送订阅指令 | 登录、手机扫码/验证、平台要求本人完成的确认、发测试消息并确认收件 |
| B：SSH/终端及本机浏览器启动，无页面代操 | 部署、打开页面、准备不含秘密的名称/订阅指令并盯状态 | 按简短引导填表、连接插件、在原 dot 发送订阅指令，以及上述本人操作 |
| C：仅服务器或隔离终端 | 完成服务器步骤，给主机端启动器命令，每次引导一个缺失步骤并检查持久状态 | 在浏览器所在电脑启动转发、操作页面、完成本人操作 |

公共步骤描述需要完成的动作，不将 A 的填表、创建插件和发送订阅反过来交给用户。权限受限时只降级受限步骤，不承诺用户「只做两件事」。

有 Linux x64 服务器时进入[部署 Skill](../deploy-dot-im-gateway/SKILL.md)，区分复用修复、升级或独立新建，从已完成阶段继续。无服务器且为 Windows x64 时走临时路线；其他本机架构建议服务器路线。

## Windows 一次性连接

不保存凭据、不自启，也不推送事件自动唤醒 dot；关机、睡眠或进程退出即断开。若范围尚未明确，简述后补充确认；已有授权直接继续。

1. 下载匹配发布产物并核对发布校验文件，用 `--self-test` 验证一次：

   ```powershell
   $d="$env:LOCALAPPDATA\dot-im-connect"; New-Item -ItemType Directory -Force $d | Out-Null
   $r=Invoke-RestMethod https://api.github.com/repos/Flysky701/dot-im-gateway/releases/latest
   foreach($n in 'dot-im-connect-win32-x64.exe','dot-im-connect-win32-x64.exe.sha256'){ $a=$r.assets|?{$_.name -eq $n}; if(!$a){throw 'release_asset_missing'}; Invoke-WebRequest $a.browser_download_url -OutFile "$d\$n" }
   $want=(Get-Content "$d\dot-im-connect-win32-x64.exe.sha256").Split(' ')[0]
   if((Get-FileHash "$d\dot-im-connect-win32-x64.exe" -Algorithm SHA256).Hash -ne $want.ToUpper()){ throw 'checksum_mismatch' }
   & "$d\dot-im-connect-win32-x64.exe" --self-test
   ```

   记录版本；无匹配 Release 时按已有授权选择[本机构建](../../docs/PORTABLE.md)或服务器路线。未知发布者提示由用户本人决定，不绕过。
2. 在用户自己的终端保持程序运行并打开默认连接页。原生程序向该终端打印 capability，不将输出捕获回模型或聊天。服务端则使用部署 Skill 的无秘密输出启动器。端口占用可用 `--port 8799`。
3. 按[准备 Tunnel](../deploy-dot-im-gateway/SKILL.md#准备-tunnel)及 A/B/C 分工填表、勾选已授权的本人范围、连接，用户本人扫码。QQ 需要时核对 AppID 或完成本人验证文字确认。
4. 按[插件与订阅](../deploy-dot-im-gateway/SKILL.md#插件与订阅)添加并连接实际命名的插件，在原 dot 启用。**临时模式不订阅**，没有事件推送。
5. 请用户手机发测试消息；A 在原 dot 发送「用私人插件 `<实际插件名>` 读取我刚发的消息，先 ack 再 final 回复」，B/C 引导用户发送。用户确认手机收到两条后才报告实收成功。
6. 网页可关，进程要保留；断开后重启程序重新连接。持续在线和自动唤醒走服务器路线，微信解绑由用户在手机完成。

## 交付

简述路线、平台、实际插件名、版本/提交、已完成阶段、手机实收结果、恢复办法及密钥有效期（如有）。平台 `accepted` 仅表示平台接受，不能代替手机确认。阻塞时说明当前阶段、无秘密错误码和具体下一步，不重做已完成的部署/扫码。

QQ 使用打包的腾讯官方 `@tencent-connect/qqbot-connector` 1.2.0，其 UNLICENSED 声明见[第三方声明](../../THIRD_PARTY_NOTICES.md)；不复制私有接口或修改品牌信息。
