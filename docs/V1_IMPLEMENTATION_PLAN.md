# Codex Collab v1 实施计划

> 状态：产品与架构规划输入，不代表当前仓库已经实现或采用其中全部技术方案。
>
> 当前可运行 MVP 的真实状态以 [PROJECT.md](./PROJECT.md) 和
> [TASK_PLAN.md](./TASK_PLAN.md) 为准。本计划描述从最小闭环继续演进到完整 v1 的目标。
>
> 附件中的原始项目路径 `E:\测试玩耍\codex-collab` 已失效；当前仓库位于
> `E:\Codex-Collab`。

## 目标与已确定决策

开发一个“插件入口＋本地主机代理＋公网协作页面”的系统：

- 产品名称：`Codex Collab`
- 使用范围：2～5 人可信小团队
- 被邀请人控制邀请人电脑上的 Codex，使用邀请人的额度、配置和工具
- 公网邀请链接，无需双方安装 VPN
- 浏览器设备密钥＋邀请人手动批准
- 邀请人手动选择共享项目；选中后开放项目内全部文件
- 高风险操作需要邀请人审批
- Git 项目最多两个 Codex Worktree 并行
- 非 Git 项目只允许一个 Codex 串行工作
- 主机离线时可查看端到端加密的历史，不能读取或修改实时文件

## 总体架构

```text
Codex 插件
    │ MCP + SessionStart Hook
    ▼
Windows Host Agent
    ├─ Codex App Server（邀请人的身份）
    ├─ 文件与配置控制
    ├─ Git Worktree 调度
    ├─ 本地历史与密钥
    └─ WSS 主动连接
             │
             ▼
公网 Relay + 加密事件存储
             │
             ▼
React PWA
    ├─ 邀请人控制台
    └─ 被邀请人协作页面
```

规划技术栈：

- Windows Host Agent：C#、.NET 10、自包含单文件程序
- 本地数据：SQLite＋Windows DPAPI
- Relay：ASP.NET Core 10、SignalR、PostgreSQL
- Web：React、TypeScript、Vite、PWA
- 部署：Linux VPS、Docker Compose、Caddy 自动 HTTPS
- Codex 接口：`codex app-server` 的 stdio JSON-RPC
- 最低支持版本：`codex-cli 0.144.4`

实施 C# Host Agent 前需要安装 .NET 10 SDK。

## 核心实现

### 1. Codex 插件

建立 personal marketplace 插件 `codex-collab`，包含：

- `.codex-plugin/plugin.json`
- `.mcp.json`
- `skills/`
- `hooks/hooks.json`
- 图标和说明资源

完整 v1 MCP 工具至少提供：

- `share_current_task`
- `share_project`
- `list_collaborators`
- `approve_device`
- `revoke_device`
- `set_collaborator_role`
- `resolve_approval`
- `open_collab_dashboard`
- `stop_sharing`

`SessionStart` Hook 将当前 `session_id`、`cwd` 和权限模式发送给 Host Agent，使“共享当前任务”
可以绑定正确的 Codex 对话。插件安装后必须在新任务中加载并测试。

### 2. Windows Host Agent

Host Agent 以当前 Windows 用户身份运行，通过登录启动任务自动启动，不要求管理员权限。

主要职责：

- 使用邀请人的 `CODEX_HOME` 启动 `codex app-server`
- 通过 stdio 完成 `initialize`
- 管理 `thread/start`、`thread/resume`
- 管理 `turn/start`、`turn/steer`、`turn/interrupt`
- 转发 Agent 消息、命令、文件变更、审批和测试结果
- 保持邀请人的 Codex 凭据只存在于本机
- 网络断开后自动重连并按序补发事件
- 启动时检查 Codex 版本和协议能力，不兼容时禁止写操作

插件 MCP 进程通过本机命名管道连接 Host Agent，公网永远不能直接访问 App Server。

### 3. 邀请和设备认证

邀请流程：

1. 邀请人在插件中选择项目和任务。
2. Host Agent 生成一次性邀请。
3. Relay 返回 HTTPS 链接和二维码。
4. 被邀请人的浏览器生成设备密钥并提交姓名。
5. 邀请人查看设备名称和密钥指纹。
6. 邀请人批准后，Host Agent 将房间密钥加密给该设备。
7. 设备取得短期访问令牌并进入房间。

默认策略：

- 邀请链接 24 小时过期
- 默认只能使用一次
- 访问令牌短期有效并自动续期
- 撤销成员后立即轮换房间密钥
- 已经下载或看过的历史无法从对方设备远程抹除，界面必须明确提示

规划加密方案：

- P-256 ECDH：设备密钥交换
- ECDSA：设备请求签名
- HKDF-SHA-256：派生密钥
- AES-256-GCM：对话与事件加密
- DPAPI：邀请人电脑上的房间密钥保护

完整 v1 的 Relay 只保存密文、序号、房间和设备路由信息。

### 4. 对话与 Codex 控制

一个共享房间包含：

- 主共享对话
- 最多两个并行 Codex Worker
- 成员消息、Agent 消息和系统事件
- 文件修改、命令、测试和审批记录

消息提交模式：

- Codex 空闲：创建新 Turn
- Codex 工作中选择“追加”：调用 `turn/steer`
- 选择“排队”：当前 Turn 完成后启动
- 选择“并行任务”：Git 项目分配空闲 Worktree
- 两个 Worker 均忙：进入有序队列

每条消息显示：

- 实际发送人
- 使用的 Codex Worker
- 时间和设备
- 对应 Turn
- 产生的文件、命令和测试结果

OpenAI/Codex 侧仍显示邀请人的身份和用量；真实操作者身份由 Codex Collab 的审计记录保存。

### 5. 项目文件控制

分享项目时由邀请人手动选择根目录。被邀请人可以：

- 查看和搜索全部文件
- 打开文本、代码、Markdown、JSON、图片等
- 新建、编辑、重命名和移动
- 上传和下载
- 查看 diff、作者和历史
- 删除至 Codex Collab 回收区
- 恢复历史版本

安全约束：

- 所有路径必须规范化并验证仍位于授权根目录
- 阻止 `..`、符号链接、Windows Junction 和 Reparse Point 越界
- 写入携带基础文件哈希，过期修改返回冲突
- 使用临时文件＋原子替换保存
- 修改前生成本地快照
- 批量删除、目录删除和不可恢复操作需要邀请人批准
- 二进制文件默认只支持预览、上传、下载和替换

主机离线时，文件管理区显示离线状态，不向云端保存项目文件快照。

### 6. Codex 配置管理

项目范围内允许查看和修改：

- `.codex/config.toml`
- `AGENTS.md`
- 项目 Agents、Skills、Rules
- 项目 Hooks 和相关脚本

用户级 Codex 控制区允许：

- 查看脱敏后的有效配置
- 修改模型、推理等级、个性和普通功能开关
- 提交全局 Agents、Skills、Rules 修改建议
- 查看插件和 MCP 的启用状态

必须经过邀请人审批：

- Sandbox、approval policy 和 Full Access
- Hooks
- MCP Server
- 插件安装或卸载
- Provider、代理和外部地址
- 全局 Agents、Skills、Rules 的可执行内容
- Computer Use、浏览器或网络权限
- 新增项目根目录

始终禁止远程读取：

- `auth.json`
- `.sandbox-secrets`
- Access Token、API Key、OAuth Token
- 浏览器 Cookie 和系统凭据
- 其他未共享任务的 Session、Memory、附件和日志数据库
- Codex 内部 SQLite、全局状态和安装标识

### 7. 双 Codex 并发

Git 项目：

- 每个 Worker 建立独立 Worktree
- 从相同基础提交和共享开始时的工作区快照启动
- 分支名使用 `codex-collab/<room>/<task>`
- Worker 不直接写邀请人的主工作区
- 完成后执行三方合并检查
- 不同文件或无冲突修改可自动合并
- 同一行冲突停止合并并显示双方 diff
- 运行邀请人确认过的测试、lint 和构建命令
- 测试失败保留 Worktree，不写入共享工作区

非 Git 项目：

- 只允许一个 Codex Worker
- 人工编辑仍使用哈希冲突检查和快照
- 第二个 Codex 请求进入队列
- 不自动执行 `git init`

## 数据接口

完整 v1 Relay 对外提供：

- 邀请领取和设备批准 REST API
- 房间、设备和撤销管理 API
- 加密历史分页 API
- SignalR 实时通道
- 加密大事件上传接口

实时协议至少包含：

- `presence.changed`
- `chat.message`
- `codex.turn.started/completed`
- `codex.item.delta/completed`
- `file.changed/conflict`
- `worker.status`
- `approval.requested/resolved`
- `member.approved/revoked`
- `room.key-rotated`

所有写请求包含：

- 房间 ID
- 设备 ID
- 单调递增序号
- 请求 ID
- 时间戳
- 加密负载
- 设备签名

Host Agent 对请求 ID 进行幂等去重。

## 测试与验收

必须通过以下场景：

1. 两个不同浏览器通过一次性链接加入，并显示不同身份。
2. 未经邀请人批准的设备不能读取任何历史。
3. 被邀请人的消息驱动邀请人的 Codex，邀请人额度和本机环境生效。
4. 刷新或更换页面后完整恢复加密对话历史。
5. 主机离线时可以查看历史，但文件和 Codex 操作不可用。
6. 项目文件可查看、修改、重命名和恢复。
7. `..`、Junction、符号链接和大小写路径绕过全部被拒绝。
8. `auth.json`、凭据和其他任务历史不能通过文件、配置或 Codex 提示读取。
9. 两个 Git Worker 能同时修改不同文件并安全合并。
10. 两个 Worker 修改同一行时必须产生冲突，不能覆盖。
11. 非 Git 项目的第二个 Worker 必须排队。
12. 高风险配置修改必须等待邀请人批准。
13. 撤销设备后，新消息无法解密或发送。
14. Host Agent、Relay 或网络重启后不会重复执行同一操作。
15. 插件通过验证器，重新安装后在新任务中出现。
16. MCP 完成真实 `initialize`＋`tools/list`，不能只检查进程或端口。
17. App Server 协议不兼容时降级为只读并明确提示。
18. 所有删除、权限、配置和 Codex 操作均有审计记录。

## 交付阶段

1. 基础仓库、协议、Host Agent 与本机 App Server 握手。
2. 单机共享对话、文件浏览和修改。
3. Relay、PWA、设备批准与端到端加密。
4. 权限、审批、配置控制和离线历史。
5. 双 Worktree Worker、合并和测试门禁。
6. 插件打包、personal marketplace 安装和真实 MCP 验证。
7. 断线恢复、安全测试、部署文档和备份恢复演练。

v1 不包括公开注册、付费、多租户市场、陌生用户共享、手机原生应用或云端文件快照。
