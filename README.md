# trend-coach-cloud

`dsh-plugin-trend-coach` 的云端服务仓库：提供课程知识检索、片段元数据、签名 HLS 播放会话、设备码授权、后台账号与内容管理、指标事件接收，以及语音转写（M4.2，MiniMax ASR）。

## 边界

| 提供 | 不提供 |
|---|---|
| 知识库检索（Top-K 片段） | 大模型推理 / API Key 托管 |
| 片段元数据与权威起止秒 | 全库正文下发 |
| 签名 HLS 播放会话 | 直链 / 可下载源站地址 |
| 设备码授权与令牌轮换 | 学员自助注册（短信后置） |
| 后台账号管理（operator/admin 会话） | 第三方分析 SDK |
| 内容管理 API 与 React 控制台（课程/章节/知识点/文章/片段） | 媒体上传、召回评估看板、插件版本与灰度 |
| 鉴权指标事件接收 | 明文令牌落盘 |
| 语音转写（仅语音→文字，密钥在云端） | 生成式推理 / 内容生成 |

不耦合 `ai-invest`：独立实现，只借鉴 PostgreSQL halfvec + pg_trgm + RRF 的技术选型。

## 接口

| 方法与路径 | 用途 |
|---|---|
| `GET /health` | 健康检查（含数据库连通性） |
| `POST /v1/auth/device/code` | 发起设备码授权 |
| `POST /v1/auth/device/token` | 轮询授权结果 |
| `POST /v1/auth/device/approve` | 批准设备码（账号密码、邀请码或运营会话） |
| `POST /v1/auth/refresh` | 轮换 access/refresh |
| `POST /v1/auth/revoke` | 注销当前设备并吊销其令牌 |
| `POST /v1/auth/invite/redeem` | 邀请码首次设置密码 |
| `POST /v1/auth/session` | 后台会话登录 |
| `GET/DELETE /v1/auth/session` | 查询会话 / 注销会话 |
| `POST /v1/auth/session/password` | 修改自己的密码 |
| `GET/POST /v1/admin/users` | 账号列表 / 创建账号（只读需 operator，创建需 admin） |
| `PATCH /v1/admin/users/{userId}` | 修改显示名、角色或状态（admin） |
| `POST /v1/admin/users/{userId}/reset` | 重置密码或签发一次性邀请码（admin） |
| `GET/POST /v1/admin/content/courses` | 课程列表 / 创建课程（operator/admin） |
| `GET/PATCH /v1/admin/content/courses/{courseId}` | 课程树 / 修改课程 |
| `POST /v1/admin/content/courses/{courseId}/chapters` | 新增章节 |
| `PATCH /v1/admin/content/courses/{courseId}/chapters/{chapterId}` | 修改章节 |
| `POST /v1/admin/content/courses/{courseId}/chapters/{chapterId}/knowledge-points` | 新增知识点 |
| `PATCH /v1/admin/content/knowledge-points/{knowledgePointId}` | 修改知识点 |
| `GET/PUT /v1/admin/content/knowledge-points/{knowledgePointId}/article` | 读取 / 保存文章（安全 Markdown） |
| `GET/POST /v1/admin/content/segments` | 片段列表 / 创建片段 |
| `PATCH /v1/admin/content/segments/{segmentId}` | 修改片段（正文变更会清空向量） |
| `POST /v1/admin/content/reindex` | 按课程重建片段向量 |
| `POST /v1/kb/search` | Top-K 片段检索 |
| `GET /v1/kb/segments/{segmentId}` | 片段详情 |
| `GET /v1/catalog/courses` | 已发布课程列表 |
| `GET /v1/catalog/courses/{courseId}` | 课程树与当前用户进度 |
| `GET /v1/catalog/knowledge-points/{knowledgePointId}` | 知识点详情与已发布文章 |
| `PUT /v1/progress/knowledge-points/{knowledgePointId}` | 上报学习进度 |
| `POST /v1/playback/sessions` | 换取签名播放地址 |
| `GET /v1/events/consent` | 读取指标上报同意状态 |
| `PUT /v1/events/consent` | 修改指标上报同意状态（可撤回） |
| `POST /v1/events` | 接收白名单指标事件（需同意） |
| `POST /v1/asr/transcribe` | 语音转写（WAV ≤60s，转发 MiniMax；音频不落盘） |

本地还提供 `GET /device` 授权页与 `GET /media/*` 媒体代理，仅开发使用，不进入对外契约。`GET /metrics` 为 Prometheus 指标，需 `Authorization: Bearer $METRICS_TOKEN`，同样不进入对外契约。

契约、边界、验收用例与待冻结事项见 [对接清单](docs/architecture/cloud-service-integration-checklist.md)。冲突时以插件仓库 PRD v1.6 §6 与架构 v1.6 §6 为准。

## 文档

| 文档 | 内容 |
|---|---|
| [需求文档](docs/requirements/product-requirements.md) | 范围、功能 C1–C10、NFR、验收、里程碑 |
| [架构设计](docs/architecture/architecture-design.md) | 组件、数据模型、检索、鉴权、媒体、安全、ADR |
| [对接清单](docs/architecture/cloud-service-integration-checklist.md) | 逐接口字段、边界与验收用例 |
| [项目规范](docs/conventions/project-conventions.md) | API、安全、测试、文档与提交约定 |
| [文档总览](docs/ai-context/docs-overview.md) | 阅读顺序与文档索引 |
| [项目结构](docs/ai-context/project-structure.md) | 现状与目标目录、放置规则 |
| [部署 Runbook](docs/operations/deployment-runbook.md) | Compose、TLS、迁移、备份恢复、媒体 CDN |
| [监控与告警](docs/operations/monitoring.md) | 指标接口、外部 Prometheus 接入、排障 |

协作与 Agent 约束见 [AGENTS.md](AGENTS.md)。

## 对接方

- 插件仓库：`../dsh-plugin-trend-coach`
- 插件侧 mock：`../dsh-plugin-trend-coach/spike/mock-kb-server.mjs`（可作为契约夹具参考）

## 本地运行

需要 Node.js ≥22 与 Docker。

```bash
cp .env.example .env
npm install
npm run db:up          # PostgreSQL 17 + pgvector
npm run migrate        # 建表与索引
npm run seed           # 种子课程与片段
npm run dev            # http://127.0.0.1:3939
npm run dev:admin      # 管理端开发服务器 http://127.0.0.1:5173/admin/（/v1 代理到 3939）
```

管理端（React + Vite）在 `web/admin/`：`npm run build` 会同时编译服务端与前端，产物落在 `dist/admin`，由服务端在 `/admin/` 静态托管；未构建前端时 `/admin/` 返回 404，API 不受影响。开发服务器可用 `ADMIN_DEV_API` 改变代理目标。登录会话令牌只存 `sessionStorage`，不使用 Cookie。

授权与联调：

```bash
# 首个管理员由 BOOTSTRAP_ADMIN_USERNAME / BOOTSTRAP_ADMIN_PASSWORD 在启动时创建。
curl -s -X POST http://127.0.0.1:3939/v1/auth/session \
  -H 'content-type: application/json' \
  -d '{"username":"admin01","password":"<初始密码>"}'
# 学员首次登录：打开 https://<域名>/device?code=<USER-CODE> 填写账号密码，
# 或使用邀请码设置密码；也可直接调用 /v1/auth/device/approve。
npm test                       # 单元 + 契约测试（自动重置测试库）
```

本地媒体需在 `.env` 设置 `MEDIA_LOCAL_DIR` 指向含 `hls/index.m3u8` 的目录；生产媒体走 CDN，不设该项。配置项与默认值见 `.env.example`。

## 部署

生产使用 Docker Compose + Caddy（自动 TLS），数据库为 pgvector；迁移在应用启动时执行。

```bash
cp .env.prod.example .env.prod   # 填域名、数据库与两个密钥
docker compose --env-file .env.prod -f docker-compose.prod.yml up -d --build
scripts/backup.sh                # 备份（可配 cron）
```

完整步骤、TLS、迁移、备份恢复、媒体 CDN 的 CORS/Range 要求与本地 staging 验证见 [部署 Runbook](docs/operations/deployment-runbook.md)。`/metrics` 保留供外部监控接入，默认不内置 Prometheus/Grafana 服务；接入方式见 [监控与告警](docs/operations/monitoring.md)。

## 目录

```
src/            # Fastify 服务：accounts/auth/content/kb/playback/events/media/http
web/admin/      # React + Vite 管理端源码（构建产物 dist/admin）
migrations/     # SQL 迁移（启动时自动执行）
data/seed.json  # 本地种子数据（与插件 mock 对齐）
openapi/        # OpenAPI 3.1 契约
test/           # 单元与契约测试
docs/           # 需求、架构、规范、部署与监控
docker/         # 本地数据库初始化
deploy/         # Caddy 与可选监控模板（不随 Compose 启动）
scripts/        # migrate/seed 与备份恢复入口
```

当前为 M3 实现阶段：M2 业务接口、设备码授权、签名 HLS、事件接收已落地；M3.3 体系与进度接口、M3.1 账号与后台登录、M3.2 内容管理 API 与 React 控制台已落地。
