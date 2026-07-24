# 测试手册

## 1. 交付前必跑检查

```powershell
npm run typecheck
npm test
npm run build
npm run test:workspace-flow
npm run validate:plugin
node scripts/probe-mcp.mjs
npm audit --audit-level=high
```

MCP 验证必须真实完成 `initialize` 和 `tools/list`。仅看到进程运行或 HTTP 响应不算通过。

`test:workspace-flow` 是纯代码/API 闭环，不启动或操控浏览器。它使用临时端口和临时
SQLite，验证：创建房间 → 一次性 Host 配对 → 发布任务目录 → 待批准成员被拒绝 →
房主批准 → 选择任务 → 发布历史和文件 → 已批准成员读取，结束后自动删除临时数据。

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
- 非主人不能创建邀请或批准成员；
- Relay 数据库不出现原始 bearer token；
- `../`、绝对路径跳出和符号链接逃逸均被拒绝；
- 写文件时预期哈希变化会产生冲突；
- 项目根目录授权不会隐式授权 `.codex`；
- 公网只暴露 HTTPS Relay，不暴露 Codex `app-server`；
- 转发 Codex 指令时不覆盖主人现有审批策略。
- Host 配对码使用一次后失效，数据库不出现原始配对码或 Host token；
- 非房主不能发布任务目录、选择任务或发布快照；
- 切换任务会先清空旧历史和旧文件；
- Codex 记录包含 app-server 可见推理摘要和命令输出，但不包含原始隐藏思维链；
- 命令输出中的高置信 Token、私钥块和凭据赋值会被脱敏；
- 项目根不会隐式开放 `.codex`；只有单独显式的 `codexConfigRoot` 会加入配置快照；
- `.codex` 快照排除 `auth.json`、其他任务 Session、历史数据库、私钥和高置信凭据；
- 网页文件快照排除 `.env`、二进制与符号链接。

## 6. UI 回归

- 桌面浅色和深色主题；
- 390px 宽度不出现水平滚动；
- 会话创建、加入、待批准、已批准四种状态；
- 空消息、长消息、成员列表和错误提示；
- 邀请弹窗、复制成功与复制失败反馈；
- 页面刷新后的标签页会话恢复；
- 离开本机会话不会删除服务器数据。
- “Codex 与文件”支持未配对、已配对、等待导入、已同步和空文件状态；
- 房主能选择本项目 Codex 任务，已批准协作者只能查看已选任务；
- 记录列表能区分用户、Codex、推理摘要和命令执行；
- `.codex/` 配置文件与项目文件使用不同路径前缀显示；
- 文件列表和只读预览在桌面与 390px 宽度可用。
