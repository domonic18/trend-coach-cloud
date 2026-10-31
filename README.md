# trend-coach-cloud

`dsh-plugin-trend-coach` 的云端服务仓库：提供课程知识检索、片段元数据、签名 HLS 播放会话、设备码授权与指标事件接收。

## 边界

| 提供 | 不提供 |
|---|---|
| 知识库检索（Top-K 片段） | 大模型推理 / API Key 托管 |
| 片段元数据与权威起止秒 | 全库正文下发 |
| 签名 HLS 播放会话 | 直链 / 可下载源站地址 |
| 设备码授权与令牌轮换 | 写接口（一期只读） |
| 鉴权指标事件接收 | 第三方分析 SDK |

不耦合 `ai-invest`：独立实现，只借鉴 PostgreSQL halfvec + pg_trgm + RRF 的技术选型。

## 接口

| 方法与路径 | 用途 |
|---|---|
| `GET /health` | 健康检查（含数据库连通性） |
| `POST /v1/auth/device/code` | 发起设备码授权 |
| `POST /v1/auth/device/token` | 轮询授权结果 |
| `POST /v1/auth/device/approve` | 控制台批准设备码（临时入口） |
| `POST /v1/auth/refresh` | 轮换 access/refresh |
| `POST /v1/kb/search` | Top-K 片段检索 |
| `GET /v1/kb/segments/{segmentId}` | 片段详情 |
| `POST /v1/playback/sessions` | 换取签名播放地址 |
| `GET /v1/events/consent` | 读取指标上报同意状态 |
| `PUT /v1/events/consent` | 修改指标上报同意状态（可撤回） |
| `POST /v1/events` | 接收白名单指标事件（需同意） |

本地还提供 `GET /device` 授权页与 `GET /media/*` 媒体代理，仅开发使用，不进入对外契约。

契约、边界、验收用例与待冻结事项见 [对接清单](docs/architecture/cloud-service-integration-checklist.md)。冲突时以插件仓库 PRD v1.3 §6 与架构 §6 为准。

## 文档

| 文档 | 内容 |
|---|---|
| [需求文档](docs/requirements/product-requirements.md) | 范围、功能 C1–C7、NFR、验收、里程碑 |
| [架构设计](docs/architecture/architecture-design.md) | 组件、数据模型、检索、鉴权、媒体、安全、ADR |
| [对接清单](docs/architecture/cloud-service-integration-checklist.md) | 逐接口字段、边界与验收用例 |
| [项目规范](docs/conventions/project-conventions.md) | API、安全、测试、文档与提交约定 |
| [文档总览](docs/ai-context/docs-overview.md) | 阅读顺序与文档索引 |
| [项目结构](docs/ai-context/project-structure.md) | 现状与目标目录、放置规则 |

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
```

授权与联调：

```bash
npm run approve -- ABCD-EFGH   # 控制台批准设备码（需 CONSOLE_TOKEN）
npm test                       # 单元 + 契约测试（自动重置测试库）
```

本地媒体需在 `.env` 设置 `MEDIA_LOCAL_DIR` 指向含 `hls/index.m3u8` 的目录；生产媒体走 CDN，不设该项。配置项与默认值见 `.env.example`，TTL 等临时取值待账号体系定稿后同步文档。

## 目录

```
src/            # Fastify 服务：auth/kb/playback/events/media/http
migrations/     # SQL 迁移（启动时自动执行）
data/seed.json  # 本地种子数据（与插件 mock 对齐）
openapi/        # OpenAPI 3.1 契约
test/           # 单元与契约测试
docs/           # 需求、架构、规范与项目结构
docker/         # 本地数据库初始化
scripts/        # migrate/seed/approve 入口
```

当前为 M2 实现阶段：六个业务接口、设备码授权、签名 HLS、事件接收与契约测试已落地；后台管理、账号体系与内容管线待 M3。
