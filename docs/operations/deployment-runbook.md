# 部署 Runbook

版本：v0.2（2026-10-31）

面向运维与开发：把云端服务部署到一台 Linux 主机，覆盖 TLS、数据库迁移、备份恢复、媒体 CDN 与本地 staging 验证。监控见 [监控与告警](./monitoring.md)。

## 1. 拓扑与前置条件

```
Internet ── Caddy(80/443, 自动 TLS) ── app(Fastify, 3939)
                                          ├── db(PostgreSQL 17 + pgvector)
                                          └── 媒体：生产走 CDN；仅本地 staging 由 app 的 /media 提供
Prometheus(可选) ── 抓取 app:/metrics（Bearer METRICS_TOKEN）
Grafana(可选) ── 查询 Prometheus
```

主机要求：

- Linux + Docker Engine 24+、Compose v2；2 vCPU / 2 GB 内存起步。
- 公网域名（A/AAAA 指向主机），放行 80/443；数据库与 3939 不对公网暴露。
- 生产媒体域名与对象存储/CDN 已就绪（见 §7）。

## 2. 准备配置与密钥

```bash
cp .env.prod.example .env.prod
chmod 600 .env.prod
```

至少填写：`APP_ENV`、`PUBLIC_BASE_URL`、`MEDIA_BASE_URL`、`DOMAIN`、`POSTGRES_USER/PASSWORD/DB`、`METRICS_TOKEN`、`MEDIA_SIGNING_SECRET`；首次部署另填 `BOOTSTRAP_ADMIN_USERNAME` 与 `BOOTSTRAP_ADMIN_PASSWORD`。

```bash
openssl rand -hex 32   # METRICS_TOKEN
openssl rand -hex 32   # MEDIA_SIGNING_SECRET
openssl rand -hex 24   # POSTGRES_PASSWORD
```

规则由 `src/config.ts` 强制，配置错误会阻止启动：

- 非 local 必须 HTTPS；production 的 `PUBLIC_BASE_URL`/`MEDIA_BASE_URL` 不允许本机地址。
- `METRICS_TOKEN`、`MEDIA_SIGNING_SECRET` 至少 16 字符，且不能是本地默认值。
- `BOOTSTRAP_ADMIN_USERNAME` 与 `BOOTSTRAP_ADMIN_PASSWORD` 必须成对配置；用户名匹配 `[a-z][a-z0-9._-]{2,31}`，密码至少 12 字符。首个管理员只在库中无 active admin 时创建，创建成功后应移除这两个变量并重启。
- `POSTGRES_PASSWORD` 含 `:/@?#[]%` 等字符时，`DATABASE_URL` 需要 URL 编码；建议直接用字母数字。

## 3. 首次部署

```bash
docker compose --env-file .env.prod -f docker-compose.prod.yml up -d --build
docker compose --env-file .env.prod -f docker-compose.prod.yml ps
curl -fsS https://$DOMAIN/health   # {"ok":true}
```

要点：

- 迁移在 app 启动时自动执行；多实例并发时由 PostgreSQL advisory lock 串行化。迁移只向前，不自动回滚。
- `caddy` 等待 app healthy 后启动；首次签发证书需要域名可解析且 80/443 可达。
- staging 可导入种子数据（生产走内容管线，不执行）：

```bash
docker compose --env-file .env.prod -f docker-compose.prod.yml exec -T app \
  node --input-type=module -e "const {loadConfig}=await import('./dist/config.js'); const {createPool}=await import('./dist/db.js'); const {seedDatabase}=await import('./dist/seed.js'); const pool=createPool(loadConfig().databaseUrl); const seed=await seedDatabase(pool); await pool.end(); console.log('seeded', seed.segments.length)"
```

- 后台登录与账号创建（首个管理员来自 `BOOTSTRAP_ADMIN_*`）：

```bash
curl -fsS -X POST https://$DOMAIN/v1/auth/session \
  -H "content-type: application/json" \
  -d '{"username":"admin01","password":"<初始密码>"}'
# 返回 token；用 admin 会话创建学员账号，role 为 student/operator/admin：
curl -fsS -X POST https://$DOMAIN/v1/admin/users \
  -H "content-type: application/json" -H "authorization: Bearer $SESSION_TOKEN" \
  -d '{"username":"student01","displayName":"张三","role":"student","password":"<初始密码>"}'
```

- 学员设备授权：打开 `https://$DOMAIN/device?code=<USER-CODE>` 输入用户名与密码（首次可用邀请码设置密码）；运营人员也可用会话直接批准：

```bash
curl -fsS -X POST https://$DOMAIN/v1/auth/device/approve \
  -H "content-type: application/json" -H "authorization: Bearer $SESSION_TOKEN" \
  -d '{"userCode":"ABCD-EFGH"}'
```

- 内容管理控制台：浏览器打开 `https://$DOMAIN/admin/`，用 operator/admin 账号登录，管理课程、章节、知识点、文章与片段。镜像构建已包含 `web/admin` 并输出到 `dist/admin`；服务端只在 `dist/admin/index.html` 存在时挂载 `/admin/`，缺失时该路径 404 而 API 不受影响。前端是纯静态 SPA，会话令牌存 `sessionStorage`，关标签即失效，不使用 Cookie，因此 `/admin/` 反向代理无需额外鉴权配置（接口本身仍校验 Bearer）。

## 4. TLS

Caddy 为 `$DOMAIN` 自动申请与续期证书（Let's Encrypt / ZeroSSL）。不使用 Nginx 或宿主机证书。

- 验证：`curl -vI https://$DOMAIN/health`，证书签发者应为公信 CA。
- 域名未就绪的临时环境：将 `DOMAIN` 设为 `localhost` 使用 Caddy 本地 CA，访问时加 `-k`。
- 证书与私钥保存在 `caddy_data` volume；删除该 volume 会触发重新签发，注意 Let's Encrypt 速率限制。

## 5. 迁移

- 启动即执行 `migrations/*.sql`，记录在 `schema_migrations`。
- 新增迁移：只追加文件、不改已执行文件；在一个事务内执行。
- 需要回退时按 §6 恢复备份，再部署对应版本镜像；不要手写逆向 SQL。

## 6. 备份与恢复

备份（默认保留 14 天，输出到 `backups/`）：

```bash
scripts/backup.sh
# 可覆盖：ENV_FILE、BACKUP_DIR、BACKUP_RETENTION_DAYS
```

建议 cron（每天 03:17，并把 `backups/` 同步到异机/对象存储）：

```cron
17 3 * * * cd /srv/trend-coach-cloud && ./scripts/backup.sh >> /var/log/trend-coach-backup.log 2>&1
```

恢复（会停 app、覆盖数据库，需显式确认）：

```bash
RESTORE_CONFIRM=yes scripts/restore.sh backups/trend-coach-20261031T031700Z.sql.gz
```

演练：至少每季度在 staging 恢复一次，并跑一次设备授权 + 检索 + 播放冒烟。

## 7. 媒体、CORS 与 Range

生产不在业务进程代理媒体：`MEDIA_BASE_URL` 指向 CDN 根，播放地址为 `MEDIA_BASE_URL + hlsPath?token=...`。

CDN/对象存储必须满足：

| 要求 | 说明 |
|---|---|
| 保留查询串 | 播放与密钥请求都带 `?token=`；CDN 不得丢弃查询串 |
| CORS | `GET`/`HEAD` 返回 `access-control-allow-origin: *`（与 app 的 CORS 策略一致） |
| Range | MP4 等大文件返回 `206` 与 `accept-ranges: bytes`，否则播放器无法定位 |
| 缓存 | `index.m3u8` 与 `*.key` 不缓存或极短缓存；分片可长缓存 |
| 防盗链 | token 是短时能力 URL，建议 CDN 侧同时开启 Referer/签名校验；token 由 app 签发，有效期取 `PLAYBACK_SESSION_TTL_SECONDS` |

验收：

```bash
curl -sI https://media.example.com/hls/index.m3u8 -H 'Origin: https://example.com' | grep -i 'access-control-allow-origin'
curl -sI https://media.example.com/hls/seg0.ts -H 'Range: bytes=0-99' | grep -iE 'HTTP/|content-range|accept-ranges'
```

仅本地 staging 验证时，设置 `MEDIA_HOST_DIR`（挂载到容器 `/media`）与 `MEDIA_LOCAL_DIR=/media`，并把 `MEDIA_BASE_URL` 设为 `https://$DOMAIN/media`；此时 Range、CORS 与令牌校验由 app 负责。

## 8. 健康检查与观测

- `GET /health`：检查数据库连通性；失败返回 503。Docker healthcheck 与负载均衡都用它。
- `GET /metrics`：Prometheus 指标，需 `Authorization: Bearer $METRICS_TOKEN`。该端点不属于对外契约，不写入 OpenAPI。
- 日志为 JSON 到 stdout，可由 `docker compose logs -f app` 或主机日志驱动采集；token、设备 ID 已脱敏。

监控不随 Compose 部署；`/metrics` 保留，接入外部 Prometheus 见 [监控与告警](./monitoring.md)。

## 9. 发布与回滚

```bash
# 发布：固定镜像标签，避免 “latest” 漂移
IMAGE_TAG=2026-10-31 docker compose --env-file .env.prod -f docker-compose.prod.yml up -d --build
# 回滚：切回上一镜像标签
IMAGE_TAG=2026-10-30 docker compose --env-file .env.prod -f docker-compose.prod.yml up -d
```

- 发布前：`npm run typecheck && npm test`、备份、确认迁移可向前兼容；`npm run build` 会同时产出服务端与 `dist/admin`。
- 发布后：`/health`、一次设备授权/刷新、一次检索、一次播放会话、打开 `/admin/` 完成一次登录与内容读写，检查 5xx 与 P95。
- 迁移已改变数据时，仅回滚镜像可能不兼容；优先前滚修复，否则按 §6 恢复。

## 10. 本地 staging 验证

用同一份 compose 在开发机走一遍 staging 配置（不依赖公网 DNS）：

`.env.prod` 关键项：

```dotenv
APP_ENV=staging
PUBLIC_BASE_URL=https://localhost
MEDIA_BASE_URL=https://localhost/media
DOMAIN=localhost
MEDIA_HOST_DIR=../dsh-plugin-trend-coach/spike/media
MEDIA_LOCAL_DIR=/media
```

```bash
docker compose --env-file .env.prod -f docker-compose.prod.yml up -d --build
curl -kfsS https://localhost/health
# 设备码 → 账号密码批准 → 换 token → 检索 → 播放会话
```

验证通过后即可把同一 Compose 指向真实域名与 CDN；两者差异只在 `.env.prod`。
