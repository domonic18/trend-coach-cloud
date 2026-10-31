# trend-coach-cloud

`dsh-plugin-trend-coach` 的云端服务仓库：提供课程知识检索、片段元数据、签名 HLS 播放会话、设备码授权与指标事件接收。

## 边界

| 提供 | 不提供 |
|---|---|
| 知识库检索（Top-K 片段） | 大模型推理 / API Key 托管 |
| 片段元数据与权威起止秒 | 全库正文下发 |
| 签名 HLS 播放会话 | 直链 / 可下载源站地址 |
| 设备码授权与令牌轮换 | 写接口（一期只读） |
| 鉴权指标事件接收（M2） | 第三方分析 SDK |

不耦合 `ai-invest`：独立实现，只借鉴 PostgreSQL halfvec + pg_trgm + RRF 的技术选型。

## 接口

| 方法与路径 | 用途 |
|---|---|
| `POST /v1/auth/device/code` | 发起设备码授权 |
| `POST /v1/auth/device/token` | 轮询授权结果 |
| `POST /v1/auth/refresh` | 轮换 access/refresh |
| `POST /v1/kb/search` | Top-K 片段检索 |
| `GET /v1/kb/segments/{segmentId}` | 片段详情 |
| `POST /v1/playback/sessions` | 换取签名播放地址 |

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

## 目录

```
docs/requirements/   # 云端需求
docs/architecture/   # 架构设计与对接清单
docs/conventions/    # 项目规范
docs/ai-context/     # 项目结构与文档索引
```

当前为文档阶段。服务骨架、数据库 schema、OpenAPI 文档与部署配置待 M2 按 [项目结构](docs/ai-context/project-structure.md) 补充。
