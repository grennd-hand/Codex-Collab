# 部署与运维手册

## 1. 部署拓扑

```text
浏览器 / 协作者
        │ HTTPS / WSS :443
        ▼
      Caddy
        │ Docker 内网唯一别名
        │ primary-relay:4177
        ▼
  Codex Collab Relay
        │
        └── SQLite 持久卷
```

Relay 不直接发布宿主机端口。Caddy 只发布 443，因而可以与已经占用 80 的其他服务共存。

## 2. 当前公网环境

- 控制台与 API：<https://codex-collab.217.194.133.194.sslip.io/>
- 健康检查：<https://codex-collab.217.194.133.194.sslip.io/health>
- 部署目录：`/opt/codex-collab/current`
- Compose 项目名：`codex-collab`
- Docker 内网别名：`primary-relay`
- 数据卷：`codex-collab_relay-data`
- TLS：Caddy 自动管理的受信任证书
- Passkey Origin：与控制台 HTTPS 地址完全一致，默认从 `CODEX_COLLAB_PUBLIC_URL` 读取

独立的第二实例：

- 控制台与 API：<https://codex-collab-guest.217.194.133.194.sslip.io/>
- 部署目录：`/opt/codex-collab-secondary/current`
- Compose 项目名：`codex-collab-secondary`
- Docker 内网别名：`secondary-relay`
- 本机端口：`127.0.0.1:4178`
- 数据卷：`codex-collab-secondary_relay-data`

服务器登录凭据不得写入本文档、Git、Compose 环境文件或日志。

未限定实例的“部署/更新/回滚”只指主实例 `/opt/codex-collab/current`、Compose 项目
`codex-collab`。只有用户明确点名 Guest、secondary 或 4178 时才允许操作第二实例。两套实例
独立版本化；`/health` 都显示 `0.1.0` 不代表代码、schema 或静态资源相同。

## 3. 首次部署

```bash
cd /opt/codex-collab/current
cp deploy/.env.example deploy/.env
# 编辑 deploy/.env；当前 Caddy 配置同时引用 primary 与 secondary domain，两者都必须有效，
# 或先拆除未启用的 secondary site block。
docker compose \
  -p codex-collab \
  --env-file deploy/.env \
  -f deploy/docker-compose.yml \
  up -d --build
```

## 4. 健康检查

```bash
docker compose \
  -p codex-collab \
  --env-file deploy/.env \
  -f deploy/docker-compose.yml \
  ps

docker compose \
  -p codex-collab \
  --env-file deploy/.env \
  -f deploy/docker-compose.yml \
  logs --tail=100 relay caddy
```

公网验证：

```bash
curl --fail --show-error \
  https://codex-collab.217.194.133.194.sslip.io/health
```

成功条件：

- Relay 状态为 `healthy`；
- Caddy 状态为 `Up`；
- `/health` 返回 HTTP 200 和 `status: ok`；
- 首页返回安全响应头和受信任 HTTPS 证书。

当前 `/health` 只是进程 liveness：它不查询 SQLite、数据卷写入、migration 状态，也不包含
commit/image digest。发布验证还必须比对预期 release SHA、首页资产 hash 和真实业务闭环；
不能用 HTTP 200 或硬编码 `0.1.0` 判定部署版本正确。

## 5. 发布新版本

1. 本地运行 [TESTING.md](./TESTING.md) 的全部检查。
2. 把提交推送到 GitHub `main`。
3. 使用该提交的 `git archive` 创建不可变源码快照。
4. 上传至 `/opt/codex-collab/releases/<short-sha>/source.tar.gz`。
5. 校验本地与服务器 SHA-256 一致。
6. 解压到同目录的 `app`，按当前流程复制服务器私有 `deploy/.env`。这是已知债务：下一步应
   把实例环境移到 release 外固定的私有路径并让所有版本引用，避免安全开关随源码回滚。
7. 将 `/opt/codex-collab/current` 原子指向新发布目录。
8. 执行 Compose `config --quiet` 后只更新目标 Relay：
   `up -d --build --no-deps relay`。仅在反向代理配置发生变化时重建 Caddy。
9. 记录 commit、schema、镜像 digest、静态资产 hash，验证容器、HTTPS 和完整邀请闭环。

保留上一版发布目录，便于快速回滚。

当前流程仍会在服务器重新 build，不能保证未来得到同一二进制。生产基线应保存 release
manifest 并发布锁定 digest 的镜像；回滚直接切换旧 digest，而不是从旧源码重新构建。

实时连接迁移期间，只有仍存在旧 Host 的实例才显式设置
`CODEX_COLLAB_ALLOW_LEGACY_REALTIME_TOKENS=1`，并记录 owner、使用量和清退日期。网页和新版
Host 使用 30 秒一次性票据。确认实例上的 Host 都已升级后改为 `0` 并只重建目标 Relay；
长期目标是代码和模板默认 `0`，删除把长期 token 放进 WebSocket URL 的 fallback。

## 6. 更新第二实例

第二实例使用 `deploy/docker-compose.secondary.yml`，共享主实例的 Caddy 网络，但不共享
Relay 容器、发布目录或数据卷。Caddy 只通过唯一别名 `primary-relay` 和
`secondary-relay` 路由，不能使用两个 Compose 项目都会注册的默认服务名 `relay`。
部署主实例不会重启第二 Relay。

```bash
cd /opt/codex-collab-secondary/current
docker compose \
  -p codex-collab-secondary \
  --env-file deploy/.env \
  -f deploy/docker-compose.secondary.yml \
  up -d --build
```

第二实例环境文件至少包含：

```text
CODEX_COLLAB_DOMAIN=codex-collab-guest.217.194.133.194.sslip.io
CODEX_COLLAB_HOST_PORT=4178
CODEX_COLLAB_PROXY_NETWORK=codex-collab_collab
```

Passkey 使用每个实例自己的完整主机名作为 RP ID。主实例与第二实例不得配置成共同的
`sslip.io` 父域，也不得共享 Relay 数据卷。若需显式配置，可加入：

```text
CODEX_COLLAB_PASSKEY_ORIGIN=https://codex-collab-guest.217.194.133.194.sslip.io
CODEX_COLLAB_PASSKEY_RP_ID=codex-collab-guest.217.194.133.194.sslip.io
```

## 7. 回滚

回滚前必须确认旧程序兼容当前 SQLite schema，并先创建一致性备份。当前源码重建方式只作为
过渡流程；已经保存镜像 digest 时应直接切换旧 digest。

```bash
ln -sfn /opt/codex-collab/releases/<previous-sha>/app /opt/codex-collab/current
cd /opt/codex-collab/current
docker compose \
  -p codex-collab \
  --env-file deploy/.env \
  -f deploy/docker-compose.yml \
  up -d --build --no-deps relay
```

只有 Caddy 配置本身发生变化且明确授权时才更新 Caddy。回滚后重新核对 release marker、
schema、资产 hash、HTTPS 和真实登录/邀请流程，并证明 Guest 容器、卷和首页 hash 未改变。

### 7.1 2026-07-31 Primary 发布记录

- 源提交：`69047231cd574c4f1255046c3eab06734a84bf5a`；不可变 release：
  `/opt/codex-collab/releases/6904723-20260730T211622Z/app`。
- 源归档 SHA-256：`f5f3f0741ed118c4ef24739e151475777277a077fcae4b0dbad6fe7871f6c816`。
- 切换前一致性备份：`/opt/codex-collab/backups/relay-data-20260730T212400Z.tar.gz`；旧 release
  `/opt/codex-collab/releases/d10f20f/app` 和旧镜像回滚标签保留。
- Primary 容器切换为 `8040771316db` 并通过 Docker health 与公网 `/health`；首页 SHA-256 切换为
  `44e6444feca4c2b6d34b4a6e88e2679041122b7679006d5fc1fdbc317c724da9`，入口引用的 5 个资产均返回成功。
- 公网临时会话完成邀请、加入、批准即 `workspace-write`、Realtime `submitted`、assistant history、
  `completed` 和刷新后终态持久化闭环。
- Guest 仍为 release `d10f20f`、容器 `d74f3456a2a3`、首页 SHA-256
  `727780650530aae367adc8b29dd7045c87d691fa59355541760489a8cdb35195`；Caddy 容器仍为
  `055f22e85bd9`。两者未重启、未重建、未改配置或数据卷。

### 7.2 2026-07-31 Primary 时间线发布记录（已由 7.3 取代）

- 源提交：`dbca79bb56e394da0975bd363dda3d2434f9086a`；不可变 release：
  `/opt/codex-collab/releases/dbca79b-20260731T052744Z/app`。
- 源归档 SHA-256：`90393c01baa9a72976f285a416e028a04d9f87098ad53ddb08d8074bc018ce5b`；
  切换前一致性备份：`/opt/codex-collab/backups/relay-data-20260731T053519Z.tar.gz`。
- Primary 容器切换为 `ee3c32171b78`，镜像 digest 为
  `sha256:ccc1c95a9e906b0f50e9a464aeb63122358b8be3442d054ce6666833523a89e2`；
  Docker health 与公网 `/health` 均通过。
- Primary 首页 SHA-256 切换为
  `6196f20b388b1ef8fe2d19324c7e246f3dec61540112864868cc388f51f8b15c`，入口引用的
  5 个静态资产均以真实 GET 验证成功；线上 bundle 包含“运行了多个命令”单一历史折叠规则。
- 公网临时会话再次完成安全响应头、邀请、加入、批准即 `workspace-write`、Realtime
  `submitted`、assistant history、`completed` 和刷新后终态持久化闭环。
- Guest 仍为 release `d10f20f`、容器 `d74f3456a2a3`、首页 SHA-256
  `727780650530aae367adc8b29dd7045c87d691fa59355541760489a8cdb35195`；Caddy 容器仍为
  `055f22e85bd9`。两者未重启、未重建、未改配置或数据卷。
- 该版本把被正文分隔的历史命令也跨段合并，和最终确认的“每两段文字之间各自折叠”不一致，
  随后由 7.3 的 `c11976e` 修正版替换。

### 7.3 2026-07-31 Primary 文字区间命令折叠修正版

- 源提交：`c11976e0dd4806e5df4b762dd03f7343830b3adf`；不可变 release：
  `/opt/codex-collab/releases/c11976e-20260731T055707Z/app`。
- 源归档 SHA-256：`a414b4189592d267f731d183c9f0f589d0bd2381e151ae2492df111aa49e8715`；
  切换前一致性备份：`/opt/codex-collab/backups/relay-data-20260731T060106Z.tar.gz`。
- Primary 容器切换为 `1a174cecedb3`，镜像 digest 为
  `sha256:f378c162bab6717fc8812048bd8993dc37c97ff3faf948541901b421ad5a8af6`；
  Docker health 与公网 `/health` 均通过。
- Primary 首页 SHA-256 切换为
  `84a105dae9ccf0ef961fe6cdbc0382521f9adb22106d455afe5981db021034b9`，入口引用的
  5 个静态资产均以真实 GET 验证成功。
- focused 回归固定顺序为“文字 A -> 折叠命令组 -> 文字 B -> 折叠命令组 -> 文字 C ->
  当前运行命令”；历史命令默认不渲染详情，当前命令和失败命令保持单独展开。
- 公网临时会话再次完成安全响应头、邀请、加入、批准即 `workspace-write`、Realtime
  `submitted`、assistant history、`completed` 和刷新后终态持久化闭环。
- Guest 仍为 release `d10f20f`、容器 `d74f3456a2a3`、首页 SHA-256
  `727780650530aae367adc8b29dd7045c87d691fa59355541760489a8cdb35195`；Caddy 容器仍为
  `055f22e85bd9`。两者未重启、未重建、未改配置或数据卷。

### 7.4 2026-07-31 Primary 实时终态追平与运行流压缩

- 源提交：`99d89e3906e8f9b3a4097ba1c93aa4926f6344ee`；不可变 release：
  `/opt/codex-collab/releases/99d89e3-20260731T140007Z/app`。
- 源归档 SHA-256：`0f4bb698eb9f1c49fa95281895f285441b3e21b10f9eb848c79203983244cc8a`；
  切换前一致性备份：`/opt/codex-collab/backups/relay-data-20260731T140946Z.tar.gz`。
- Primary 容器切换为 `364099d77f02`，镜像 digest 为
  `sha256:1d8da45db4339f81643d1f179047f4ce0d6caf3ea0bfe6c89e5e007c8c229373`；
  Docker health 与公网 `/health` 均通过。
- Primary 首页 SHA-256 切换为
  `4dabe77cc77de36c32ea53bb8595ee44770b949da0a8e5b65200c4ee389db1fb`，入口主资源为
  `/assets/index-BWqAoZPj.js`；5 个入口资产均以真实 GET 验证成功。
- 本版本修复终态事件早于最终 history 发布时的刷新竞态：终态等待 Host 历史节奏，刷新中的重复
  history 请求只排队一次尾随重取。活动流仅显示唯一当前步骤，既往步骤收进同一个可展开历史批次；
  手动停止且已有最终回复时继续展示 Codex 最终总结并收敛终态。
- 全仓 639 项测试与五项门禁通过；公网临时会话完成安全响应头、邀请、加入、批准即
  `workspace-write`、Realtime `submitted`、assistant history、`completed` 和持久化终态闭环。
- Guest 保持容器 `63fe0557617d`、首页 SHA-256
  `cd2d1131ff5b82730f6efdde1a2cbd804eb24104cc914027b3f847b97e49ac24` 和入口主资源
  `/assets/index-8LGcCuEJ.js`；Caddy 容器保持 `055f22e85bd9`。两者未重启、未重建、未改配置或数据卷。

### 7.5 2026-07-31 双实例同步恢复版本

- 源提交：`e680d9073cedc3aa96f68c6f98e2a2a53fb21817`；Primary 与 Guest 均指向不可变 release
  `e680d90-20260731T150525Z`，源归档 SHA-256 为
  `5be8233eca63a9df9c5f971b595b8b75f60325ae89e32f73fd9ff7fba72af82f`。
- Primary 先独立切换并备份到 `/opt/codex-collab/backups/relay-data-20260731T151259Z.tar.gz`；
  用户明确要求部署两个实例后，Guest 再备份到
  `/opt/codex-collab-secondary/backups/relay-data-20260731T152940Z.tar.gz` 后切换。
- Guest 最终通过 `deploy/docker-compose.secondary.yml` 运行，继续挂载
  `codex-collab-secondary_relay-data`，仅加入共享 `codex-collab_collab` 网络并使用
  `secondary-relay` 别名，本机监听保持 `127.0.0.1:4178`。
- 首次 Guest 重建误用主 Compose，虽然容器内部健康，但共享 Caddy 因缺少 `secondary-relay` 别名
  返回 502；该次不视为成功发布。随后按专用 Secondary Compose 强制重建并删除误建、无人引用且
  为空的两个 Secondary Caddy 卷，公网与本机健康检查均恢复。
- 最终 Primary 容器为 `5c831596578c`，Guest 容器为 `f312988bcec5`，Caddy 保持
  `055f22e85bd9`；两套 Relay 均为 `running|healthy`，5 个入口资产可访问，两个首页 SHA-256 均为
  `5abe05d9ca553eefda355db19a76fac60c1673c887c1583e06a38e033b7b19ba`。

## 8. 数据备份

当前版本尚未自动备份，也没有仓库内可执行的恢复流程或恢复报告，因此不满足生产恢复要求。
人工备份时应先短暂停止目标 Relay，避免复制 WAL 中间状态：

```bash
cd /opt/codex-collab/current
docker compose \
  -p codex-collab \
  --env-file deploy/.env \
  -f deploy/docker-compose.yml \
  stop relay

docker run --rm \
  -v codex-collab_relay-data:/source:ro \
  -v /opt/codex-collab/backups:/backup \
  alpine tar -czf /backup/relay-data-YYYYMMDD-HHMMSS.tar.gz -C /source .

docker compose \
  -p codex-collab \
  --env-file deploy/.env \
  -f deploy/docker-compose.yml \
  up -d
```

该示例只覆盖 primary，且任何中途失败都必须人工确认 Relay 已恢复运行。正式方案必须强制选择
`primary|guest`，生成 SHA-256/manifest、加密并异地复制；恢复只能写入新卷和临时 Compose
项目，随后执行 `PRAGMA integrity_check`、登录、房间和消息读取。定义 RPO/RTO，并至少每月
自动恢复演练，不能把“有 tar 文件”当作备份闭环完成。

完整优先级和运维验收条件见
[ARCHITECTURE_AUDIT_2026-07-28.md](../audits/ARCHITECTURE_AUDIT_2026-07-28.md)。

## 9. 插件连接公网 Relay

推荐从网页房间的“Codex 与文件”生成一次性配对码，再让本机插件调用
`collab_pair_host`，显式传入：

```text
relayUrl = https://codex-collab.217.194.133.194.sslip.io
pairingToken = 网页生成的短期一次性配对码
projectRoot = 主人明确批准的绝对目录
```

本地状态文件会记录当前会话的 Relay URL。不要把其中的成员 token 复制到聊天、日志或 Git。
