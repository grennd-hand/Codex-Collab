# Codex Collab 全项目架构审计（2026-07-28）

> 审计基线：`a97cee8`。本文记录当前代码事实、风险、推荐方案与验收条件，不表示这些
> 建议已经实现。审计只修改文档，没有部署主实例或 Guest，也没有改变生产数据。
>
> 2026-07-28 实施更新：产品 owner 已确认“批准成员”本身就表示授予项目写权限，因此原
> SEC-00 结论撤销；SEC-01（非 owner prompt 强制审批）和 SEC-02（私有目录统一拒绝）已在
> 本地实现并补回归测试。本文的其他未完成项仍是建议，没有部署。

## 1. 结论

当前最合适的形态仍是 **Dashboard + Relay 模块化单体 + SQLite 单写者 + 本地主人 Host**。
现在没有证据支持立即拆微服务，也没有证据支持仅为了“架构先进”马上迁移 PostgreSQL 或
Redis。现有信任边界、文件沙箱、乐观锁和 Windows 原生 CAS 值得保留。

下一阶段应从“功能继续叠加”切换到“边界闭环”：peer prompt 审批继承和项目私有目录策略
已先闭环；继续完成 `.codex` 脱敏、任务切换隔离、指令和文件操作崩溃幂等、数据配额与备份；再补协议协商、
浏览器 E2E、可观测性和内部组合式重构。达到明确扩容阈值后，再考虑替换数据库或拆服务。

## 2. 当前架构

```text
协作者浏览器
    │ HTTPS + 一次性 realtime ticket
    ▼
Dashboard ──────────────► Relay（Node.js 模块化单体）
                             │
                             ├─ 身份、邀请、批准、消息、任务历史
                             ├─ SQLite WAL（当前要求单进程、单写者）
                             └─ 有租约的文件操作队列
                                      │
                                      ▼
主人 Host / Codex 插件
    ├─ Codex app-server：任务、历史、运行状态
    ├─ Codex Desktop IPC：prompt/stop
    └─ 显式项目根 + 独立 `.codex` 根 + FileSandbox/CAS
```

| 区域 | 当前责任 | 评价 |
| --- | --- | --- |
| `apps/dashboard` | Fluent UI 控制台、时间线、Composer、Monaco IDE、面板布局 | 功能较完整，任务级 UI 状态和真实浏览器验证不足 |
| `apps/relay` | HTTP/WS、身份与协作状态、工作区队列、SQLite | 领域已拆分，但持久层以 14 层继承串联，单写者是假设而非运行契约 |
| `packages/protocol` | 跨端类型、验证、路径/秘密策略 | 有共享类型，但缺运行时解码、版本协商和完整 file activity 契约 |
| `plugins/codex-collab` | MCP、Codex 接入、Host 同步、文件沙箱与 CAS | 本地安全边界强，prompt/file 副作用缺崩溃级幂等闭环 |
| `deploy` | 主/Guest Compose、Caddy、发布与回滚 | 主实例基线尚可，备份恢复、Guest 对齐和不可变回滚未完成 |

## 3. 已经做对、应继续保留的部分

- Relay 不持有 Codex 账号、SSH 凭据或主人文件系统；本地 Host 是唯一磁盘与 Codex 执行边界。
- 项目根和 `.codex` 根需要分别显式授权；路径穿越、符号链接逃逸、秘密内容在多层拒绝。
- 成员 token 在 Relay 只存 SHA-256；邀请、配对和 realtime ticket 短期、一次性且只存哈希。
- 文件操作使用 Host generation、lease、执行前权限复核、expected SHA-256 和原子发布。
- Dashboard 使用官方 Monaco、Fluent UI、键盘 splitter 和 `ResizeObserver`，没有伪造编辑器。
- Relay 对历史、文件快照、文件操作与附件单请求已有有界限制；SQLite 启用 WAL、外键和
  `busy_timeout`。
- 当前按 task 持久化历史、后台回填并分页；切换 task 不再销毁根级文件目录。
- 65 个测试文件共 357 个用例覆盖大量权限、CAS、配对、同步和状态机逻辑；
  `probe-workspace-flow.mjs` 与 `probe-mcp.mjs` 已提供服务级/MCP 进程级探针。

## 4. 优先级总表

这里的 P0 表示“继续扩大真实用户或宣称生产就绪前必须闭环”，不等同于已经存在公开利用。

| ID | 优先级 | 事实与风险 | 推荐方向 |
| --- | --- | --- | --- |
| PERM-00 | 已确认 | 批准 editor 同时授予 `workspace-write` | 这是 owner 明确接受协作者的产品语义；之后仍可切回只读或撤销 |
| SEC-01 | 已修复 | peer 默认 `follow-desktop` 曾可能继承宿主任务的 `never/full-access` | Host 已按可信 sender identity 强制非 owner 使用 `workspace + on-request` |
| SEC-02 | 已修复 | `.aws/.ssh/.gnupg` 等私有目录集合曾未统一应用到直接文件操作 | 协议 policy、Host 扫描/操作与 Relay 入站现共用拒绝规则 |
| SEC-03 | P0 | `.codex` 配置仍依赖启发式 secret 正则，嵌套 token/header 可漏过 | 结构化解析后按字段白名单重建，解析失败拒绝发布 |
| UI-01 | P0 | task 切换复用 session 级 Codex 草稿/附件和 root 级 IDE UI scope | 分离 root 数据 scope 与 task UI scope，切换时保护 dirty/pending 状态 |
| CMD-01 | P0 | Codex 接受 prompt 后、落本地/Relay 状态前崩溃会重放 | Relay claim + 稳定 idempotency key + Host durable outbox/对账 |
| DATA-01 | P0 | 消息、附件和 task history 无房间总配额/保留策略 | 配额、高水位、显式归档/导出、增量清理和磁盘告警 |
| OPS-01 | P0 | 没有自动异地备份、可执行恢复流程与恢复演练 | 一致性备份到新卷恢复，定义 RPO/RTO，每月演练 |
| QA-01 | P0 | 无 CI，插件验证器依赖个人绝对路径，无浏览器 E2E | portable validator + Windows 质量门禁 + Chromium 双用户闭环 |
| NET-01 | P1 | 未认证大 JSON 在鉴权前完整缓冲；部分 workspace route 无对应限流 | 先鉴权再读 body，并增加全局字节预算和身份/房间限流 |
| AUTH-01 | P1 | legacy WebSocket 长期 token 查询参数默认开启 | 默认关闭，只允许有期限的显式迁移开关并记录使用量 |
| RT-01 | P1 | realtime 无 sequence/replay，重连后不保证 resync | envelope 加 sequence；检测 gap/ready 后全量刷新，再做有限重放 |
| FILE-01 | P1 | 本地写/rename/mkdir 成功后回执丢失可被重复执行或显示失败 | operation receipt/outbox；相同 operation/lease 的 complete 幂等 |
| STORE-01 | P1 | Relay persistence 用跨领域 14 层继承表达依赖 | 保留 facade，渐进组合 `DbContext + repositories + coordinators` |
| DB-01 | P1 | fresh/upgrade schema、跨房间 FK、状态机和迁移版本存在缺口 | 版本化事务迁移、复合 FK、终态 CAS、fresh/upgrade 等价测试 |
| OPS-02 | P1 | `/health` 不探 DB；WS shutdown 无 drain deadline | `/live`/`/ready`、draining、WS 1001、超时 terminate、关 DB |
| DEP-01 | P1 | Guest 容器基线较弱；运行镜像为 root 且带整棵 `node_modules` | 共享安全基线、非 root、production-only runtime dependencies |
| PROTO-01 | P1 | `PROTOCOL_VERSION` 未参与握手，跨端响应大量直接 cast | runtime decoders、major/schema/capabilities、稳定错误码 |
| UI-02 | P1 | Explorer/tabs/range navigation/diff preview 未达到 IDE 合同 | roving focus、range reveal、结构化 diff ref、mounted DOM/E2E |

## 5. 详细发现与验收条件

### 5.1 权限、路径与凭据

#### PERM-00：批准成员即授予项目写权限（已确认产品决策）

- 事实：`approveMember` 将 pending editor 更新为 approved，并同时设置
  `workspace_file_access='workspace-write'`。
- 决策：产品 owner 已明确确认该行为就是期望语义；批准动作代表 owner 接受该成员并授予
  项目写权限，不再拆成第二个授权步骤。
- 边界：owner 仍可随后把成员切回 `read-only` 或撤销；批准项目权限不会隐式授权独立的
  `.codex` 根；所有写入继续经过 lease、执行前复核、预期 SHA-256 和 Host CAS。
- 回归：`test:workspace-flow` 应断言 approve 响应为 `workspace-write`，再验证保存与 stale-hash
  冲突闭环；不再预期批准后写入返回 403。

#### SEC-01：peer prompt 审批必须在 Host 边界强制收紧

- 证据：`plugins/codex-collab/src/codex-command-sync.ts:65-87` 将消息选项交给 Codex；
  `plugins/codex-collab/src/app-server/prompt-submission.ts:191` 对某些模式设置 `approvalPolicy`；
  `apps/relay/src/collaboration/message-store.ts:50-70` 允许 editor 使用默认 `follow-desktop`。
- 问题：默认跟随 Desktop 时，如果主人任务当前是 `approvalPolicy=never` 或 full access，peer
  指令可能继承该能力。这与“peer 指令保留主人审批边界”的安全不变量冲突。
- 方案：Host 根据 sender identity 做最终授权。非 owner 无论 UI 传什么都强制
  `permissions=workspace`、`approvalPolicy=on-request`；owner 自己的指令才可保留显式设置。
- 验收：在宿主 `never/full-access` 下转发 editor 指令，最终 IPC/app-server 参数仍是
  workspace + on-request；owner 指令的现有行为不回退。
- 实施：`submitPeerPrompt` 传入可信 requester/owner member id，最终参数构建器在所有 access
  mode 后覆盖非 owner 权限；owner 的 follow-desktop/custom 行为保持不变。

#### SEC-02/03：统一路径策略，`.codex` 从“猜秘密”改为“只发布已知安全字段”

- 证据：`packages/protocol/src/workspace-policy.ts:68-105` 定义私有目录却未在所有 publishable
  path 判断中使用；Host 扫描与直接文件操作还有另一套跳过集合。
- 证据：`.codex` 的 JSON/TOML 等文本会经 `containsLikelySecret` 后发布；该正则不能证明
  任意嵌套 `env/header/token/cookie` 安全。
- 方案：创建唯一、可版本化的 `WorkspacePathPolicy`，在协议、Relay、Host 使用同一规则；
  project 与 codex-config 用不同 policy。`.codex` 对已知格式结构化解析、递归删除敏感字段，
  只重建允许字段；未知文件和解析失败均拒绝。
- 验收：`.aws/.ssh/.gnupg`、junction/symlink、大小写变体、嵌套 JSON/TOML token、URL
  credentials 和自定义 header 语料全部拒绝，Relay payload 不出现原秘密值。
- 实施状态：SEC-02 已完成，`.aws/.azure/.ssh/.gnupg/node_modules` 在扫描、直接读写和 Relay
  入站统一拒绝；SEC-03 的 `.codex` 结构化字段白名单仍未完成。

### 5.2 task 隔离与 IDE 状态

- `apps/dashboard/src/App.tsx:118` 的 Composer storage key 只有 session id。
- `workspace-file-cache.ts:66-72` 的 scope 只有 session/host/root；同一 scope 又被用于 IDE key、
  面板与 explorer 状态。
- `IdeEditorStage.tsx:84-90` 的 Monaco URI 只有相对路径。
- `useIdeWorkspaceState.ts` 的 tabs/dirty 内容是组件局部状态；隐藏面板、Host 离线或 root key
  改变会卸载它。刷新文件快照时也没有把已打开 tab 标记为 stale/deleted remotely。
- 提交请求没有携带 `expectedWorkspaceThreadId`，大附件准备期间切 task 可能在 Relay 当前选择下
  被归入另一个 task。

推荐两个不同的身份键，不能继续复用同一个字符串：

```text
WorkspaceDataKey = sessionId + hostGeneration + canonicalRootIdentity
TaskUiKey        = WorkspaceDataKey + selectedThreadId
```

文件内容缓存按 `WorkspaceDataKey`；Codex 草稿、附件 preparation epoch、tabs、dirty drafts、
selection、panel state 和 Monaco URI/model registry 按 `TaskUiKey`。隐藏面板或断线只进入 hidden /
stale 状态，不卸载 dirty draft。切 root/task 前有未保存内容时必须确认或停放到相应 task。

验收需用真实 Chromium 完成：task A 输入草稿并打开 dirty 文件 → 切 B → B 不出现 A 内容 →
切回 A 完整恢复；发送时 Relay 原子比较 expected task；同路径跨 room/root/task 不复用旧 undo。

### 5.3 指令与文件副作用的崩溃一致性

当前 prompt 路径是：先调用 Codex，再写 `forwardedMessageIds`，最后 PATCH Relay 状态
（`codex-command-sync.ts:65-103`）。崩溃窗口无法靠内存/JSON 数组证明 exactly-once，且默认消息
列表仅取最近 500 条（`message-store.ts:133-159`），早期 queued command 可能永久掉出窗口。

推荐把 Codex 指令升级为 Relay 的专用队列：

1. 以稳定 sequence 获取最早 queued command，而不是扫描最近聊天消息；
2. 原子 claim 为 `dispatching`，带 lease 与 command id；
3. Host 在本地 durable outbox 写入意图，再调用 Codex；
4. Codex 历史携带/可对账 `collab_command_id`；
5. 相同 claim 完成请求幂等返回已有结果，未知提交进入 reconciliation，不能直接重放。

文件操作使用同样的 receipt/outbox 原则。特别是 rename/mkdir 在“本地成功、Relay 回执丢失”后
必须收敛到 completed。验收采用故障注入：在副作用前后、local receipt 前后、Relay complete
前后强杀进程，每个 command/operation 最终只产生一次可观察副作用。

### 5.4 Relay、SQLite 与扩容边界

当前 SQLite 是同步、单进程所有者。这个选择在 MVP 阶段合理，但必须写成硬运行契约：

- 禁止两个 Relay writer 共享一个 SQLite 文件；第二个 writer 会使事务外的 host generation、
  invite uses 等检查产生竞态。
- message cursor 改为 opaque `(created_at,id)`；命令队列独立于 500 条聊天窗口。
- 消息 delivery state 使用 CAS，只允许 `queued → submitted|failed`、
  `submitted → completed|failed`，终态只能幂等重放。
- 版本化迁移在单个 `BEGIN IMMEDIATE` 中完成 schema、回填、`foreign_key_check` 和版本写入；
  fresh/upgrade 数据库必须比较 FK、索引和约束等价性。
- 给跨房间成员引用增加 `(session_id, member_id)` 复合 FK；账户会话清理不得通过
  `ON DELETE SET NULL` 把原本受会话撤销控制的 token 变成独立 token。

只有在以下任一条件成立时才迁 PostgreSQL/Redis：需要第二个 Relay 副本或多节点 HA；持续
50-100 DB writes/s 且锁等待恶化；event-loop delay 超过 100 ms；或单库/备份窗口超过既定
SLO。迁移前先做指标和负载测试，不让多个 Node 进程直接共享 SQLite 文件。

Relay store 当前以 14 层继承串起 account、collaboration、workspace 与 operation。它不是立即
故障，但会隐藏依赖。应保留 `SessionStore` facade，对内按一个共享 `DbContext/transaction`
组合 repositories；先迁 workspace/operation，不做 big-bang rewrite。

### 5.5 数据生命周期与运维

- 单消息附件总量有界，但房间累计附件、消息和 task history 无总预算；约 167 条满额 6 MB
  消息即可增长到约 1 GB。这是代码上限推算，不是负载测试结果。
- 增加 per-member/per-room 日配额、附件累计字节、数据库 high-watermark、明确保留/归档策略；
  审计历史不能静默删除，应先支持导出。大对象达到阈值后迁内容寻址 blob/object storage，
  SQLite 留元数据。
- 备份脚本必须显式选择 `primary|guest`，使用 SQLite 一致性备份或受控停机；备份包含清单、
  hash、加密和异地保留。恢复只能进新卷和临时 Compose 项目，再跑 integrity/business checks。
- `/health` 目前只返回固定 `0.1.0`。拆为 liveness 与 DB/schema/data-volume readiness，并暴露
  commit、build 和 schema revision；版本号相同不能证明主/Guest 是同一发布物。
- SIGTERM 进入 draining、ready=503、拒绝升级、向 WS 发 1001、限时 terminate，最后关 DB；
  Compose 的 grace period 必须覆盖这个上限。
- Guest Compose 要对齐主实例的 `init`、no-new-privileges、cap drop、PID/memory 和日志策略。
  runtime image 只保留生产依赖、使用非 root；发布/回滚以镜像 digest 和 release manifest 为准。

### 5.6 协议与 realtime

`PROTOCOL_VERSION` 目前只是常量，Dashboard/Plugin 对成功 JSON 多数直接类型断言。建议协议包
提供运行时 decoder，并逐步引入：

```text
ProtocolMeta { protocolMajor, schemaRevision, capabilities[], limits{}, peerVersion }
RealtimeEnvelope { eventId, sequence, sessionId, type, payload, sentAt }
Page<T> { items, nextCursor, hasMore, snapshotRevision? }
ApiError { code, message, requestId, retryable?, retryAfterMs?, details? }
```

realtime `ready` 返回 last sequence/resyncRequired；浏览器在重连或发现 gap 时先全量 refresh，
再消费增量。ticket 在 upgrade 时重新验证当前成员/账户状态，连接数按 IP、房间和 credential
限额。legacy query token 默认关闭，旧 Relay/Host 通过能力错误显式拒绝，不能对任意 404
自动降级并把长期 token 放进 URL。

File activity v2 至少要求 taskId、operationId、root-relative path、kind、lifecycle、增删行、
occurredAt；可选 range、diffRef、error、actor 和 source。新数据禁止从 assistant prose 猜文件
变更；受权限保护的短期 `diffRef` 为 Monaco DiffEditor 提供数据。

### 5.7 测试与交付门禁

当前强项是纯函数/服务测试，缺口是 mounted DOM 和双用户浏览器真实旅程。建议五层：

1. 纯函数、parser、reducer、policy；
2. mounted DOM 交互：focus、keyboard、pointer、ResizeObserver、storage reload；
3. Relay/Plugin 服务集成与故障注入；
4. MCP 子进程 `initialize → initialized → tools/list`；
5. 两个浏览器 context 的邀请、批准、task、Monaco、diff、保存、冲突闭环。

CI 的 Windows job 是权威门禁，因为 FileSandbox/CAS 的写路径是 Windows-only。先将
`validate:plugin` 从个人绝对路径改为仓库内或版本固定的可安装验证器，再运行架构、类型、
357 个现有用例、构建、plugin validator、MCP probe、workspace flow 和 audit。另设 Chromium
job。coverage 先记录现有基线再设置不得下降，高风险 auth/path/CAS/prompt 分支单独提高门槛。

### 5.8 其余已确认待办

| 区域 | 已确认事实 | 最小改进 |
| --- | --- | --- |
| Host 冷启动 | 内存 workspace digest 初始为空时可复用 Relay 旧文件，停机期间只有文件变化可能永久漏同步 | 冷启动强制完整发布一次，或由 Relay 返回 manifest digest 后比较 |
| 手动 MCP 转发 | `collab_forward_prompt` 未完整校验 message 的 task 和 queued 状态 | 手动/后台转发共用同一个 Relay claim API |
| Host 生命周期 | detached worker 不受 MCP 父进程监督，禁用插件后仍可能继续运行 | 非 detached 子进程，或显式 daemon + owner heartbeat/lease/start/stop/status |
| App-server transport | JSON-RPC pending request 无 deadline；thread list 固定 50 且不分页 | Abort/timeout/退出 reject；分页或按 selected thread 定点读取 |
| 临时附件 | 硬崩溃后 `.codex-collab/attachments-*` 只靠内存 timer，可能遗留 | 启动时不跟随 reparse point 地清理过期目录，持久化 turn→directory 清单 |
| Realtime ticket | ticket 消费时不重新查询注销/撤销后的当前身份 | ticket 绑定不可逆 credential id，upgrade 重查并在 logout 清未消费票据 |
| WebSocket | 无全局/IP/房间/credential 连接上限 | 连接与 upgrade 配额；server-push-only 收到数据帧时以 1008 关闭 |
| HTTP body | 多 MB JSON 先完整 buffer/parse，后鉴权；部分 workspace route 无同级限流 | 先验证 Authorization，再读取；流式字节预算、并发预算和身份维度限流 |
| Lease 可见状态 | 过期 file-operation lease 只在下一次 claim 时回收 | list/get/create/claim 统一 requeue，或单进程 sweeper；协议显示 retrying |
| Schema | fresh 与 upgraded `member_tokens` FK 不一致；部分跨房间引用只有 member id FK | 版本化表重建、复合 FK、fresh/upgrade schema diff 与 `foreign_key_check` |
| Static deploy | 发布只保留当前 hash 资源，旧页面之后加载 IDE chunk 可能 404 | 保留最近两版 assets 或蓝绿 drain；动态 import 失败提供一次安全 reload |
| Mobile UI | `<=760px` 隐藏唯一邀请按钮，工作区仍纵向堆叠而非单主面板 | Files/Codex/Members 确定性导航，邀请放可达菜单，恢复焦点与最后状态 |
| File activity | 新结构仍缺 timestamp/actor/range/diff/error，legacy 继续从 prose 推断 | v2 typed event + bounded authorized diff reference；legacy 明确标源 |
| Model capability | 模型列表被编译成协议静态 enum | Host 发布 capability catalog；wire model 用有界 opaque string + 安全 fallback |
| Ignore 语义 | `.codex-collabignore` 实际只支持 relative prefix，不支持 gitignore glob/negation | 明确改名/文档为 prefix list，或采用有版本、充分测试的受限 matcher |
| Dashboard 性能 | Composer 输入触发上层重渲染；timeline 派生和 Monaco options 生命周期偏宽 | 先用 1000 条历史 profile，再隔离 state owner、memoize 派生和稳定 options |
| Build artifacts | `apps/relay/public` 跟踪约 14 MiB 生成资源，UI build 会制造源码提交噪声 | 改成 CI/image 构建产物与 manifest；先测 bundle，再设 gzip budget |

## 6. 分阶段路线

### Phase 0：发布阻断项

1. SEC-03：完成 `.codex` 结构化白名单；SEC-01/02 已在本地实现，PERM-00 按已确认产品决策保留。
2. UI-01：task scope、dirty preservation、expected thread CAS。
3. CMD-01/FILE-01：command claim/outbox 与 operation receipt。
4. DATA-01/OPS-01：配额、高水位、备份恢复演练。
5. QA-01：portable validator、Windows CI、最小双用户 Playwright 闭环。

### Phase 1：运行可靠性

1. realtime sequence/resync、ticket 撤销复核、连接/body/身份限流。
2. readiness、drain shutdown、Host worker supervision、冷启动强制 workspace resync。
3. Guest 安全基线、非 root 精简镜像、release manifest/digest 回滚。
4. 版本化 SQLite migration、复合 FK、delivery 状态 CAS。

### Phase 2：可维护性和完整 IDE 合同

1. Protocol runtime decoders、capabilities、稳定 error contract、file activity v2。
2. Relay persistence 从深继承渐进改为组合；扩展 dependency/AST architecture guard。
3. Explorer/tabs/disclosure/accessibility、range navigation、inline diff 和移动单面板。
4. 将生成的 `apps/relay/public` 从源码事实改成可验证构建产物；增加 bundle budget，先测量再裁剪 Monaco。

### Phase 3：以指标触发扩容

完成可复现负载测试、SLO 与容量曲线后，再决定 Postgres、Redis、object storage、CDN 或多 Relay。
Git worktree reservation/merge queue 属于多 writer 产品能力，不能用“多个 agent 写同一 checkout”替代。

## 7. 当前不建议采用的方案

- 不建议现在拆微服务；会放大分布式一致性与运维成本，不能解决当前权限和崩溃窗口。
- 不建议仅为状态管理库而引入全局 store；先定义 `WorkspaceDataKey/TaskUiKey` 和状态所有权。
- 不建议直接按 audit 自动建议降级 Monaco；当前 transitive DOMPurify 有 1 moderate、1 low，
  应验证安全 override 或上游升级，并回归编辑、Diff、折叠与主题。
- 不建议通过提高行数上限绕过结构问题，也不建议一次性重写 Relay store。
- 不建议把 secrets 正则当作 `.codex` 安全证明；allowlist 才是正确边界。

## 8. 审计验证边界

- 已进行静态代码、测试、部署配置与文档交叉审阅；多名审计代理分别负责独立区域。
- 本次实施后的架构门禁、全仓 typecheck、65 个测试文件/357 个用例、build 和 plugin
  validator 均通过；`test:workspace-flow` 通过并断言批准即授予写权限。
- MCP 真实完成 `initialize` 和 `tools/list`，协议版本 `2025-06-18`，返回 18 个工具。
- `npm audit --audit-level=high` 退出码为 0；Monaco 传递依赖 DOMPurify 仍报告 1 low、
  1 moderate，自动修复要求 breaking downgrade，未在本批强制改动。
- 本机没有 Docker/Caddy CLI，因此没有构建镜像、展开 Compose、验证容器 UID 或执行恢复演练。
- 文档审计只读核对了主/Guest 首页、`/health` 和静态资产差异；没有重跑邀请、批准、Host、
  保存/冲突等线上业务旅程，也没有容器/卷访问。相同 `0.1.0` 不能作为发布同一性证明。
- 风险中的“可能泄漏/可能重复”在没有故障注入或浏览器复现时明确视为代码路径推断；对应验收条件
  已列出，不能把文档审计当成修复完成。
