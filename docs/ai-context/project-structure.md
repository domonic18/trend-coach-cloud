# 项目结构

版本：v0.9（2026-11-01）

本仓库已进入 M1 实现阶段：单进程模块化单体（Fastify + PostgreSQL/pgvector），业务接口、鉴权、媒体签名、体系与进度、账号与后台登录、内容管理与 React 管理端、语音转写、视频→课程管线、模型配置（数据库）与契约测试已落地。管线覆盖流式上传、ffmpeg HLS、长音频转写、切分、文章草稿与人工发布；模型连接与密钥由后台「模型配置」录入并加密存库，不再走环境变量（ASR 与 content LLM 已真实链路验证，embedding 仍待密钥）。本文件描述现状与已确定的目标结构，避免后续实现随意扩散。

## 1. 当前结构

```
trend-coach-cloud/
├── README.md
├── AGENTS.md / CLAUDE.md                      # Agent 协作约束
├── package.json / tsconfig*.json
├── .env.example                               # 配置清单（.env 不入库）
├── docker-compose.yml                         # 本地 PostgreSQL 17 + pgvector
├── docker/initdb/01-test-db.sql               # 创建 trend_coach_test
├── migrations/
│   ├── 001_init.sql                           # 表、约束、trgm/HNSW 索引
│   ├── 002_catalog_progress.sql               # 文章、学习进度
│   ├── 003_accounts.sql                       # 账号、后台会话、邀请码
│   ├── 004_pipeline.sql                       # 素材状态、任务、转写、生成
│   └── 005_model_config.sql                   # LLM 多渠道配置、ASR 单行配置
├── data/
│   └── seed.json                              # 本地/CI 种子数据（不含真实版权内容）
├── workspace/                                 # 运行期持久化数据（已 gitignore，不入库）
│   ├── postgres/                              # PostgreSQL 数据
│   ├── pipeline/{storage,hls}/                # 源视频/工作区与 HLS（同一挂载点）
│   ├── caddy/{data,config}/                   # 证书与配置
│   ├── media/                                 # 本地 staging 媒体
│   └── backups/                               # scripts/backup.sh 输出
├── scripts/
│   ├── migrate.ts                             # npm run migrate [-- --reset]
│   ├── seed.ts                                # npm run seed
│   ├── backup.sh / restore.sh                 # 备份与覆盖式恢复（需显式确认）
│   ├── restore-drill.sh                       # 备份导入独立演练库，不触碰业务库
│   └── load-test.mjs                          # 零依赖压测（P95/错误率阈值）
├── openapi/
│   └── openapi.yaml                           # 唯一对外契约源
├── src/
│   ├── index.ts                               # 启动：配置、迁移、监听、优雅退出
│   ├── app.ts                                 # Fastify 装配、错误映射、日志脱敏
│   ├── config.ts                              # 环境变量校验与默认值
│   ├── db.ts / migrate.ts / seed.ts           # 连接、迁移、种子
│   ├── errors.ts / rate-limit.ts
│   ├── accounts/                              # 账号、角色、scrypt 密码、后台会话、邀请码
│   ├── auth/                                  # 设备码、令牌签发/轮换/吊销、设备绑定
│   ├── http/                                  # Bearer/设备头解析、入参校验
│   ├── kb/                                    # 混合召回、RRF、片段详情、embedding
│   ├── playback/                              # 播放会话与 HMAC 签名（只选 ready 素材）
│   ├── media/                                 # 本地媒体代理：m3u8 改写、Range
│   ├── catalog/                               # 已发布课程树、知识点详情、文章
│   ├── progress/                              # 学习进度合并与查询
│   ├── content/                               # 内容管理：课程/章节/知识点/文章/片段/重建索引
│   ├── asr/                                   # 短语音转写（MiniMax）与长音频 verbose 解析
│   ├── pipeline/                              # 素材上传、ffmpeg、转写、生成、任务、发布
│   │   ├── media-store.ts                     # MediaStore 与本地实现
│   │   ├── ffmpeg.ts / media-processor.ts     # 探活、HLS/WAV/静音/切片
│   │   ├── jobs.ts / worker.ts                # DB 任务队列与 ingest/generate worker
│   │   ├── generation.ts / prompts.ts         # 窗口切分、锚定、片段/文章草稿
│   │   ├── service.ts / routes.ts / runtime.ts# DTO、管理端路由、依赖装配
│   │   └── {types,ids,text,silence,chunks,transcript,constants}.ts
│   ├── model-config/                          # 模型配置：DB 存储、AES-256-GCM、连通性测试
│   │   ├── crypto.ts                          # 密钥派生、密文加解密、掩码
│   │   ├── service.ts                         # LLM 多渠道/ASR 单行 CRUD 与运行时解析
│   │   └── routes.ts                          # /v1/admin/model-configs/*（仅 admin）
│   └── events/                                # 事件鉴权、白名单、同意、幂等
├── web/
│   └── admin/                                 # React + Vite 管理端；含「视频建课」「模型配置」页
├── test/
│   ├── unit.test.ts                           # 配置、校验、RRF、Range、签名、事件白名单、密钥加解密
│   ├── migration.test.ts                      # 管线与模型配置表/列/约束/索引
│   ├── pipeline-unit.test.ts                  # 切块、时间戳合并、锚定、ID
│   ├── pipeline-provider.test.ts              # 长音频 ASR 与 LLM 假上游
│   ├── pipeline-ffmpeg.test.ts                # RUN_FFMPEG_TESTS=1 时跑真实 ffmpeg
│   ├── pipeline-e2e.test.ts                   # 假处理器 ingest→生成→apply→发布
│   └── contract.test.ts                       # 逐接口契约 + OpenAPI 一致性（含模型配置）
└── docs/                                      # 本文档体系
```

管线存储（`workspace/` 整体 gitignore；容器内为 `/data/storage` 与 `/data/hls`）：

```text
workspace/pipeline/storage/sources/<assetId>/source
workspace/pipeline/storage/work/<assetId>/{audio.wav,chunks/,hls/}
workspace/pipeline/hls/hls/<assetId>/{index.m3u8,seg_00000.ts}
```

## 2. 目标结构（M1/M3 之后）

在现有结构上追加，不重排已落地模块：

```
deploy/           # staging/production 部署与密钥注入说明（不含密钥）
```

账号与后台登录已在 `src/accounts/` 落地；内容管理与 React 管理端已在 `src/content/` 与 `web/admin/` 落地；视频管线已在 `src/pipeline/` 落地。`dist/admin` 为构建产物，仅在存在 `index.html` 时由服务端静态托管于 `/admin/`。

## 3. 放置规则

| 内容 | 位置 |
|---|---|
| 接口契约 | `openapi/openapi.yaml` + 对接清单；代码内不另定义字段 |
| 数据库变更 | `migrations/`，命名 `NNNN_description.sql` |
| 检索排序/阈值参数 | `src/config.ts` 配置项，可调；默认值写进架构文档 |
| 媒体签名逻辑 | `src/playback/`，与 CDN 配置分离 |
| 管线任务与生成 | `src/pipeline/`；任务表见 `004_pipeline.sql`，不把业务状态塞进 `options` |
| 模型连接与密钥 | `src/model-config/`；表见 `005_model_config.sql`（`006_llm_protocol.sql` 放开 anthropic）；密钥只存 AES-256-GCM 密文，不读环境变量、不回显明文；content 支持 openai 兼容与 anthropic Messages，embedding 仅 openai |
| 源视频与 HLS | `workspace/pipeline/{storage,hls}`（已 gitignore）；容器内由 `/data` 单挂载点提供，两目录必须同卷 |
| 契约测试夹具 | `data/seed.json`，与插件 `spike/fixtures.json` 的响应形状对齐 |
| 文档 | `docs/<类别>/`，索引见 `docs/ai-context/docs-overview.md` |

## 4. 边界规则

- `content`（内部管线）与学员接口隔离：学员设备令牌无法访问 `/v1/admin/*`；后台写操作只接受 operator/admin 会话。学员写操作仅限进度上报与事件同意。
- `app.ts` 统一做鉴权、限流、错误映射与日志脱敏，业务模块不各自实现。
- `http/` 只放纯校验与请求解析，不放业务状态；不得依赖具体存储。
- 媒体流量不经业务进程：生产由 CDN 传输；`src/media/` 仅本地开发挂载。
- 管线接口全部位于 `/v1/admin/content/*` 的公开路由内，只接受 operator/admin 会话；学员令牌不可访问。
- 生成内容只写 `draft`；`publish` 是唯一进入学员可见性的入口，配置 embedding 时必须先成功 `reindex`。
- 源路径、HLS 路径、SHA、转写正文、provider 响应不进管理端列表/预览响应与日志。
- 模型配置接口只在 `/v1/admin/model-configs/*`，仅 admin；响应只含掩码，密文与明文都不进日志。
- ASR/内容 LLM/embedding 在每次使用时按用途从数据库解析，后台保存后立即生效，无需重启。
- 任何新增接口先改文档与 OpenAPI，再写实现与契约测试。

## 5. 与插件仓库的关系

- 插件仓库 `../dsh-plugin-trend-coach`：只保留 mock 与 Host/Client 实现，不含云端实现。
- 插件侧 mock（`spike/mock-kb-server.mjs`）可用于对齐请求/响应形状；云端实现以对接清单为准。
- 契约冲突时，以插件 PRD v1.3 §6 与插件架构 §6 为最终来源。
