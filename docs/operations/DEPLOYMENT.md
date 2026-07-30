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
