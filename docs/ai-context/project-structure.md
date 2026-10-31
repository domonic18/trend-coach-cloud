# 项目结构

版本：v0.1（2026-10-31）

本仓库当前为**文档阶段**：只有文档，服务骨架、数据库 schema、OpenAPI 与部署配置在 M2 落地时补充。本文件描述现状与已确定的目标结构，避免后续实现随意扩散。

## 1. 当前结构

```
trend-coach-cloud/
├── README.md                                  # 仓库定位、边界、接口一览
├── .gitignore
└── docs/
    ├── requirements/
    │   └── product-requirements.md            # 云端需求（范围、功能、验收、里程碑）
    ├── architecture/
    │   ├── architecture-design.md             # 云端架构（组件、数据模型、检索、媒体）
    │   └── cloud-service-integration-checklist.md  # 逐接口契约与验收用例
    ├── conventions/
    │   └── project-conventions.md             # API/安全/测试/文档/提交规范
    └── ai-context/
        ├── project-structure.md               # 本文件
        └── docs-overview.md                   # 文档索引与权威顺序
```

## 2. 目标结构（M2 起）

```
trend-coach-cloud/
├── src/
│   ├── gateway/          # 路由、鉴权中间件、限流、错误映射、request_id
│   ├── auth/             # 设备码、令牌签发/轮换/吊销、设备绑定
│   ├── kb/               # 检索（embedding、混合召回、RRF、阈值）、片段详情
│   ├── playback/         # 播放会话、签名 URL、配额与水印标签
│   ├── events/           # 事件鉴权、白名单校验、同意状态、幂等写入
│   ├── content/          # 内容管线：转写对齐、切分、索引任务（内部）
│   └── shared/           # 契约类型、校验 schema、共享常量
├── db/
│   ├── migrations/       # 可重复执行、可回滚的迁移
│   └── seeds/            # 本地/CI 最小数据集（不含真实版权内容）
├── openapi/
│   └── openapi.yaml      # 唯一契约源
├── test/
│   ├── contract/         # 覆盖对接清单 §6 的契约测试
│   ├── unit/             # 校验、RRF、阈值、签名
│   └── fixtures/         # 与插件 mock 对齐的响应夹具
├── deploy/
│   ├── docker-compose.yml # 本地：PostgreSQL + 对象存储 + 服务
│   └── staging/ production/ # 部署与密钥注入说明（不含密钥）
└── docs/                 # 本文档体系
```

## 3. 放置规则

| 内容 | 位置 |
|---|---|
| 接口契约 | `openapi/openapi.yaml` + 对接清单；代码内不另定义字段 |
| 数据库变更 | `db/migrations/`，命名 `NNNN_description.sql` |
| 检索排序/阈值参数 | 配置项，可调；默认值写进架构文档 |
| 媒体签名逻辑 | `src/playback/`，与 CDN 配置分离 |
| 契约测试夹具 | `test/fixtures/`，与插件 `spike/mock-kb-server.mjs` 的响应形状对齐 |
| 文档 | `docs/<类别>/`，索引见 `docs/ai-context/docs-overview.md` |

## 4. 边界规则

- `content`（内部管线）与学员接口隔离：学员令牌无法访问；写操作只在内部。
- `gateway` 统一做鉴权、限流、错误映射与日志脱敏，业务模块不各自实现。
- `shared` 只放类型与纯函数，不放 I/O；不得依赖具体框架。
- 媒体流量不经业务进程：`playback` 只签发地址，CDN 负责传输。
- 任何新增接口先改文档与 OpenAPI，再写实现与契约测试。

## 5. 与插件仓库的关系

- 插件仓库 `../dsh-plugin-trend-coach`：只保留 mock 与 Host/Client 实现，不含云端实现。
- 插件侧 mock（`spike/mock-kb-server.mjs`）可用于对齐请求/响应形状；云端实现以对接清单为准。
- 契约冲突时，以插件 PRD v1.3 §6 与插件架构 §6 为最终来源。
