# Codex Collab 项目说明

## 1. 项目目标

Codex Collab 是一套 local-first 协作层，让小型可信团队通过同一个主人控制的 Codex
环境协作。公网 Relay 负责身份、邀请、批准、消息和实时分发；本地 Codex 插件负责文件
访问与向 Codex 转发指令。

最重要的边界是：协作者可以提出请求，但不能绕过主人的批准策略、沙箱或明确共享根目录。

## 2. 当前版本状态

当前版本为 `0.1.0`，已经达到邀请测试条件：

- React + Fluent UI v9 控制台，支持浅色、深色与 390px 移动端布局；
- 一次性、可过期、限制使用次数的邀请链接；
- 新成员默认处于待批准状态；
- 主人批准后才允许成员发送消息或 Codex 指令；
- 顶部房间开关由主人控制；关闭后保留历史查看和停止控制，但暂停新邀请、加入、聊天、
  Codex 指令与附件；
- WebSocket 实时成员和消息更新；
- Codex MCP 插件、任务绑定与 `app-server` 指令转发；
- 网页 Composer 支持多行草稿、Enter 发送、Shift+Enter 换行、文件/图片附件、听写、
  计划模式、模型、推理强度、速度以及发送/停止状态；
- 网页生成的一次性本机配对码、Codex 任务目录与房主选择；
- 房间 ID + 一次性显示的主人恢复密钥，Relay 只保存恢复密钥哈希；
- 导入用户/助手消息、app-server 可见推理摘要与命令输出；
- 当前源码保证协作者时间线的末次增量不会被实时刷新限流丢弃，并在任务终态或 Realtime 重连后
  对账指令状态，避免已完成任务继续显示运行中；
- 已完成任务把执行过程、Codex 最终总结和结构化文件变更显示为一个结果块；执行步骤默认折叠，
  总结与耗时保持可见，文件列表先显示前三项且可继续展开；
- 活动任务使用 Codex 式正文流：处理说明直接显示，每两段处理说明之间相邻的正常完成/停止命令
  折叠为一个“运行了多个命令”批次，不跨正文重排；仅当前运行命令展开，失败命令保持单独展开；
  嵌套长命令在轮询期间保留原始命令，明确完成输出或退出码到达后立即折叠；
- 每个 task 的有界历史缓存、后台回填与向上分页；
- 全屏 Monaco IDE，支持文件树搜索、标签页、未保存状态、`Ctrl+S` 和冲突 Diff；
- 新建 UTF-8 文件/目录与同父目录安全重命名；
- 主人批准成员时即授予项目 `workspace-write`；主人之后仍可切回只读或撤销成员；
- 可通过第二个显式绝对根目录共享 `.codex` 非凭据文本配置；
- 仅限明确绝对根目录的文件读取、带预期 SHA-256 的原子写入；
- 路径穿越与符号链接逃逸防护；
- Docker Compose、SQLite 持久卷、Caddy HTTPS 与 WebSocket 代理；
- 公网控制台：<https://codex-collab.217.194.133.194.sslip.io/>。

主人桌面端已经形成可安装的 Windows 内部 Beta 候选：Dashboard browser/desktop Runtime、
task-scoped Codex 草稿/附件与 IDE 状态、Relay 对 `expectedWorkspaceThreadId` 的原子校验、结构化
file activity、Host `active/draining/suspended/catching-up` 状态机、唯一 Host Service、受限 Windows
Named Pipe IPC、Codex/文件 durable receipt，以及 Electron main/preload、安全协议、安全窗口和
`safeStorage` 凭据边界均已实现。
自动化门禁、18 工具 MCP probe、未签名 NSIS/unpacked build、SHA-256、SBOM 和内容扫描已经通过；
干净 VM、两个真实浏览器 context 和完整 Electron/Monaco 交互旅程仍需人工放行，不能由进程级 E2E
代替。

需要明确区分：已发布的 `v0.1.0-beta.1` 仍是直接复用网页 Dashboard 的 runtime/security Beta。
本机已升级安装独立 `DesktopWorkspaceShell`、Renderer entry、全窗口 Fluent 工作台、Activity rail、
command/status bar 和桌面导航的 `v0.1.0-beta.2`；真实检查发现的项目文件分隔条和底部状态栏问题
已在后续候选修复。进一步检查确认原内嵌托盘 PNG 损坏，窗口会隐藏但没有可见恢复/退出入口；
该问题已在 `v0.1.0-beta.4` 修复；Explorer 双向缩放进入 `v0.1.0-beta.5`。Beta 6 修复了最终回复
终止对应 turn 的转圈、陈旧消息刷新回退 `completed` 和 Desktop/MCP 双 Writer。当前本机已升级到
`v0.1.0-beta.10`：活动过程按正文、折叠命令批次和唯一当前命令显示，Desktop
与 MCP 也已统一连接本机 profile 下的唯一 Host。后续源码又补齐“任务已停止但无 task_complete”
的逐步终态与嵌套命令会话关联。Beta 10 已覆盖安装，ASAR SHA-256 为
`63F1D6D92C5C0512DB4F01E1F93379D4DC13006B769B2419F726363601A693F3`；Renderer 动态探针确认
长命令运行时显示真实命令，返回退出码后立即折叠，Relay 200、Host active 且旧陈旧命令不可见。
托盘最终点击旅程
和其余主人完整旅程仍待人工放行，因此仍不把该候选描述为“桌面产品界面已经完成”。后续状态见
[主人桌面端实施计划](../plans/DESKTOP_IMPLEMENTATION_PLAN.md)。

当前桌面发布口径是“未签名内部 Beta”：没有自动更新，未宣称通过 SmartScreen；测试者安装时
应预期 Windows 可能显示 SmartScreen 警告。最新协作者实时反馈修复已进入本机 Beta 10；服务端
反馈闭环先于 2026-07-31 随提交 `6904723` 部署；跨正文合并的 `dbca79b` 经需求澄清后已由
按文字区间折叠的 `c11976e` 替换并部署到 Primary Relay。Guest 保持原 release、原容器和原首页
资产，共享 Caddy 未重启，也未作为桌面端验证环境。详细状态见
[主人桌面端实施计划](../plans/DESKTOP_IMPLEMENTATION_PLAN.md)。

这代表“可邀请真实测试者验证 MVP”，不代表已经完成商业生产的全部加固。未完成项在
[TASK_PLAN.md](../plans/TASK_PLAN.md) 中持续跟踪。

## 3. 使用角色

### 主人

- 创建会话和邀请；
- 开启或关闭房间；
- 查看并明确批准待加入成员；
- 绑定唯一明确的共享项目根目录；
- 选择要接收协作者指令的 Codex 任务；
- 从网页选择并导入本机已有 Codex 记录；
- 选择接收队列的 Codex 任务并控制 Codex 审批权限；
- 保留原有 Codex 审批策略和沙箱控制权。

### 协作者

- 通过短期邀请链接申请加入；
- 获批后参与共享聊天；
- 提交带身份标记的 Codex 指令；
- 在主人共享根目录内使用允许的文件工具；
- 在网页查看主人已发布的 Codex 记录，并在 Monaco IDE 中读取安全文本文件；
- 经主人批准后保存项目文件；主人可随后切回只读；
- 不能访问未共享目录或隐式访问 `.codex`。

### Relay

- 保存会话、邀请、成员、批准状态和消息；
- 保存房主明确选择后发布的可见 Codex 记录与安全文本文件目录；
- 暂存有界、短期的文件操作请求和结果，实际磁盘访问仍只发生在当前本机 Host；
- 只保存成员 bearer token 的 SHA-256 哈希；
- 通过 HTTPS/WebSocket 分发事件；
- 不持有 SSH 凭据、Codex 账户凭据或共享范围外的主人文件。

## 4. 关键工作流

### 网页邀请

1. 主人在控制台创建会话。
2. 主人点击“创建邀请”。
3. 控制台生成 60 分钟、一次性邀请链接。
4. 协作者打开完整链接，令牌自动填入且从地址栏移除。
5. 协作者提交显示名称后进入“待批准”状态。
6. 主人在成员列表中批准。
7. 双方开始实时聊天。
8. 主人可以关闭房间以暂停新的邀请、加入和发送操作；重新开启后继续使用原会话。

### Codex 指令

1. 主人通过插件创建或加入主人会话，并绑定明确项目根目录。
2. 主人把会话绑定到一个 Codex 任务。
3. 已批准成员在网页发送的 `codex_prompt` 由本机后台 Host 按顺序自动转发。
4. Relay 的 `message.created` WebSocket 事件立即唤醒 Host；所选任务空闲时通过 Desktop
   `thread-follower-start-turn` 提交，任务运行中时后续指令保持“排队中”，前一条完成后
   自动提交下一条。
5. 附件、模型、推理强度、速度、计划模式和权限通过 Desktop 本机 IPC 参数提交。
6. Host 在提交前持久化 outbox intent；Codex 接受后持久化 `turnId` receipt，再由 Relay 幂等
   确认后清除。恢复通过稳定 `clientUserMessageId`/metadata 查找唯一 turn；零个或多个匹配时
   fail-closed，不自动重复提交。因此当前保证是不自动制造重复副作用，而不是对任意外部故障
   宣称通用 end-to-end exactly-once。
   同步器不会在任务仍运行时把 Desktop 的短暂 `interrupted` 状态提前写成失败。
7. 网页停止按钮调用 `thread-follower-interrupt-turn`；整个过程不会打开、聚焦或切换
   Desktop 窗口。
8. 只有主人能远程改变审批/访问模式；Host 对所有非 owner 指令强制使用
   `workspace + on-request`，不会继承主人任务的 `never/full-access`。

当前版本不会在公网 Relay 上运行 Codex，也不会让 Relay 直接访问本机。

### Codex 记录与文件查看闭环

1. 网页房主在“Codex 与文件”生成 10 分钟、一次性配对码。
2. 房主本机插件用 `collab_pair_host` 认领配对码，并明确共享绝对项目根目录。
3. Relay 只保存配对码哈希，并为本机 Host 签发独立能力令牌；浏览器主人不会被登出。
4. 插件仅发布该根目录匹配的 Codex 任务目录。
5. 房主从网页选择任务；Relay 激活该 task 的独立历史缓存，未缓存 task 由 Host 后台回填。
   项目文件目录继续按配对 root 缓存，不因每次 task 切换而销毁。
6. 本机插件启动单例后台 worker，自动消费已批准成员排队的 Codex 指令，并按任务更新时间
   及 rollout 文件变化读取所选任务，提取用户/助手消息、可见推理摘要、命令和命令输出；
   内容未变化时不重复发布。
7. 插件生成安全文本文件目录；若房主另行传入 `codexConfigRoot`，再加入 `.codex`
   的非凭据文本配置。两条根目录权限相互独立，`.codex` 在 IDE 中始终只读。
8. 快照排除凭据、高置信密钥、二进制、符号链接和构建依赖。
9. 已批准成员可以查看导入记录和文件，并获得项目写权限；主人可随后按成员切回只读。
   待批准成员及非房主仍不能发布或选择任务，项目权限也不会隐式开放 `.codex`。

### 文件协作

1. 插件对主人选择的绝对根目录执行 `realpath`。
2. 所有请求路径必须保持在该根目录内。
3. 读取返回内容和 SHA-256。
4. 写入必须携带调用方读取时得到的预期 SHA-256。
5. 哈希变化时返回冲突，不静默覆盖。
6. 文件操作先进入 Relay 持久队列，只有当前 Host token 与 Host generation 可以认领；
   30 秒租约到期、成员撤销或写权限撤销都会在磁盘访问前失败关闭。
7. Host 在本机持久化 `intent -> executing -> result` receipt。尚未执行的 intent 必须经 Relay
   精确释放租约后才能清除；result 只重放 Relay 落账。若在 `executing` 后、result 落盘前崩溃，
   因无法证明磁盘副作用，恢复会阻断并要求人工核对，不自动再次执行。
8. Windows Host 通过原生句柄锁定并校验实际打开的版本，先将旧版本移入有界恢复区，
   再以 no-replace 语义发布候选文件；发布窗口出现并发版本时保留目标、旧版和候选版，
   绝不通过回滚覆盖并发版本。中断事务可按 journal 人工恢复。非 Windows Host 第一阶段只读。
9. `.codex-collabignore`、扩展名允许列表、私有目录、敏感文件名和高置信凭据内容在 Relay
   与 Host 两端重复检查；Windows 上忽略规则按文件系统的大小写语义执行。

## 5. 仓库结构

```text
apps/dashboard/             React + Fluent UI 控制台
apps/desktop/               Electron 主人端安全壳与 Dashboard desktop Runtime 容器
apps/relay/                 HTTP、WebSocket、SQLite Relay
packages/protocol/          共享协议类型与输入验证
plugins/codex-collab/       Codex 插件、MCP Server、协作技能
plugins/codex-collab/src/   仅保留 MCP/Host Worker 两个入口，领域实现归入子目录
plugins/codex-collab/src/host/  本机 Host Runtime、Host Service 与安全 IPC
plugins/codex-collab/src/workspace/  工作区操作、快照与 sandbox/CAS 边界
native/host-ipc/             Windows named-pipe ACL/SID/HMAC broker
.agents/plugins/            仓库内 Codex marketplace
deploy/                     VPS Compose 与 Caddy 配置
docs/reference/             项目、架构与代码组织事实
docs/operations/            部署与测试运行手册
docs/plans/                 任务与版本实施计划
docs/audits/                带日期的审计证据
scripts/architecture/       仓库结构与边界门禁
scripts/probes/             MCP、app-server 与工作区真实探针
scripts/desktop/            Desktop E2E 与发布物验证
scripts/plugin/             插件校验入口
```

## 6. 数据与凭据

- Relay SQLite：Docker `relay-data` 命名卷；
- Caddy 证书与配置：独立命名卷；
- 浏览器当前房间凭据：当前标签页的 `sessionStorage`；
- 浏览器账号会话：`HttpOnly`、`SameSite=Strict` Cookie，HTTPS 环境同时启用 `Secure`；
- Passkey 公钥、签名计数、账号会话 token 哈希与账号-房间归属保存在 Relay SQLite；
- 当前 Dashboard 没有暴露 Passkey/账号入口；这些 Relay API 为后续使用保留；
- 当前网页使用房间 ID + 主人恢复密钥恢复 owner，Relay 只保存 `owner_recovery_hash`；恢复会
  签发新的 owner member token，但目前不会自动轮换/撤销所有旧 owner token；
- “我的房间”只保存账号与成员的归属关系，重新进入时签发新的设备成员 token，不返回旧 token；
- URL 中存在一次性邀请时，邀请流程优先于当前标签页已有凭据；只有申请成功后才替换凭据；
- 本地插件成员凭据：用户目录下 `.codex-collab/state.json`；
- Relay 数据库只保存 token 哈希，不保存原始成员 token；
- WebSocket 使用 30 秒一次性实时票据，Relay 仅在内存保存票据哈希并在升级前消费；
- 本机配对码同样只保存 SHA-256 哈希，且过期或使用一次后失效；
- 邀请 token 位于 URL fragment，不会随普通 HTTP 请求发送给服务器；
- 任何密码、SSH 私钥、API Key 或成员 token 都不得提交到 Git。

## 7. 当前限制

- 已批准成员从网页发送的 Codex 指令会按顺序执行，非 owner 指令固定为
  `workspace + on-request`；
- 附件单文件限制 4 MB、单条指令总计 6 MB、最多 8 个，Relay 需鉴权后才允许下载；
- 尚未提供成员撤销、邀请撤销和细粒度根目录权限；
- 账号恢复码、Passkey 管理和完整的设备会话管理尚未提供；
- 尚未实现自动备份、全接口细粒度配额、审计导出和集中监控；
- 尚未进行正式并发压测和故障注入；
- 批准 editor 会按产品语义授予 `workspace-write`；若只需查看，主人应随后切回只读；
- `.codex` 配置仍需结构化字段白名单，不能长期只依赖内容启发式检测；
- Codex 草稿、附件、tabs、dirty Monaco state 已按 room/task 隔离；Host 断线、远端删除、
  隐藏面板和根目录释放后的完整恢复仍需桌面 E2E 最终验证；
- Dashboard Runtime、Relay task 原子校验、结构化 file activity、Host 休眠状态机、Host IPC、
  Electron 安全壳与未签名 NSIS 已通过自动验证；干净 VM、双用户 Pipe、真实 UI E2E 仍待人工验证；
- 当前本地 Electron Renderer 已使用独立 root 和桌面产品壳；`v0.1.0-beta.4` 已安装并包含分隔条、
  状态栏和托盘启动修复；安装哈希、主窗口和 Host 启动已核验，托盘关闭/恢复/退出的最后点击
  验收及完整主人旅程仍待放行；已发布的 `v0.1.0-beta.1` 不包含本轮界面；
- 指令 outbox 和文件 receipt 已自动覆盖恢复与 fail-closed 路径；真实进程强杀矩阵仍待人工验证，
  `executing` 文件窗口不会自动重试，需要主人核对；
- Realtime 断开会触发权威全量 catch-up，但显式 sequence/gap 缺口游标和精确回放尚未实现；
- 当前桌面构建仅限未签名内部 Beta，无自动更新，安装时可能出现 SmartScreen 警告；
- 当前公网使用 `sslip.io` 测试域名，正式发布建议换成自有域名；
- IDE 已支持现有文件读写、新建 UTF-8 文件/目录和同父目录重命名；尚未提供删除、跨目录
  移动、终端、调试器、扩展系统和 Git worktree 合并队列；
- 项目写入第一阶段仅支持 Windows Host；其他平台明确失败关闭并保持只读；
- Codex 记录同步可见消息、推理摘要与命令输出，不同步原始隐藏思维链；
- `.codex` 仅同步单独显式授权的非凭据文本配置，不同步认证、其他任务历史或内部数据库；
- 唯一后台 Host 会在 MCP 或桌面端 connect-first 流程中启动；登录自启默认关闭，Windows 重启后
  需要再次启动 Codex 或主人桌面端来恢复 Host。

## 8. 文档导航

- [README](../../README.md)：快速开始与入口
- [架构与信任模型](./architecture.md)
- [部署与运维](../operations/DEPLOYMENT.md)
- [测试手册](../operations/TESTING.md)
- [任务规划书](../plans/TASK_PLAN.md)
- [2026-07-28 全项目架构审计](../audits/ARCHITECTURE_AUDIT_2026-07-28.md)
- [主人桌面端实施计划](../plans/DESKTOP_IMPLEMENTATION_PLAN.md)
- [完整 v1 实施计划（规划，不代表已完成）](../plans/V1_IMPLEMENTATION_PLAN.md)
