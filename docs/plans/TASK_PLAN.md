# Codex Collab 任务规划书

> 本文跟踪当前仓库的实际完成状态。完整产品目标与远期架构见
> [V1_IMPLEMENTATION_PLAN.md](./V1_IMPLEMENTATION_PLAN.md)，其中的规划项不自动视为已完成。
> 2026-07-28 的全项目证据、风险和验收条件见
> [ARCHITECTURE_AUDIT_2026-07-28.md](../audits/ARCHITECTURE_AUDIT_2026-07-28.md)。

## 1. 规划目标

先把 `0.1.x` 做成可稳定邀请真实测试者的 MVP，再推进生产安全、自动主人 Host 和规模化。
所有完成项都必须有代码、自动检查和真实运行证据，不能只以“接口存在”判定完成。

## 2. 当前里程碑

### M0：架构与安全边界 — 基础边界已完成，审计加固待完成

- [x] Relay、Dashboard、共享协议和插件工作区
- [x] 主人、协作者、待批准与已批准身份模型
- [x] Relay 仅保存 token 哈希
- [x] 明确绝对共享根目录
- [x] 路径穿越与符号链接逃逸防护
- [x] 带预期 SHA-256 的原子写入
- [x] Codex 审批策略保持不变
- [x] 非 owner prompt 在 Host 边界强制收紧为 workspace + on-request
- [x] 项目私有目录在协议、Relay 与 Host 使用统一 deny policy
- [x] Plugin `src` 已按 app-server/codex/host/mcp/persistence/relay/sync/workspace 领域归档，
  根目录只保留两个进程入口并由 architecture guard 强制
- [x] Dashboard、Desktop、Relay、scripts 与 docs 已按 app/domain/operations/plans 等责任边界归档，
  入口根目录由 architecture guard 白名单固定；Protocol 与 Rust 保留惯用的小型公共模块布局
- [ ] `.codex` 使用结构化字段白名单

验收：安全测试通过，未经批准成员不能发送消息或访问文件。

### M1：可邀请测试 MVP — 已完成

- [x] 一次性、可过期、限制次数邀请
- [x] 邀请链接自动填入
- [x] 主人批准 UI
- [x] WebSocket 实时成员与消息
- [x] 浅色、深色和 390px 响应式界面
- [x] 复制按钮同步降级和手动复制提示
- [x] 公网 HTTPS Relay
- [x] SQLite 与 TLS 持久卷
- [x] 公网邀请、批准、消息往返验证
- [x] GitHub 公开仓库和发布流程
- [x] 项目、部署、测试和任务规划文档

验收：陌生设备可通过公网链接申请加入；主人批准后双方可实时收发消息。

### M2：Codex 主人 Host — 部分完成

- [x] Codex 插件与 18 个 MCP 工具
- [x] 任务列表、绑定、恢复和指令转发
- [x] 身份元数据进入 Codex 指令
- [x] 本地文件沙箱工具
- [x] 网页与本机插件的一次性安全配对
- [x] 网页选择 Codex 任务并自动导入消息、推理摘要与命令输出
- [x] 已批准成员查看安全文本文件快照
- [x] 通过第二个显式根目录查看 `.codex` 非凭据文本配置
- [x] 单例后台 Host、WebSocket 唤醒、指数退避重连与普通重启去重
- [x] 后台 worker 状态与单例锁提取为可测试的 Host Runtime 基础
- [x] 网页 Composer 通过 app-server 后台直送、附件、执行设置和停止状态
- [x] 运行中保持 Relay 队列、逐条提交、不唤起 Desktop 与投递状态
- [x] 协作者 Codex 输出使用前沿加尾随的实时历史刷新；终态与 Realtime 重连执行消息状态对账，
  线程整体空闲时可收敛 app-server 遗留的 `inProgress` 状态
- [x] Relay 重启或瞬时追平失败后 Host 会先发布 `unavailable` 再自动重试；无需等待第二个
  `open` 事件，durable receipt 歧义仍保持 fail-closed；网页运行态事件不会取消待执行的 history 刷新
- [x] 桌面安全通知；非 owner 指令继续按 `workspace + on-request` 转发并保留 Codex 审批
- [x] Codex durable outbox/receipt 与文件 intent/executing/result journal；恢复歧义时 fail-closed
- [ ] 登录/重启自动拉起、长期健康监督、安全 profile 迁移与持久 Realtime sequence/gap 游标

验收：主人不需要手动轮询；非 owner 指令在 Host 边界强制使用 workspace + on-request；
在 Codex 接受前后强杀 Host 都不会重复执行同一指令。

### M2.6：主人桌面应用 — Runtime Beta 已安装，桌面专属产品界面迭代中

- [x] 确定 Electron UI + 独立 TypeScript/Node Host + 现有协作者 Web/Relay
- [x] 明确信任边界、凭据归属、Guest 冻结规则与阶段验收条件
- [x] Host Runtime/单例锁第一切片与 focused regression tests
- [x] 18 个工具进入分域 HostApplication，MCP 变为受架构门禁保护的协议 facade
- [x] Host Runtime 只依赖 Application，并在停止时等待当前后台周期
- [x] Dashboard browser/desktop Runtime 与 task-scoped Codex 草稿、附件、IDE tabs/dirty state
- [x] Relay 使用 `expectedWorkspaceThreadId` 在消息落库前原子拒绝 task 切换竞态
- [x] 结构化 file activity 贯通协议、Host 导入、Relay 校验、timeline 和 IDE
- [x] 成功任务默认折叠执行步骤，并在同一结果块持续显示耗时、最终总结和紧凑文件变更汇总
- [x] Host `active/draining/suspended/catching-up` 状态机及 focused tests
- [x] Electron main/preload、白名单 IPC、`safeStorage`、安全 custom protocol 与安全窗口策略
- [x] Host IPC 的跨进程唯一 owner、Windows pipe ACL/SID、HMAC/replay、帧限制、ready probe、
  断线重连和 graceful stop
- [x] Relay/Host 的指令幂等落账、文件 durable receipt、未执行租约释放及 catch-up 前全局恢复门禁
- [x] `v0.1.0-beta.1` 已生成、发布、安装并启动；该已发布基线仍复用网页 Dashboard
- [x] 当前源码已将 Desktop Vite root 与 Dashboard 分离，并新增 `DesktopWorkspaceShell` 和独立 entry
- [x] 当前源码已实现 full-bleed command bar、Activity rail、Explorer/Monaco/Task 三主 pane 和 status bar
- [x] 当前源码已移除桌面页的网页网格背景、居中圆角外壳、页面级滚动和横向网页导航
- [x] 当前源码已复用业务 `DashboardController`、feature 和 view-model，未复制网络、凭据或状态机
- [x] `v0.1.0-beta.2` 已完成本机升级安装并开始真实桌面视觉检查
- [x] 项目 IDE/Codex 分隔条已扩大为明确的 12px 命中区，增加拖拽柄、键盘调整、双击复位
  和尺寸持久化回归约束
- [x] Explorer-only 状态已允许项目目录在 `260px` 至可用上限之间双向缩放；Monaco 展开后自动
  恢复 `520px` 安全下限
- [x] 底部状态栏已按连接、上下文、权限/同步三组布局；窄宽度优先收起上下文，避免状态重叠
- [x] `v0.1.0-beta.3` 本地候选已生成独立 NSIS/unpacked、SHA-256、SBOM 和 manifest，旧候选未覆盖
- [x] 修复损坏托盘 PNG 导致启动停在 `createTray()` 的缺陷；加入安装图标回退、后台提示、
  单击/双击恢复、“打开主人工作台”和“退出并停止 Host”菜单，以及 PNG 解码回归测试
- [x] `v0.1.0-beta.4` 已生成并安装；安装 ASAR 与候选哈希一致，主窗口和 Host 启动已核验
- [x] `v0.1.0-beta.5` 已加入 Explorer-only 双向缩放修复并完成本机安装
- [x] `v0.1.0-beta.6` 已修复最终回复后仍显示全局运行转圈、陈旧消息快照覆盖终态，以及
  Desktop/MCP 分离 Host 状态目录导致双 Writer；本机安装后 lock/endpoint 已收敛到唯一 Host PID
- [x] 已修复任务被停止但缺少 `task_complete` 时旧命令逐行永久转圈：非活动任务未决步骤显示
  “已停止”，活动任务只保留最后一个真实活动步骤的 Spinner；最终 Beta 6 已覆盖安装并通过
  可访问性树实机核验，旧运行文案也已随状态收敛
- [x] `v0.1.0-beta.11` 已把活动时间线改为 Codex 式“正文 + 命令”：每两段处理说明之间相邻的
  历史命令收进一个“运行了多个命令”折叠项，正文顺序不变；只有当前命令展开，失败命令
  也在其原文字区间默认折叠并标记失败数量；长命令启动和轮询保持原始命令，明确完成输出或退出码
  到达后立即折叠
- [x] Beta 11 已按 `48f710e` 覆盖安装并通过 Renderer DOM 探针：正文、命令组、下一正文、
  下一命令组严格保持时间顺序；所有历史命令默认折叠，两个失败命令也未展开。安装 ASAR 与候选
  SHA-256 一致。全仓 625 项测试通过
- [x] Beta 12 已按 `6f246e6` 覆盖安装并实点“已处理”：终态历史展开后继续使用正文与分段折叠
  命令组，不再显示逐命令列表，也不显示“Codex 正在继续处理”；实测 2 个命令组、0 条裸命令
- [x] Beta 13 已新增白底深靛蓝多尺寸 Windows 图标，窗口、托盘、快捷方式、NSIS 和卸载项
  使用同一图标源；不再保留旧的损坏 PNG 或独立托盘图标数据
- [x] Beta 13 已把协作/活动、项目文件和 Codex 任务改成可任意换位的稳定面板；支持专用拖动柄、
  左右按钮、键盘调宽、双击复位和 task-scoped 持久化，换位不卸载 Monaco
- [x] Beta 13 已按 `7da252a` 生成 NSIS/unpacked、SBOM、manifest 和 SHA-256，并覆盖安装；
  安装 ASAR 与候选一致，桌面/开始菜单快捷方式指向新 EXE 图标，重启后为单一主人进程/Host broker
- [x] Beta 14 已按 `e680d90` 生成并覆盖安装；真实房间从卡住的 832 条追平到 968 条，Primary
  实际重启后 Host 自动恢复为 `active` 并继续同步到 991 条。安装包 SHA-256 为
  `CF2957A3AD94F342142873388DC7BF54CF3414F2D9F24C57EEC50B07D91B2586`
- [ ] 补齐桌面 onboarding、Host restart-required、offline/catching-up、room/member dialogs
- [ ] 在 `v0.1.0-beta.14` 手工确认面板拖放、Monaco 状态保留、关闭、托盘恢复和托盘退出，
  并完成 Electron/Monaco 主人完整协作/IDE 旅程
- [x] 未签名 per-user NSIS、unpacked build、SHA-256、SBOM、manifest 和 ASAR/资源凭据扫描
- [x] 全仓五项门禁、18 工具 MCP probe、Host/Desktop 专项和本地临时 Relay/SQLite 进程级 E2E
- [x] 2026-07-31 将提交 `6904723` 部署到 Primary Relay；部署前创建一致性卷备份，公网验证入口资产、
  邀请/批准即写、Realtime `submitted -> history -> completed` 和刷新后终态；Guest 与 Caddy 容器未变化
- [x] 2026-07-31 曾部署跨正文合并的 `dbca79b`，经需求澄清后立即由 `c11976e` 替换；修正版按
  文字区间各自折叠命令并保持正文顺序，线上 5 个入口资产、安全响应头和完整 Realtime/终态
  持久化闭环通过，Guest 与 Caddy 容器及 Guest 首页哈希保持不变
- [x] 2026-07-31 将 `99d89e3` 部署到 Primary Relay：运行中仅保留一个当前步骤，既往步骤统一收进
  一个可展开的历史批次；终态实时刷新加入延迟追平和单次尾随重取，手动停止后仍同步 Codex 最终
  总结并收敛完成状态。全仓 639 项测试和五项门禁通过；公网邀请、批准即写、Realtime history 与
  completed 持久化闭环通过，Guest 与 Caddy 容器未变化
- [x] 2026-07-31 将 `e680d90` 部署到 Primary Relay：修复 Host 瞬时 catch-up 失败后永久停摆和网页
  history 刷新定时器被运行态取消。切换前备份 Primary 数据；公网资产哈希一致，Host 在真实 Relay
  重启后从 968 条继续同步到 991 条；Guest 与 Caddy 容器未变化
- [ ] 干净 Windows VM、双用户 Pipe、N-1 -> N 升级/卸载和真实双浏览器 UI E2E

详细实施顺序、当前/计划边界见
[DESKTOP_IMPLEMENTATION_PLAN.md](./DESKTOP_IMPLEMENTATION_PLAN.md)。

验收：Renderer 不持有 Host token 或任意本机能力；关闭房间后只保留低成本控制连接，重开后
自动追平且不重复副作用；主人 Desktop 必须使用独立页面壳，不能继续把 Dashboard 整页打包后
宣称桌面 UI 完成；Browser Dashboard 保持原体验。桌面发布不要求修改或重启 Guest。当前只允许
未签名内部 Beta，无自动更新并明确提示可能出现 SmartScreen；本批 Guest 完全未触碰。

### M2.5：网页 IDE 第一阶段 — 基础能力与 task-scoped 状态已完成

- [x] 全屏 Monaco 编辑器、可搜索嵌套文件树和多标签页
- [x] 未保存标记、`Ctrl+S`、保存状态与显式冲突 Diff
- [x] 主人批准成员时授予项目写权限，并可随后按成员切回只读
- [x] `.codex` 使用第二个显式根目录且始终只读
- [x] Relay 持久文件操作队列、当前 Host generation、短租约与写盘前权限复核
- [x] SHA-256 乐观锁和 Windows 原生句柄保护、恢复区、no-replace 发布
- [x] 忽略规则、敏感内容、容量、速率、结果保留和实时事件隐私边界
- [x] Codex 指令按所选任务归属，旧的无归属记录不再冒充当前任务消息
- [x] 新建安全 UTF-8 文件、目录和同父目录重命名
- [x] Codex 草稿、附件、tabs、dirty draft 与 Monaco state 按 room/task 隔离
- [x] Host 断线/隐藏面板/切 task 时保留 dirty draft，并处理 stale/deleted remotely
- [x] Explorer/tabs 键盘模型、range 跳转和受权限保护的 inline diff preview 已实现并自动测试
- [ ] 在打包后的 Electron 中完成人工键盘、Monaco undo/view state 和 stale/conflict 旅程

验收：获批成员能打开、保存、新建、重命名安全文本文件；被切回只读后不能保存；并发版本进入
Diff，不静默覆盖。非 Windows Host 写入失败关闭，`.codex` 不能写；切 task、断线和隐藏面板
不泄漏或丢失未保存内容。

### M3：生产安全与运维 — 待完成

- [x] 房主关闭和重新开启房间
- [x] 部分敏感接口的单进程 IP 速率限制
- [ ] 邀请撤销和成员撤销
- [ ] 主人 token 轮换及旧 token 撤销
- [ ] 会话、身份、房间、累计字节和多副本共享维度速率/配额限制
- [ ] 默认关闭 legacy WebSocket URL token 并移除任意 404 降级
- [ ] 自动 SQLite 备份、异地复制与恢复演练
- [ ] 结构化审计日志和导出
- [ ] 运行监控、告警与证书到期监控
- [ ] 自有域名和正式隐私/保留策略
- [ ] 依赖与镜像定期安全更新

验收：完成安全检查表、备份恢复演练和 7 天稳定性运行。

### M4：并发与协作工程化 — 待完成

- [ ] 每个活跃 Codex Writer 使用独立 Git worktree
- [ ] worktree 租约、冲突可视化与合并队列
- [ ] 离线事件历史和断线回放
- [ ] 每根目录 read/write/execute 权限
- [ ] 设备密钥签名与主人可见撤销
- [ ] 正式负载测试、容量基线与限流参数

验收：并发写入不静默覆盖；达到目标并发时延和错误率指标。

## 3. 下一批优先任务

| 优先级 | 任务 | 完成定义 |
| --- | --- | --- |
| P0 | `.codex` 配置安全 | 配置按结构化字段白名单发布，解析失败拒绝，凭据语料测试通过 |
| P0 | 桌面产品壳分离 | 独立 Desktop renderer/entry；full-bleed Fluent workbench；不导入 Dashboard 整页；真实安装截图和完整主人旅程通过 |
| P0 | Task 状态最终验证 | 真实 Electron 中验证 task/root 切换、断线、隐藏面板与 stale/deleted 恢复不泄漏或丢草稿 |
| P0 | 指令/文件强杀验证 | 自动 outbox/receipt 与 fail-closed 已完成；逐故障点进程强杀，确认无自动重复副作用并记录人工解阻流程 |
| P0 | 数据生命周期 | 房间累计配额、高水位、保留/归档策略和磁盘告警生效 |
| P0 | 自动备份 | 主/Guest 定时一致性备份、异地保留、恢复到新卷并完成真实演练 |
| P0 | CI 与浏览器闭环 | portable plugin validator、Windows 门禁、双用户 Playwright 真实旅程 |
| P0 | 桌面 Host 恢复 | 完成安全 profile 迁移、持久 Realtime 游标、健康监督与强杀/人工解阻验证 |
| P0 | 桌面人工放行 | 干净 VM、双 Windows 用户 Pipe、主人+双浏览器真实 UI E2E、升级/卸载；内部 Beta 保持未签名且无自动更新 |
| P1 | 撤销与轮换 | 可撤销成员/邀请并轮换主人 token，旧 token 立即失效 |
| P1 | Realtime 恢复 | sequence/gap 检测、重连 resync、ticket 在 upgrade 时重新验证权限 |
| P1 | Host 生命周期 | 登录/重启自动启动、健康监督、冷启动完整 workspace 对账 |
| P1 | 审计与监控 | 主人能查看安全事件、转发记录、DB/磁盘/队列/备份告警 |
| P1 | Git worktree 队列 | 多 Writer 隔离、租约和显式合并 |
| P1 | IDE 第二阶段 | 删除、跨目录移动、恢复/版本历史、终端/测试和 worktree 合并 |
| P2 | 负载测试 | 给出并发目标、容量曲线和可复现脚本 |

## 4. 每项任务的交付门槛

- 有明确用户场景和拒绝场景；
- 不放宽 AGENTS.md 中的安全不变量；
- 代码通过类型检查、测试、构建和插件验证；
- MCP 变更通过真实 `initialize` 与 `tools/list`；
- 公网相关变更通过 HTTPS 上的真实端到端流程；
- 文档与实际配置同步；
- 不把密码、成员 token 或私钥写入代码、文档、日志和提交。

## 5. 版本判定

- `0.1.x`：可邀请测试 MVP；
- `0.2.x`：常驻主人 Host、撤销、备份和限流；
- `0.3.x`：worktree 队列、审计与稳定性；
- `1.0.0`：完成安全审查、恢复演练、负载测试和正式运维基线。
