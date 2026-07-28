# 测试手册

## 1. 交付前必跑检查

```powershell
npm run validate:architecture
npm run typecheck
npm test
npm run build
npm run validate:plugin
npm run test:workspace-flow
node scripts/probe-mcp.mjs
npm audit --audit-level=high
```

MCP 验证必须真实完成 `initialize` 和 `tools/list`。仅看到进程运行或 HTTP 响应不算通过。
当前 `validate:plugin` 在 `package.json` 中仍引用个人机器的绝对路径；公开仓库/CI 必须先把
验证器改成 repo-local 或版本固定的可安装工具，不能把本机偶然存在视为可复现门禁。

`test:workspace-flow` 是纯代码/API 闭环，不启动或操控浏览器。它使用临时端口和临时
SQLite，验证：创建房间 → 一次性 Host 配对 → 发布任务目录 → 待批准成员被拒绝 →
房主批准并授予项目写权限 → 选择任务 → 发布历史和文件 → 已批准成员读取 → Host
认领并安全保存 → 旧 SHA 冲突且不覆盖，结束后自动删除临时数据。
该闭环也会真实完成 WebSocket 升级，确认短期实时票据可用一次且复用返回 401。

## 2. 公网健康检查

```powershell
curl.exe --fail --silent --show-error `
  https://codex-collab.217.194.133.194.sslip.io/health
```

检查：

- HTTP 200；
- JSON 中 `status` 为 `ok`；
- `Strict-Transport-Security`；
- `X-Content-Type-Options: nosniff`；
- 首页、静态 JS/CSS 和 WebSocket 均来自 HTTPS 域名。

## 3. 邀请闭环

每次部署后至少执行一次：

1. 主人创建会话；
2. 主人创建 60 分钟、一次性邀请；
3. 确认邀请链接使用公网 HTTPS 域名；
4. 新浏览器上下文打开邀请；
5. 在已有主人会话的标签页打开邀请时，仍必须显示“申请加入”，不得恢复成主人；
6. 确认令牌自动填入且申请成功后地址栏 fragment 被移除；
7. 协作者提交申请；
8. 主人看到待批准成员；
9. 批准前协作者不能发消息；
10. 主人批准；
11. 协作者发送消息；
12. 主人收到同一条消息；
13. 再次使用一次性邀请应被拒绝。
14. 主人关闭房间后，创建邀请、加入、聊天、Codex 指令和附件均返回 `room_closed`；
15. 历史、成员列表和停止当前 Codex 任务仍可用，协作者不能修改开关；
16. 主人重新开启后，原会话恢复发送能力，双方通过 `session.updated` 同步状态。

测试输出不得记录原始成员 token 或仍有效的邀请 token。

## 4. 复制按钮

测试以下场景：

- 正常 HTTPS 浏览器点击“复制邀请链接”，按钮变为“已复制”；
- 把剪贴板内容粘贴到临时文本框，确认是完整 HTTPS 链接；
- 浏览器拒绝 Clipboard API 时，旧式同步复制仍可工作；
- 两种自动复制都被阻止时，链接自动全选，并提示按 `Ctrl+C`；
- 直接点击链接输入框时会全选全部内容。

## 5. 安全回归

- 待批准成员访问 `/messages`、文件和 Codex 指令均被拒绝；
- owner 批准成员后响应必须为 `workspace-write`，随后切回只读时写操作必须被拒绝；
- 非主人不能创建邀请或批准成员；
- Relay 数据库不出现原始 bearer token；
- WebSocket URL 使用 30 秒一次性实时票据，不出现长期成员 token，票据复用必须失败；
- 创建房间、加入、Host 配对、发消息和实时票据接口触发限流后返回 429；
- `../`、绝对路径跳出和符号链接逃逸均被拒绝；
- 写文件时预期哈希变化会产生冲突；
- Windows 写入锁定实际文件句柄并校验哈希；已打开写句柄、外部替换和双写者竞争均失败关闭；
- 目标移入恢复区后的发布使用 no-replace；空窗出现并发版本时保留目标、旧版与候选版，绝不覆盖；
- helper 在发布前被强制终止时，已 fsync 的 journal 与恢复文件可支持人工恢复；
- 临时候选文件使用随机名称和排他创建，恢复目录不能通过 symlink/junction 逃逸；
- 非 Windows Host 写入失败关闭，不回退到普通 rename；
- 文件操作 lease 超时、成员撤销或写权限撤销后不得访问磁盘或提交结果；
- 未选择 Codex 任务时不能创建文件操作；文件数量、总字节数、写入速率和结果保留均有硬上限；
- 项目根目录授权不会隐式授权 `.codex`；
- 公网只暴露 HTTPS Relay，不暴露 Codex `app-server`；
- 非主人不能把 Codex 权限切换为自动批准、完全访问或自定义模式；
- 房主从网页发送的 Codex 指令会由本机 Host 自动转发，并在成功启动后持久去重；
- 已批准协作者的指令可以进入 Host 队列，但 Host 最终必须强制为 workspace + on-request，
  即使当前主人任务使用 `never/full-access` 也不能继承；
- 空闲任务通过 Desktop `thread-follower-start-turn` 接收；运行中任务只显示首条
  “执行中”，后续指令保持“排队中”并在前一条完成后按顺序提交；
- 最新指令仍运行时，app-server 短暂返回 `interrupted` 不得提前写成“执行失败”；
- 指令提交与停止不会打开、聚焦或切换 Desktop 窗口；
- 附件文件名拒绝路径穿越、Windows 设备名和非法字符，下载必须携带成员令牌；
- UTF-8 文本附件直接进入 app-server 输入；二进制暂存目录不出现在文件工具或网页快照中；
- Host 配对码使用一次后失效，数据库不出现原始配对码或 Host token；
- 非房主不能发布任务目录、选择任务或发布快照；
- 切换任务必须原子替换为该 task 的独立缓存/分页时间线，不泄漏上一个 task；根级文件目录
  可复用，其他 task 的历史缓存不得被销毁或冒充当前时间线；
- Codex 记录包含 app-server 可见推理摘要和命令输出，但不包含原始隐藏思维链；
- 超过 20 MB 的 Codex rollout 自动回退到 app-server 分页历史与运行状态，不中断后续同步；
- 命令输出中的高置信 Token、私钥块和凭据赋值会被脱敏；
- 项目根不会隐式开放 `.codex`；只有单独显式的 `codexConfigRoot` 会加入配置快照；
- `.codex` 快照排除 `auth.json`、其他任务 Session、历史数据库、私钥和高置信凭据；
- `.codex` 只有显式 `codexConfigRoot` 才能读取，并且任何成员都不能写入；
- 网页文件快照排除 `.env`、二进制与符号链接。
- 网页文件快照始终排除 `.runtime-data`，并遵守项目根目录的 `.codex-collabignore` 路径前缀。
- Windows 上 `.codex-collabignore` 的大小写变体不能绕过忽略规则。
- `.aws/.azure/.ssh/.gnupg` 等私有目录在扫描、直接读取、写入和快照路径中统一拒绝；
- `.codex` 的嵌套 JSON/TOML token、env、header、cookie 和 URL credentials 必须经结构化
  allowlist 拒绝，不能只依赖高置信正则；
- Codex 接受 prompt、文件副作用完成、local receipt 和 Relay complete 前后分别强杀进程，
  每个 command/operation 最终只能有一次可观察副作用。

## 6. UI 回归

- 桌面浅色和深色主题；
- 悬停主题和附件按钮时页面尺寸、主题与滚动位置保持稳定，不出现整页闪烁；
- 390px 宽度不出现水平滚动；
- 会话创建、加入、待批准、已批准四种状态；
- 空消息、长消息、成员列表和错误提示；
- 邀请弹窗、复制成功与复制失败反馈；
- 页面刷新后的标签页会话恢复；
- 离开本机会话不会删除服务器数据。
- 房间 ID + 主人恢复密钥可在新浏览器恢复 owner；恢复签发新 token，但测试不能误报为旧 token 已轮换；
- Composer 支持 Enter 发送、Shift+Enter 换行、刷新后恢复草稿和执行设置；
- 文件选择、拖放和粘贴附件显示名称/大小，失败发送不会清空草稿与附件；
- Codex 指令显示“排队中/执行中/执行完成/执行失败”，运行中显示停止按钮；
- 首次加载和切换任务期间，聊天记录区域中央持续显示加载动画，不先闪出空状态；
- 主人房间开关在桌面与移动端可用；关闭后编辑器、邀请、上传和发送均禁用；
- 非主人权限选择器禁用，主人可选择权限、模型、推理强度、速度和计划模式；
- “Codex 与文件”支持未配对、已配对、等待导入、已同步和空文件状态；
- 房主能选择本项目 Codex 任务，已批准协作者只能查看已选任务；
- 记录列表能区分用户、Codex、推理摘要和命令执行；
- `.codex/` 配置文件与项目文件使用不同路径前缀显示；
- 全屏 Monaco IDE 的搜索文件树、多标签、脏标记、`Ctrl+S` 和冲突 Diff 可用；
- 新建 UTF-8 文件/目录与同父目录重命名可用，权限拒绝和 stale-hash 不静默覆盖；
- task A 的 Codex 草稿、附件、open tabs、dirty draft、选择和 Monaco undo 不出现在 task B；
- 隐藏文件面板、Host 离线/重连和切 task 不卸载未保存内容，远端变化显示 stale/deleted；
- Explorer、tabs、disclosure 和 splitter 支持完整键盘操作，文件 range 跳转使用真实 selection；
- 被主人切为只读的成员不能保存，获批写权限成员可保存项目文件，`.codex` 始终只读；
- 文件工作区在桌面与 390px 宽度可用。

现有 Dashboard 测试主要使用静态 SSR，`test:workspace-flow` 也不启动浏览器；上述 focus、键盘、
pointer、ResizeObserver、Monaco model、断线保活和双用户旅程必须增加 mounted DOM 与 Playwright
门禁后才算自动验证完成。
