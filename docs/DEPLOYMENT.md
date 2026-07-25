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

独立的第二实例：

- 控制台与 API：<https://codex-collab-guest.217.194.133.194.sslip.io/>
- 部署目录：`/opt/codex-collab-secondary/current`
- Compose 项目名：`codex-collab-secondary`
- Docker 内网别名：`secondary-relay`
- 本机端口：`127.0.0.1:4178`
- 数据卷：`codex-collab-secondary_relay-data`

服务器登录凭据不得写入本文档、Git、Compose 环境文件或日志。

## 3. 首次部署

```bash
cd /opt/codex-collab/current
cp deploy/.env.example deploy/.env
# 编辑 deploy/.env，让 CODEX_COLLAB_DOMAIN 指向已经解析到服务器的域名。
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

## 5. 发布新版本

1. 本地运行 [TESTING.md](./TESTING.md) 的全部检查。
2. 把提交推送到 GitHub `main`。
3. 使用该提交的 `git archive` 创建不可变发布包。
4. 上传至 `/opt/codex-collab/releases/<short-sha>/source.tar.gz`。
5. 校验本地与服务器 SHA-256 一致。
6. 解压到同目录的 `app`，复制服务器私有 `deploy/.env`。
7. 将 `/opt/codex-collab/current` 原子指向新发布目录。
8. 执行 Compose `config --quiet` 后只更新目标 Relay：
   `up -d --build --no-deps relay`。仅在反向代理配置发生变化时重建 Caddy。
9. 验证容器、HTTPS 和完整邀请闭环。

保留上一版发布目录，便于快速回滚。

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

## 7. 回滚

```bash
ln -sfn /opt/codex-collab/releases/<previous-sha>/app /opt/codex-collab/current
cd /opt/codex-collab/current
docker compose \
  -p codex-collab \
  --env-file deploy/.env \
  -f deploy/docker-compose.yml \
  up -d --build
```

回滚后仍要重新检查容器健康状态和公网 `/health`。

## 8. 数据备份

当前版本尚未自动备份。人工备份时应先短暂停止 Relay，避免复制 WAL 中间状态：

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

备份文件应复制到服务器之外，并定期执行恢复演练。

## 9. 插件连接公网 Relay

推荐从网页房间的“Codex 与文件”生成一次性配对码，再让本机插件调用
`collab_pair_host`，显式传入：

```text
relayUrl = https://codex-collab.217.194.133.194.sslip.io
pairingToken = 网页生成的短期一次性配对码
projectRoot = 主人明确批准的绝对目录
```

本地状态文件会记录当前会话的 Relay URL。不要把其中的成员 token 复制到聊天、日志或 Git。
