# 项目结构

版本：v0.4（2026-10-31）

本仓库已进入 M3 实现阶段：单进程模块化单体（Fastify + PostgreSQL/pgvector），业务接口、鉴权、媒体签名、体系与进度、账号与后台登录、内容管理与 React 管理端、契约测试已落地。本文件描述现状与已确定的目标结构，避免后续实现随意扩散。

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
│   └── 003_accounts.sql                       # 账号、后台会话、邀请码
├── data/
│   └── seed.json                              # 本地/CI 种子数据（不含真实版权内容）
├── scripts/
│   ├── migrate.ts                             # npm run migrate [-- --reset]
│   └── seed.ts                                # npm run seed
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
│   ├── playback/                              # 播放会话与 HMAC 签名
│   ├── media/                                 # 本地媒体代理：m3u8 改写、Range
│   ├── catalog/                               # 已发布课程树、知识点详情、文章
│   ├── progress/                              # 学习进度合并与查询
│   ├── content/                               # 内容管理：课程/章节/知识点/文章/片段/重建索引
│   └── events/                                # 事件鉴权、白名单、同意、幂等
├── web/
│   └── admin/                                 # React + Vite 管理端；npm run build 输出 dist/admin
├── test/
│   ├── unit.test.ts                           # 配置、校验、RRF、Range、签名、事件白名单
│   └── contract.test.ts                       # 逐接口契约 + OpenAPI 一致性
└── docs/                                      # 本文档体系
```

## 2. 目标结构（M3 起）

M3 在现有结构上追加，不重排已落地模块：

```
deploy/           # staging/production 部署与密钥注入说明（不含密钥）
```

账号与后台登录已在 `src/accounts/` 落地；内容管理与 React 管理端已在 `src/content/` 与 `web/admin/` 落地。`dist/admin` 为构建产物，仅在存在 `index.html` 时由服务端静态托管于 `/admin/`。

## 3. 放置规则

| 内容 | 位置 |
|---|---|
| 接口契约 | `openapi/openapi.yaml` + 对接清单；代码内不另定义字段 |
| 数据库变更 | `migrations/`，命名 `NNNN_description.sql` |
| 检索排序/阈值参数 | `src/config.ts` 配置项，可调；默认值写进架构文档 |
| 媒体签名逻辑 | `src/playback/`，与 CDN 配置分离 |
| 契约测试夹具 | `data/seed.json`，与插件 `spike/fixtures.json` 的响应形状对齐 |
| 文档 | `docs/<类别>/`，索引见 `docs/ai-context/docs-overview.md` |

## 4. 边界规则

- `content`（内部管线）与学员接口隔离：学员设备令牌无法访问 `/v1/admin/*`；后台写操作只接受 operator/admin 会话。学员写操作仅限进度上报与事件同意。
- `app.ts` 统一做鉴权、限流、错误映射与日志脱敏，业务模块不各自实现。
- `http/` 只放纯校验与请求解析，不放业务状态；不得依赖具体存储。
- 媒体流量不经业务进程：生产由 CDN 传输；`src/media/` 仅本地开发挂载。
- 任何新增接口先改文档与 OpenAPI，再写实现与契约测试。

## 5. 与插件仓库的关系

- 插件仓库 `../dsh-plugin-trend-coach`：只保留 mock 与 Host/Client 实现，不含云端实现。
- 插件侧 mock（`spike/mock-kb-server.mjs`）可用于对齐请求/响应形状；云端实现以对接清单为准。
- 契约冲突时，以插件 PRD v1.3 §6 与插件架构 §6 为最终来源。
