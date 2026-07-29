# Codex Collab 主人桌面端实施计划

> 状态基线：2026-07-30。本文把“已实现”和“计划”分开记录；勾选项必须有代码与验证证据。

## 1. 结论

目标架构是“主人端 Windows 桌面应用 + 协作者网页 + 现有云端 Relay”。首版桌面技术选
Electron，但不从空 UI 壳开始：先把当前插件内的 Host 整理成唯一的本机权限、凭据、文件、
Codex 与同步生命周期所有者，再让 Electron 通过窄 IPC 使用它。

状态纠正：`v0.1.0-beta.1` 已完成安全桌面运行架构和可安装成品，但该已发布版本的 Vite root
仍直接指向 `apps/dashboard`。`v0.1.0-beta.2` 已在本机升级安装并进入真实视觉检查；检查发现项目
IDE/Codex 分隔条不易发现、底部状态信息挤在单一行。`v0.1.0-beta.3` 修复了这两项，但尚未安装
便发现原有托盘 PNG 损坏会使启动停在 `createTray()`：窗口关闭后仍被隐藏，托盘、Host 启动和
退出协调器却没有完成。`v0.1.0-beta.4` 已修复并安装，安装 ASAR 与候选一致；托盘对象创建后
Host 才启动的顺序已在实机成立，关闭/恢复/右键退出的最终点击验收仍待主人确认。因此任何版本
暂不能描述为“桌面专属产品界面完成版”。

这比把 Dashboard 直接套进 Electron 更稳妥。当前 Dashboard 假定页面 origin 就是 Relay、
在 renderer 保存房间凭据并直接创建 WebSocket；原样打包会把网络与主人权限带进特权页面。

### 当前批次边界

- [x] 只修改本地仓库；没有 SSH、部署、重启或修改 Primary/Guest Relay。
- [x] Guest 实例完全未触碰：未 SSH、未重启、未重建、未改数据卷或共享 Caddy，也未用作测试环境。
- [x] Dashboard 已拆出 browser/desktop Runtime；Codex 草稿、附件与 IDE tabs/dirty state 按 task 隔离。
- [x] Relay 在创建 `codex_prompt` 时原子校验 `expectedWorkspaceThreadId`，拒绝 task 切换竞态。
- [x] file activity 已采用结构化协议，并贯通 Host 导入、Relay 校验、timeline 与 IDE 展示。
- [x] Host Runtime 已实现 `active/draining/suspended/catching-up` 状态机并有 focused tests。
- [x] Electron main/preload、窄 IPC、`safeStorage`、本地安全协议、安全窗口策略与 focused tests 已落地。
- [x] Host IPC 已由单一后台 Host 接管；MCP 与 Desktop Main 共用受限 Named Pipe client，真实
  `initialize -> tools/list` 已验证 18 个工具。
- [x] Codex 指令与 workspace 文件操作已加入本机 durable outbox/receipt；恢复和 reopen 必须先
  对账 receipt，无法证明唯一结果时进入 `failed`，不自动重放副作用。
- [x] 未签名 NSIS、unpacked build、SHA-256、SBOM 与 build/protocol manifest 已生成并通过自动检查。
- [x] `v0.1.0-beta.1` 已安装并确认 Electron 主窗口可运行；其视觉仍是复用的网页 Dashboard。
- [x] 新建桌面专属 Renderer entry 与 `DesktopWorkspaceShell`，移除网页背景、居中卡片和页面级滚动。
- [x] `v0.1.0-beta.2` 已完成本机升级安装并进入实机检查；由该检查发现的分隔条与状态栏问题
  已在 `v0.1.0-beta.3` 修复。
- [x] `v0.1.0-beta.3` 本地候选已生成独立 NSIS/unpacked、SHA-256、SBOM 和 manifest，未覆盖
  旧候选；未安装即由后续实机问题检查取代。
- [x] `v0.1.0-beta.4` 修复损坏托盘图标，增加安装图标回退、关闭提示、单击/双击恢复和明确的
  “退出并停止 Host”菜单；候选已完成静态验证并在本机升级安装，ASAR 哈希一致。
- [x] 当前源码已修复协作者 Codex 时间线末帧被 750ms 限流丢弃、线程已空闲但旧 turn 仍保持
  `inProgress`，以及 Realtime 重连/终态缺少消息状态对账的问题；全仓 601 项测试和本地临时
  Relay/SQLite workspace-flow 已通过。
- [x] 当前源码已把相邻的执行过程、最终回复和结构化文件变更收拢为一个完成任务单元：成功任务
  默认只收起过程、始终显示最终总结和耗时，文件汇总默认展示前三项并可继续展开；不会跨越中间
  时间线项目合并。focused tests 与全仓 604 项测试已通过。
- [ ] 上述实时反馈修复尚未重新安装桌面候选，也未部署 Primary/Guest；本批继续保持服务器不变。
- [ ] 在已安装 `v0.1.0-beta.4` 上手工点击关闭、托盘恢复和托盘退出，完成最后的 Windows Shell 验收。
- [ ] 在桌面产品壳完成并通过真实安装验收前，不再宣称“整个桌面端已经完成”。
- [ ] 打包后 Electron 的完整交互旅程、两个真实浏览器 context 和干净 Windows 11 x64 VM
  安装/升级/卸载仍是人工放行项。
- [x] 当前只按未签名内部 Beta 管理；没有自动更新，并已明确安装时可能出现 SmartScreen 警告。

## 2. 为什么首版选择 Electron

| 方案 | 与当前代码复用 | 新工具链 | 主要代价 | 当前决定 |
| --- | --- | --- | --- | --- |
| Electron | 直接复用 React、Fluent UI、Monaco、TypeScript/Node | Electron 打包与签名 | 安装体积和内存较大 | 首版采用 |
| Tauri | 可复用前端 | 新增 Rust、sidecar 与桥接 | Host 仍是 TS，边界会同时重写 | 产品稳定后再评估 |
| C#/.NET | Windows 系统集成强 | 当前机器没有 .NET SDK，需重写 Host | 首期改动最大 | 不作为首版 |

Electron 只是桌面窗口和系统集成层，不是安全边界。主人 Host 必须能独立测试，最终也应能独立
运行；未来替换 UI 容器时不重写文件沙箱、Codex 控制和同步规则。

## 3. 目标架构与信任边界

```text
协作者浏览器 ── HTTPS/WSS ── 现有 Relay ── WSS/HTTPS ── Host Service
                                                          │
主人桌面 Renderer ── 受限 preload IPC ── Electron Main ───┤
                                                          ├─ Codex Desktop/app-server
                                                          └─ 明确授权的本机根目录
```

责任划分：

- **Renderer**：只负责 Fluent UI、Monaco、可见状态和用户意图；不持有 Host token，不直接访问
  任意 URL、任意文件或系统命令。
- **Preload**：只暴露带版本的窄接口，例如房间控制、状态订阅、经过授权的文件操作和外链打开；
  不暴露通用 JSON-RPC、Node API 或任意 IPC channel。
- **Electron Main**：窗口、导航、单实例、系统托盘、通知与 IPC 调度；不把远程网页加载到特权窗口。
- **Host Service**：唯一持有主人 Host 凭据，唯一启动 Codex 客户端，唯一消费指令/文件队列，唯一
  访问授权根目录，并执行预期 SHA-256、路径穿越、符号链接和私有目录策略。
- **Relay**：继续保存房间与协作状态、token 哈希和有界队列；不获得本机文件或 Codex 凭据。

### 必须保持的产品边界

- 批准成员按产品语义获得项目 `workspace-write`；主人仍可切回只读或撤销。
- 所有非 owner 指令在最终 Host 边界固定使用 `workspace + on-request`。
- `.codex` 必须是第二个明确根目录，不能由项目授权隐式获得。
- 多个 Codex Writer 必须使用独立 worktree；不得让两个代理并发写同一 checkout。
- 桌面 UI 不能把成员聊天、Codex task 时间线和共享 workspace 混为同一来源。

## 4. 桌面运行与凭据设计

### 本机 IPC

Host Service 的第二阶段 IPC 使用当前 Windows 用户可访问的 named pipe，并满足：

- 当前用户 DACL、协议版本握手、单实例锁和明确的客户端能力；
- 方法白名单、结构校验、认证前 8 KiB、认证后 16 MiB 帧上限与超时；
- 文件请求只能携带 root-scoped 相对路径和写入时的 `expectedSha256`；
- 禁止任意 URL、Header、命令、绝对文件路径和通用 RPC 透传；
- Renderer 崩溃或窗口关闭不破坏正在提交的原子写入。

TypeScript 与 Rust broker 已共享上述协议常量。broker 使用当前用户 SID + SYSTEM DACL、
`PIPE_REJECT_REMOTE_CLIENTS`、客户端 SID 复核、每次启动 capability 与双 nonce HMAC；TypeScript
client 执行 connect-first、endpoint 校验和 readiness 等待。旧 worker 持锁但没有 IPC endpoint 时
明确返回 `host_restart_required`，不会退回第二套进程内 Host。上述边界已通过 focused tests、Rust
tests 和真实 MCP probe；另一 Windows 用户的实际拒绝仍需在双用户 VM 中人工确认。

### 凭据

- Electron Main 已使用 `safeStorage` 加密持久化房间凭据；renderer 只能读取不含 token 的
  session/member snapshot，Host token 不进入 renderer 或 `sessionStorage`。
- Electron owner session 已独立写入 `safeStorage`；现有 Host profile 仍由唯一 Host Service 持有。
  将旧 profile 迁移为统一凭据存储属于后续兼容工作，不能通过复制 token 完成。
- Windows 内部 Beta 使用 Electron `safeStorage`（Windows 上由系统加密能力支持）保存 durable
  secret；不可用或密文损坏时失败关闭，并要求使用恢复密钥重新连接。
- 浏览器协作者的 token 和桌面 Host token 保持不同能力、不同生命周期、不同撤销路径。

### Packaged UI

Electron 壳、安全 custom protocol、sender 校验、导航限制和窗口安全选项已经实现并有 focused
tests；未签名 NSIS 与 unpacked build 已生成并完成静态验收，但尚未在干净 Windows VM 完整走完
交互旅程，因此以下是“代码和安装成品已落地、人工发布验收待完成”的契约：

- 使用打包内本地资源与 secure custom protocol，例如 `codex-collab://app/`；路径解码、host、遍历、
  MIME 和越界全部失败关闭。
- `nodeIntegration: false`、`contextIsolation: true`、`sandbox: true`、`webSecurity: true`，禁用 webview。
- 默认阻止窗口内导航和新窗口；允许的 `https:` 外链交给系统浏览器。
- CSP 至少限制为本地脚本、样式、字体、图片和 Monaco worker；不开放 `unsafe-eval`。
- 先抽象 Dashboard 的 transport、realtime、storage 和 public invite origin，再复用 UI；不在
  `App.tsx` 中堆 Electron 条件分支。

## 5. 房间关闭与自动恢复

Relay 业务状态继续使用 `open | closed`，Host 本机增加运行阶段，不要求先改数据库：

```text
open + active
  -> 主人关闭房间
closed + draining
  -> 当前原子文件操作/已提交的状态落账完成
closed + suspended
  -> 收到 session.updated 或主人本机重新开启
open + catching-up
  -> 目录、历史、队列、task、文件和 runtime 状态完整对账
open + active
```

`suspended` 必须停止新指令 claim、文件操作 claim、Codex 轮询、目录扫描、历史回填、快照和 runtime
发布。保留一条低成本控制连接，用来接收房间重新开启事件；如果把网络也完全断掉，就无法做到
“开启后自动同步”。控制连接断开时采用低频、带抖动的重连，不恢复重型同步。

恢复必须先 `catching-up`，不能直接消费旧队列：先对账本机 durable receipt，再确认当前 Host
generation、所选 task、权限、撤销状态、历史与 workspace 快照，然后处理待办。当前每次控制
连接断开都会执行一次权威全量 catch-up；显式 sequence/gap 游标与缺口回放仍是后续工作。关房间
不强杀主人自己的 Codex Desktop，也不丢弃历史、dirty draft 或已完成但尚未落账的结果。

桌面窗口关闭和房间关闭是两件事：窗口可最小化到托盘而 Host 按房间状态运行；“退出并停止
Host”必须是单独的显式动作。

## 6. 分阶段实施

### D0：决策与边界冻结 — 本批完成

- [x] 确定 Electron + 独立 TypeScript/Node Host + 现有 Web/Relay。
- [x] 确定 Windows 11 x64 首发、Fluent UI v9、Monaco 和现有信息架构。
- [x] 明确 Guest 冻结、计划/实现分栏和桌面/服务器独立发布。

验证：文档评审；`git diff` 中不得包含 `deploy/` 或 Guest 运维改动。

### D1：Host Runtime 可测试化 — 代码与 focused tests 已完成

- [x] worker 全局状态提取为 `HostRuntime`，保持 1 秒轮询与 realtime 行为不变。
- [x] 单例锁提取并覆盖当前、存活、陈旧和错误 owner 场景。
- [x] 覆盖一次性 realtime ticket、跨房间事件拒绝、owner 限制与幂等停止。
- [x] 将 session/member/chat 与 workspace/Codex/file 用例收敛到同一 HostApplication 边界。
- [x] MCP 不再直接导入 profile、Relay、Codex、workspace root 或 sync；架构门禁强制该规则。
- [x] Host 实现 open/closed 驱动的 drain、suspend、resume reconciliation 状态机和失败重试。
- [x] 通过安全本地 IPC 让后台 Host 成为跨进程唯一资源 owner，移除 MCP 的兼容进程内实例。
- [x] endpoint readiness、旧 worker 识别和 client 断线重连已实现。
- [x] 加入 Codex 指令 outbox 及 workspace 文件 intent/executing/result receipt；恢复时先对账，
  不确定的已执行窗口永久阻断自动重试。
- [ ] 加入长期进程健康监督、持久 Realtime sequence/gap 游标和安全 profile 迁移。

验证：插件 focused tests、typecheck、全仓门禁、真实 MCP `initialize` + `tools/list`。

### D2：独立 Host Service 与 IPC — 核心 transport 已实现并自动验证

- [x] `HostApplication` 承载配对、房间、task、指令、文件和同步用例。
- [x] TypeScript client/dispatcher/framing/auth 与 Rust named-pipe broker 已实现 8 KiB 握手帧、
  16 MiB 认证后帧、版本握手和 challenge/proof 的 focused tests。
- [x] Windows native pipe 使用当前用户 SID + SYSTEM DACL、remote client 拒绝、客户端 SID 复核
  和每次启动独立 capability。
- [x] Host Service 成为唯一 Codex/profile/sync writer；MCP 改为 client facade，MCP 退出不停止 Host。
- [x] 覆盖 HMAC/replay、认证超时、帧上限、版本/能力错误、断连、旧 worker 和并发启动拒绝。
- [x] ready probe、崩溃后重新连接和显式“退出并停止 Host”的优雅 drain 已实现。
- [ ] 登录自启保持默认关闭；安全 profile 迁移和双 Windows 用户实机拒绝仍待后续验证。

验证：两个客户端不能创建两个 Host owner；非授权进程、错误协议和任意路径失败关闭。

### D3：Runtime Adapter 与 Electron 壳 — 代码、focused tests 与安装成品已完成

- [x] 抽象 browser/desktop transport、realtime、credential storage 和 invite origin。
- [x] 新增 `apps/desktop` main/preload/build；当前 Beta 复用 Dashboard renderer，仅代表安全容器和
  Runtime 复用已完成，不代表桌面专属界面已完成。
- [x] 只允许 packaged local UI；完成 CSP、协议路径、导航、外链、single-instance、托盘和
  IPC top-frame sender 校验。
- [x] Host token 由 Main 的 `safeStorage` 持有，preload 只暴露版本化白名单 API。
- [x] Vite/Electron 独立输出、Monaco worker、ASAR 与资源布局通过 source/artifact verifier。
- [ ] 在干净 VM 真实启动打包后的 Electron，完成 Monaco 主编辑器及 worker 的交互验收。

验证：renderer 无 Node/Host token/任意网络能力；非法协议路径和非 app frame IPC 全部被拒绝。

### D3.5：桌面专属产品壳 — A-C 源码已实现，实机放行进行中

这一阶段是一次“保留业务能力与状态模型，替换页面壳和桌面信息架构”的重构，不是换颜色或给
现有网页增加 Electron 条件样式。

#### 源码与构建边界

- [x] 新建 `apps/desktop/renderer/main.tsx` 和 `DesktopWorkspaceShell`；Desktop Vite root 指向
  桌面 renderer，不再直接以 `apps/dashboard` 为 root。
- [x] Browser 继续使用 `DashboardView`；Desktop 只复用 `DashboardRuntimeV1`、业务 controller、
  view-model、feature components、Monaco model registry 和纯状态 reducer。
- [x] 禁止 Desktop entry 导入 Dashboard 整页 `App`、`DashboardView` 或
  `DashboardWorkspaceView`；通过 architecture guard 固化该边界。
- [x] 不复制 session、member、task、workspace、credential 或 realtime 状态机；同一行为只有一个
  业务实现，Browser/Desktop 只在页面壳、导航和系统能力入口上分叉。
- [x] Desktop Renderer 继续禁止直接 `fetch`、WebSocket、bearer token、Node API、任意 IPC 和
  任意本机路径；页面壳分离不得放宽现有 preload/Main/Host 安全边界。

#### 桌面信息架构

默认大窗口布局固定为：

```text
Windows system title bar
App command bar: workspace / selected task / command palette / room and Host status
┌────────┬──────────────┬────────────────────────────┬─────────────────────┐
│Activity│ Explorer or  │ Monaco editor              │ Selected Codex task │
│rail    │ collaboration│ tabs / diff / file state   │ timeline / composer │
│        │ sidebar      │                            │                     │
└────────┴──────────────┴────────────────────────────┴─────────────────────┘
Status bar: root / task / room / Relay / Host / sync / dirty and permission state
```

- [x] 窗口内容铺满可用 client area；移除网格网页背景、居中圆角外壳、外层阴影、最大宽度容器和
  document 级纵向滚动。每个 pane 只滚动自己的内容。
- [x] 保留 Windows 系统标题栏作为首版窗口控制，不仿造最小化/最大化/关闭按钮；其下使用紧凑
  App command bar，不再把聊天、目录、切工作区、邀请和状态全部挤成网页导航按钮。
- [x] 左侧使用窄 Activity rail 切换 Explorer、成员协作、活动/通知和设置；切换侧栏不能卸载
  Monaco、丢失编辑器 view state 或改变所选 task。
- [x] Explorer 是 workspace 区域的常驻默认侧栏；中间 Monaco 是主工作区；右侧始终只显示当前
  Codex task 的 timeline/composer。成员聊天不能混入 Codex timeline。
- [ ] 底部状态栏显示真实 room、Relay、Host、catch-up、权限、root、task、dirty/conflict 状态；
  颜色只承担语义，所有状态同时有文字或图标。
- [x] 创建/恢复房间、配对、邀请、成员权限和危险操作使用聚焦 dialog 或 drawer；日常浏览文件、
  编辑、查看 task 和发送指令不经过 setup dialog。
- [x] Desktop 不复用网页的 tablet/mobile 页面导航。窄窗口采用确定性的 pane collapse/drawer，
  Browser 继续保留自己的响应式布局。

#### 视觉与交互契约

- [x] 固定 `DESIGN_VARIANCE: 3`、`MOTION_INTENSITY: 2`、`VISUAL_DENSITY: 9`；继续使用 Fluent UI
  React v9、Fluent tokens 和 `@fluentui/react-icons`，不加入第二套组件或图标系统。
- [x] 使用中性工具表面、1 px 分隔和紧凑行高；禁止把每个区域包成卡片，禁止装饰性网格、渐变、
  glass、营销页 Hero、悬浮头像和无语义状态点。
- [x] 主操作区使用真实 splitter；Explorer、Editor、Task timeline 有可用最小宽度、键盘调整、
  双击复位及 per-device 持久化，拖动时不触发大范围 React rerender。
- [ ] hover/focus/active 只做 120-160 ms 的状态反馈，不移动布局、不重建 Monaco、不产生全屏闪烁；
  `prefers-reduced-motion` 下关闭非必要动效。
- [ ] Light/Dark 使用同一语义 token 层并通过 WCAG AA；焦点、只读、dirty、saving、saved、stale、
  conflict、offline、catching-up、failed 状态在两种主题下都可区分。
- [ ] 所有 icon-only 控件、tree、tabs、disclosure、dialog、drawer、splitter 和 command palette 可用
  键盘操作并恢复焦点；dense desktop touch target 不小于 32x32 CSS px。

#### 实施切片

- [x] **D3.5-A Entry split**：建立 Desktop renderer entry、独立 root 与 architecture guard；页面先
  显示无业务丢失的 full-bleed shell，Browser 输出必须保持不变。
- [x] **D3.5-B Workbench frame**：实现 system title bar 下的 command bar、Activity rail、三主 pane、
  status bar、splitter 和 layout persistence。
- [x] **D3.5-C Feature migration**：按 Explorer/Editor、Codex timeline、Collaboration、room/member
  dialogs 顺序迁移，复用 controller/view-model，不复制网络或凭据逻辑。
- [x] **D3.5-C Timeline completion**：成功任务按“已处理 + 耗时 / 最终总结 / 文件变更汇总”显示，
  处理步骤默认折叠，整行 disclosure 可恢复全过程，手动选择不被实时更新重置。
- [ ] **D3.5-D Desktop journeys**：补齐 desktop onboarding、恢复房间、Host restart-required、tray、
  notification、offline/catching-up 和退出确认。
- [ ] **D3.5-E Release proof**：完成 component tests、键盘测试、视觉几何检查、打包 Electron 实机
  旅程和 Browser 回归，重新生成下一版 Beta；`v0.1.0-beta.1` 保留为 runtime baseline。

#### 完成定义

- [x] 源码检查证明 Desktop Vite 不再以 Dashboard 为 root，Desktop entry 不导入 Dashboard 整页。
- [ ] 1366x768、1920x1080、125% Windows 缩放下，工作台贴合窗口边缘、body 无滚动条，Composer、
  Monaco、Explorer 和 task timeline 同时可用且不重叠。
- [ ] 截图对比中不再出现网页网格背景、居中圆角大卡片和网页顶部导航；用户无需看标题栏即可把
  Browser Dashboard 与主人 Desktop 区分开。
- [ ] 真实走完：启动/恢复 -> 选择 workspace/task -> 查看 live file activity -> 跳转范围 -> diff ->
  编辑保存 -> stale conflict -> 邀请/批准成员 -> 关闭房间休眠 -> 重开追平 -> tray 恢复。
- [ ] Task A/B 的 tabs、draft、attachment、Monaco undo、selection、scroll、dirty 和 pane size 不串线；
  隐藏侧栏、切换 Activity rail 和最小化窗口不丢状态。
- [ ] Browser Dashboard 的邀请、协作、移动布局和权限行为保持回归通过；桌面重构不修改 Guest、
  Caddy 或服务器部署。

### D4：主人桌面完整旅程 — 底层功能已接线，需迁移到 D3.5 产品壳并实机验证

- [x] 创建/恢复、配对码、邀请、批准/权限、房间开关、task 选择、聊天、Host 状态与安全通知
  已通过类型化 Desktop Runtime 接线。
- [x] Codex 草稿、附件、tabs、dirty Monaco model 和 IDE view state 按 room/task 保存与恢复。
- [x] 结构化 file activity 已覆盖 operation、actor、kind、lifecycle、增删行、范围和可选 diff，
  并驱动 timeline/IDE 展示与文件跳转。
- [x] `expectedWorkspaceThreadId` 从 Dashboard 进入 Relay，并在消息落库前与当前 task 原子比较。
- [ ] 在真实 Electron 中完成 inline diff、冲突和 stale/deleted/offline 的完整恢复旅程。
- [x] 现有 Dashboard 已提供 pane 调整和状态持久化的底层组件。
- [x] 将这些组件迁入 DesktopWorkspaceShell，并按桌面信息架构重新组合；不能把复用网页整页作为
  此项完成证据。

验证：真实走完“选 task -> 实时修改 -> 打开文件/范围 -> diff -> 保存 -> stale hash 冲突”。

### D5：关闭即休眠、开启即追平 — 状态机已实现，最终旅程待验证

- [x] Host 监听房间状态并实现 `active/draining/suspended/catching-up` reducer。
- [x] closed 状态等待当前工作、执行取消边界并停止重型周期，只保留控制通道。
- [x] reopen 先调用显式 reconciliation hook，成功后才回到 active；失败进入 failed 并可重试。
- [x] resume reconciliation 不领取文件操作、不转发新提示；完成状态/历史/快照对账后才允许新工作。
- [x] catch-up 先对账 Codex outbox 与文件 receipt；文件 pre-execution intent 会精确释放 Relay
  租约，result 只重放落账，`executing` 崩溃窗口因无法证明磁盘副作用而 fail-closed。
- [x] focused tests 覆盖关闭时 drain、catch-up 中再次关闭、取消超时、resume 失败和重复状态事件。
- [x] 控制连接每次断开后先执行权威全量 reconciliation，再恢复 heavy work。
- [ ] 显式 sequence/gap 缺口回放、30 分钟休眠观测和真实 Relay/Host UI 旅程待最终验证。

验证：关房间后观察不到 claim、Codex poll、scan、history/snapshot publish；重开后自动追平且不重放
已完成副作用。

### D6：安装、升级与发布 — 内部 Beta 成品已生成，人工发布门禁待完成

- [x] 固定 Electron `43.2.0`、electron-builder `26.15.3`，生成 per-user、非 one-click Windows
  11 x64 NSIS 与 unpacked build。
- [x] 输出 SHA-256、SBOM、commit/protocol/build manifest，并扫描 ASAR/资源中的凭据、SQLite、
  `.env` 和 Guest 配置。
- [x] 桌面发布与 Relay 发布解耦；构建、测试和安装包生成不部署或重启服务器。
- [x] 本批明确不签名、不自动更新；代码签名与自动更新属于公开发行阶段，不计为内部 Beta 缺口。
- [ ] 干净 VM 的普通用户安装、N-1 -> N 升级、托盘恢复、卸载保留数据和显式清除会话待人工验证。
- [x] 桌面专属产品壳已生成并安装 `v0.1.0-beta.2`，真实检查发现的分隔条可发现性和状态栏
  碰撞问题已修复并进入后续候选。
- [x] `v0.1.0-beta.4` 已生成并安装；安装内容哈希、主窗口、Host 启动与托盘创建顺序已核验。
- [ ] 在 `v0.1.0-beta.4` 复验鼠标/键盘调整、双击复位、尺寸持久化、状态栏窄宽度，以及关闭、
  托盘恢复、右键“退出并停止 Host”，并继续主人完整旅程的人工放行。

当前发布边界是未签名内部 Beta：不提供自动更新，不宣称通过 SmartScreen；测试者安装时必须
看到“可能出现 Windows SmartScreen 警告”的提示。签名、自动更新和公开分发属于后续发布门槛。

验证：干净 Windows VM 安装/升级/卸载；升级失败回到可启动版本且用户配置、凭据引用和草稿不丢。

## 7. UI 定制基线

桌面端是高密度开发工具，不改成通用卡片式后台：

- `DESIGN_VARIANCE: 3`、`MOTION_INTENSITY: 2`、`VISUAL_DENSITY: 9`；
- 继续使用 Fluent UI React v9 和 `@fluentui/react-icons`，不引入第二套组件/图标系统；
- 左侧常驻项目树，中间 Monaco workspace，右侧所选 Codex task 时间线，成员协作保持独立；
- running 默认展开，成功默认折叠，失败/审批/冲突保持展开；手动 disclosure 不被实时更新重置；
- 成功任务折叠的是执行细节，不隐藏最终总结；最终总结与本次文件变更属于同一任务结果块，文件
  变更先显示聚合增删行和前三项，再由用户展开其余文件；
- 主 pane 使用真实 splitter，保存本机尺寸，支持鼠标、触摸、键盘与双击复位；
- 明确覆盖 loading、offline、reconnecting、read-only、dirty、saving、saved、conflict、failed、
  cancelled 和 permission denied，而不是只验证 happy path。
- 当前 `v0.1.0-beta.1` 截图中的网页网格背景、居中圆角大容器、页面外层滚动和横向网页导航均为
  待移除基线，不作为桌面设计语言保留。

## 8. 测试与发布门槛

每个最终切片都必须运行：

```powershell
npm run validate:architecture
npm run typecheck
npm test
npm run build
npm run validate:plugin
```

MCP/Host 调用边界变化还必须真实执行 JSON-RPC `initialize` 后 `tools/list`。以下专项脚本已经
落地并在最终代码上执行：

- `test:host-lifecycle`：关闭、drain、休眠、重连、追平和 durable receipt 的崩溃边界；
- `test:desktop`：协议、CSP、IPC、导航、凭据与窗口生命周期；
- `test:e2e`：主人桌面 + 两个浏览器协作者 + 本地临时 Relay；
- `package:desktop` / `verify:desktop-artifact`：未签名 NSIS、unpacked build、哈希、SBOM 与内容扫描。

D3.5 实现时还必须新增：

- `test:desktop-ui`：Desktop entry/source boundary、full-bleed shell、pane state、command/status bar、
  keyboard/focus 和 Browser/Desktop 页面壳隔离；
- 打包 Electron journey：在真实安装版本中执行主人完整旅程，不以浏览器或进程级 E2E 代替；
- 视觉几何检查：记录关键 pane 在 hover、focus、resize、theme switch 前后的 rectangle，body overflow
  或可见 layout shift 直接阻断发布；
- 截图矩阵：1366x768、1920x1080、125% DPI、Light/Dark、empty/ready/offline/conflict/catching-up；
- Browser 回归：确认 Dashboard 仍使用原页面壳，桌面重构不改变协作者 Web 体验。

自动化证据包括全仓架构检查、typecheck、测试、构建、插件验证、18 工具 MCP probe、Host 生命周期、
Desktop 安全测试、本地临时 Relay/SQLite workspace flow 和进程级 E2E。`test:e2e` 是本机进程级
闭环，不冒充真实 Electron + 两个浏览器 context 的 UI 验收。干净 VM、双 Windows 用户 Pipe
拒绝、30 分钟休眠观测、安装/升级/卸载和完整交互旅程仍须单独人工记录。

当前自动化保证是“无法证明安全时不重复执行”：Codex 接受后的恢复依赖稳定
`clientUserMessageId`/metadata 唯一匹配；零个或多个匹配都会阻断。workspace 文件在本机副作用前
持久化 `executing`，若进程在结果落盘前崩溃，恢复会永久阻断并要求人工核对，而不是猜测并重放。
因此这不是对所有崩溃点宣称通用 end-to-end exactly-once；进程强杀矩阵仍属于人工放行证据。

安全威胁模型不承诺抵御已经控制当前 Windows 用户会话的恶意程序；Named Pipe ACL、capability
和 DPAPI/safeStorage 主要隔离远程客户端、其他用户与意外的未授权进程边界。

## 9. Guest 保护规则

- 本地开发和 E2E 只使用临时 Relay、临时 SQLite 和测试账号。
- 本批 Guest 完全未触碰。未获得一次新的明确授权前，不 SSH Guest、不重启 Guest Compose、
  不写 Guest 数据卷、不改共享 Caddy。
- 新协议必须 additive、可协商版本并兼容当前 Guest；需要破坏性迁移时先提供双读/双写窗口。
- “桌面端完成”不等于“服务器已部署”；两者必须分别验证、分别发布、分别报告。
