# AGENTS.md

趋势交易课程云端服务仓库，为 `dsh-plugin-trend-coach` 插件提供课程知识检索、片段元数据、签名 HLS 播放会话、设备码授权、后台账号与内容管理，以及指标事件接收。

当前阶段：**M3 实现阶段**。业务接口、设备码授权、签名 HLS、事件接收、体系与进度接口、账号与后台登录、内容管理 API 与 React 管理端已落地；媒体上传与召回评估待实现。

## 先读这些

1. [需求文档](docs/requirements/product-requirements.md) — 范围、功能、验收、里程碑
2. [架构设计](docs/architecture/architecture-design.md) — 组件、数据模型、检索、媒体、安全
3. [对接清单](docs/architecture/cloud-service-integration-checklist.md) — 逐接口契约
4. [项目规范](docs/conventions/project-conventions.md) — API、安全、测试、提交
5. [项目结构](docs/ai-context/project-structure.md) 与 [文档总览](docs/ai-context/docs-overview.md)

冲突时以插件仓库 PRD v1.3 §6 与插件架构 §6/§9/§10/§12 为准；接口字段先改那两份文档，再同步本仓库。

## 硬约束（写代码前必须确认）

1. **业务面边界**：学员只读知识内容，仅进度上报与事件同意是学员写操作。账号与内容管理只在 `/v1/admin/*`，学员设备令牌不可访问；新增写接口先更新需求与契约。
2. **不做推理**：不托管模型 API Key、不代调大模型；查询 embedding 在云端计算，但对话推理在学员侧 BYOK。
3. **不下发全库**：只返回 Top-K 片段与元数据；不提供全库正文、源站直链或整片下载。
4. **不复用 `ai-invest`**：独立仓库、独立数据库、独立鉴权；只借鉴 `halfvec` + `pg_trgm` + RRF 选型。
5. **凭据边界**：Bearer 只在插件 Host 与云端；浏览器只拿短时效签名 `playlistUrl`。令牌只存哈希，不写日志、不进响应。
6. **鉴权语义**：业务接口必须 `Authorization: Bearer` + `x-device-id`；缺失/过期 `401`，设备不匹配 `403`；刷新同时轮换 access/refresh，旧 refresh 立即失效。后台会话独立于设备令牌：密码 scrypt 哈希、会话与邀请码只存哈希、邀请码单次使用，角色 `student/operator/admin` 分层，学员不可登录后台。
7. **错误语义**：HTTP 状态码承载语义，响应必须是 JSON 对象；禁止 HTML 错误页；结构不合法整体失败，不静默截断或降级为“无结果”。
8. **边界**：`query` 去空白 1–500；`topK` 整数 1–20；`courseId` ≤64 `[A-Za-z0-9._-]`；`segmentId` `^seg-[A-Za-z0-9._-]+$` ≤80；响应 ≤512KiB；`text` ≤4000；标题 ≤200；`relatedKnowledgePoints` ≤5 且仅 `knowledgePointId/title`，不带起止秒或正文。
9. **媒体**：签名 HLS 的 key URI 与分片携带同一 token；媒体域必须 CORS（`GET/OPTIONS`、`Range`、`Content-Type`）与 HTTP Range；过期/无效 token 不可静默黑屏。
10. **隐私**：日志不记 token、完整 query、完整 `deviceId`、完整播放地址；事件必须鉴权、字段白名单、同意后可撤回；不接第三方分析 SDK。
11. **内容与后台**：`/v1/admin/content/*` 仅接受 `operator/admin` 会话；不做物理删除（用 `archived`）；文章只存安全 Markdown 子集（拒绝 HTML/脚本/事件属性），单篇 ≤20000 字符，每次保存 `version+1`；片段正文变更必须清空/重算向量，未配置 embedding 时重建索引返回 `409`；目录树与片段列表不下发起止秒。管理端会话令牌只存 `sessionStorage`，不落 Cookie 或 `localStorage`。
12. **密钥**：不提交 `.env`、证书、密钥、测试视频大文件；部署配置只放注入说明。
13. **契约先行**：任何字段/边界/错误码变更，同步需求 → 架构 → 对接清单 → OpenAPI → 实现 → 契约测试。

## 常用命令

```bash
npm run typecheck
npm test                 # 单元 + 契约测试（重置 trend_coach_test）
npm run build
npm run db:up            # 本地 PostgreSQL + pgvector
npm run migrate          # 启动时也会自动执行
npm run seed
npm run dev              # 127.0.0.1:3939
npm run dev:admin        # 管理端 Vite 开发服务器（/v1 代理到 3939）
curl -X POST localhost:3939/v1/auth/session -H 'content-type: application/json' \
  -d '{"username":"admin01","password":"<初始密码>"}'
```

`npm run build` 先编译服务端再构建管理端，产物在 `dist/admin`；服务端仅在 `dist/admin/index.html` 存在时于 `/admin/` 静态托管。

## 目录

```
src/                 服务实现（accounts/auth/content/kb/playback/events/media/http）
web/admin/           React + Vite 管理端（构建产物 dist/admin）
migrations/          SQL 迁移
data/seed.json       本地种子数据
openapi/             对外契约
test/                单元与契约测试
scripts/             migrate/seed 入口
docs/                需求、架构、规范、结构说明
```

## 改动规则

- 新增接口或字段：先改文档与 OpenAPI，再实现；契约测试覆盖对接清单 §6 对应用例。
- 数据库变更走 `migrations/`，可重复执行、可回滚；staging 先演练。
- 内容发布与索引分离；未审核内容不进入检索；下架用状态位，`segmentId` 不复用。
- 检索或排序变更必须跑自建评估集（≥100 条，Top-5 ≥90%）。
- 注释只写“为什么”；不写多段注释。
- 提交遵循 Conventional Commits，分批提交，提交前检查敏感信息。

## 完成定义

- 相关文档已同步，待冻结事项没有被实现静默定值。
- 类型检查、单元测试、契约测试通过；涉及检索/媒体时附评估集或 Range/CORS 验证结果。
- 新增接口有 OpenAPI 定义与契约测试；错误码与日志脱敏符合规范。
- 不引入新的敏感信息落盘或外发路径。
