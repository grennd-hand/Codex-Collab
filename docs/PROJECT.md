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
- WebSocket 实时成员和消息更新；
- Codex MCP 插件、任务绑定与 `app-server` 指令转发；
- 仅限明确绝对根目录的文件读取、带预期 SHA-256 的原子写入；
- 路径穿越与符号链接逃逸防护；
- Docker Compose、SQLite 持久卷、Caddy HTTPS 与 WebSocket 代理；
- 公网控制台：<https://codex-collab.217.194.133.194.sslip.io/>。

这代表“可邀请真实测试者验证 MVP”，不代表已经完成商业生产的全部加固。未完成项在
[TASK_PLAN.md](./TASK_PLAN.md) 中持续跟踪。

## 3. 使用角色

### 主人

- 创建会话和邀请；
- 查看并明确批准待加入成员；
- 绑定唯一明确的共享项目根目录；
- 选择要接收协作者指令的 Codex 任务；
- 决定是否把某条 `codex_prompt` 转发给 Codex；
- 保留原有 Codex 审批策略和沙箱控制权。

### 协作者

- 通过短期邀请链接申请加入；
- 获批后参与共享聊天；
- 提交带身份标记的 Codex 指令；
- 在主人共享根目录内使用允许的文件工具；
- 不能访问未共享目录或隐式访问 `.codex`。

### Relay

- 保存会话、邀请、成员、批准状态和消息；
- 只保存成员 bearer token 的 SHA-256 哈希；
- 通过 HTTPS/WebSocket 分发事件；
- 不持有 SSH 凭据、Codex 账户凭据或主人的本地文件。

## 4. 关键工作流

### 网页邀请

1. 主人在控制台创建会话。
2. 主人点击“创建邀请”。
3. 控制台生成 60 分钟、一次性邀请链接。
4. 协作者打开完整链接，令牌自动填入且从地址栏移除。
5. 协作者提交显示名称后进入“待批准”状态。
6. 主人在成员列表中批准。
7. 双方开始实时聊天。

### Codex 指令

1. 主人通过插件创建或加入主人会话，并绑定明确项目根目录。
2. 主人把会话绑定到一个 Codex 任务。
3. 已批准成员发送 `codex_prompt`。
4. 主人端按消息 ID 明确转发。
5. 插件通过本地 Codex `app-server` 恢复任务并开始新一轮。
6. Codex 原有审批策略继续生效。

当前版本不会在公网 Relay 上运行 Codex，也不会让 Relay 直接访问本机。

### 文件协作

1. 插件对主人选择的绝对根目录执行 `realpath`。
2. 所有请求路径必须保持在该根目录内。
3. 读取返回内容和 SHA-256。
4. 写入必须携带调用方读取时得到的预期 SHA-256。
5. 哈希变化时返回冲突，不静默覆盖。

## 5. 仓库结构

```text
apps/dashboard/             React + Fluent UI 控制台
apps/relay/                 HTTP、WebSocket、SQLite Relay
packages/protocol/          共享协议类型与输入验证
plugins/codex-collab/       Codex 插件、MCP Server、协作技能
.agents/plugins/            仓库内 Codex marketplace
deploy/                     VPS Compose 与 Caddy 配置
docs/                       架构、项目、部署、测试、任务计划
scripts/                    MCP 与 app-server 验证脚本
```

## 6. 数据与凭据

- Relay SQLite：Docker `relay-data` 命名卷；
- Caddy 证书与配置：独立命名卷；
- 浏览器成员凭据：当前标签页的 `sessionStorage`；
- 本地插件成员凭据：用户目录下 `.codex-collab/state.json`；
- Relay 数据库只保存 token 哈希，不保存原始成员 token；
- 邀请 token 位于 URL fragment，不会随普通 HTTP 请求发送给服务器；
- 任何密码、SSH 私钥、API Key 或成员 token 都不得提交到 Git。

## 7. 当前限制

- Codex 指令目前需要主人端显式执行转发，不是常驻后台自动消费；
- 尚未提供成员撤销、邀请撤销和细粒度根目录权限；
- 尚未实现自动备份、速率限制、审计导出和集中监控；
- 尚未进行正式并发压测和故障注入；
- 当前公网使用 `sslip.io` 测试域名，正式发布建议换成自有域名；
- 网页主人会话与本地插件主人会话仍是两个独立入口，需统一会话交接体验。

## 8. 文档导航

- [README](../README.md)：快速开始与入口
- [架构与信任模型](./architecture.md)
- [部署与运维](./DEPLOYMENT.md)
- [测试手册](./TESTING.md)
- [任务规划书](./TASK_PLAN.md)

