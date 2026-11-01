# AGENTS.md

趋势交易课程云端服务仓库，为 `dsh-plugin-trend-coach` 插件提供课程知识检索、片段元数据、签名 HLS 播放会话、设备码授权、后台账号与内容管理，以及指标事件接收。

当前阶段：**M1 实现阶段**。业务接口、设备码授权、签名 HLS、事件接收、体系与进度接口、账号与后台登录、内容管理 API 与 React 管理端、语音转写已落地（真实 MiniMax 待后台录入密钥）；M1 视频→课程管线（流式上传、ffmpeg 转码、带时间戳长音频转写、章节/知识点/片段切分、文章草稿生成、人工审核与发布）已落地，真实 ASR 与内容 LLM 需在后台「模型配置」录入密钥后验收；召回评估与多码率 HLS 后置。

## 先读这些

1. [需求文档](docs/requirements/product-requirements.md) — 范围、功能、验收、里程碑
2. [架构设计](docs/architecture/architecture-design.md) — 组件、数据模型、检索、媒体、语音、安全
3. [对接清单](docs/architecture/cloud-service-integration-checklist.md) — 逐接口契约
4. [项目规范](docs/conventions/project-conventions.md) — API、安全、测试、提交
5. [项目结构](docs/ai-context/project-structure.md) 与 [文档总览](docs/ai-context/docs-overview.md)

冲突时以插件仓库 PRD v1.6 §6 与插件架构 v1.6 §6/§9/§10/§12 为准；接口字段先改那两份文档，再同步本仓库。

## 硬约束（写代码前必须确认）

1. **业务面边界**：学员只读知识内容，仅进度上报与事件同意是学员写操作。账号与内容管理只在 `/v1/admin/*`，学员设备令牌不可访问；新增写接口先更新需求与契约。
2. **模型能力边界**：学员侧禁止任何生成式推理，对话推理在学员侧 BYOK；查询 embedding 在云端计算。云端允许的模型能力仅限：语音转写（ASR，MiniMax）、embedding，以及仅管理端内容生产使用的内容 LLM（章节/知识点/文章草稿）。连接信息与密钥存数据库（AES-256-GCM 加密，仅 admin 后台维护），明文不进浏览器、插件、日志或响应；生成内容必须人工审核后显式发布，禁止自动发布。学员语音转写音频与纯文本不落盘；内容生产所需的源视频、转写与生成草稿按管线规则持久化。
3. **不下发全库**：只返回 Top-K 片段与元数据；不提供全库正文、源站直链或整片下载。
4. **不复用 `ai-invest`**：独立仓库、独立数据库、独立鉴权；只借鉴 `halfvec` + `pg_trgm` + RRF 选型。
5. **凭据边界**：Bearer 只在插件 Host 与云端；浏览器只拿短时效签名 `playlistUrl`。令牌只存哈希，不写日志、不进响应。
6. **鉴权语义**：业务接口必须 `Authorization: Bearer` + `x-device-id`；缺失/过期 `401`，设备不匹配 `403`；刷新同时轮换 access/refresh，旧 refresh 立即失效。后台会话独立于设备令牌：密码 scrypt 哈希、会话与邀请码只存哈希、邀请码单次使用，角色 `student/operator/admin` 分层，学员不可登录后台。
7. **错误语义**：HTTP 状态码承载语义，响应必须是 JSON 对象；禁止 HTML 错误页；结构不合法整体失败，不静默截断或降级为“无结果”。
8. **边界**：`query` 去空白 1–500；`topK` 整数 1–20；`courseId` ≤64 `[A-Za-z0-9._-]`；`segmentId` `^seg-[A-Za-z0-9._-]+$` ≤80；响应 ≤512KiB；`text` ≤4000；标题 ≤200；`relatedKnowledgePoints` ≤5 且仅 `knowledgePointId/title`，不带起止秒或正文。
9. **媒体**：签名 HLS 的 key URI 与分片携带同一 token；媒体域必须 CORS（`GET/OPTIONS`、`Range`、`Content-Type`）与 HTTP Range；过期/无效 token 不可静默黑屏。
10. **隐私**：日志不记 token、完整 query、完整 `deviceId`、完整播放地址；事件必须鉴权、字段白名单、同意后可撤回；不接第三方分析 SDK。
11. **内容与后台**：`/v1/admin/content/*` 仅接受 `operator/admin` 会话；不做物理删除（用 `archived`）；文章只存安全 Markdown 子集（拒绝 HTML/脚本/事件属性），单篇 ≤20000 字符，每次保存 `version+1`；片段正文变更必须清空/重算向量，未配置 embedding 时重建索引返回 `409`；目录树与片段列表不下发起止秒。管理端会话令牌只存 `sessionStorage`，不落 Cookie 或 `localStorage`。
12. **视频管线**：`/v1/admin/content/media-assets`、`/pipeline/*`、`/generations/*` 与 `publish` 同属管理端；一次上传流式写盘（≤2GiB），ffprobe 必须同时有视频与音频流；ffmpeg/ffprobe 一律 `spawn` 参数数组、禁止 shell；源文件路径、HLS 路径、SHA 与 provider 原始响应不入响应与日志；转写正文只经管理端转写接口返回。生成阶段只写 `draft`，`publish` 必须显式调用且先建索引；取消/重试/心跳恢复不得产生重复 active job。源视频与转写默认保留，清理策略未冻结前不自动删除。
13. **密钥**：不提交 `.env`、证书、密钥、测试视频大文件；部署配置只放注入说明。
14. **契约先行**：任何字段/边界/错误码变更，同步需求 → 架构 → 对接清单 → OpenAPI → 实现 → 契约测试。

## 常用命令

```bash
npm run typecheck
npm test                 # 单元 + 契约测试（重置 trend_coach_test）
RUN_FFMPEG_TESTS=1 npm test   # 额外跑真实 ffmpeg 合成视频用例（需本机 ffmpeg/ffprobe）
npm run build
npm run db:up            # 本地 PostgreSQL + pgvector
npm run migrate          # 启动时也会自动执行
npm run seed
npm run dev              # 127.0.0.1:3939
npm run dev:admin        # 管理端 Vite 开发服务器（/v1 代理到 3939）
npm run loadtest         # 无依赖压测（默认 /health，阈值见 docs/operations/monitoring.md）
scripts/restore-drill.sh # 备份导入独立演练库，不触碰业务库
curl -X POST localhost:3939/v1/auth/session -H 'content-type: application/json' \
  -d '{"username":"admin01","password":"<初始密码>"}'
```

`npm run build` 先编译服务端再构建管理端，产物在 `dist/admin`；服务端仅在 `dist/admin/index.html` 存在时于 `/admin/` 静态托管。

## 目录

```
src/                 服务实现（accounts/auth/content/kb/playback/events/media/asr/pipeline/http）
web/admin/           React + Vite 管理端（构建产物 dist/admin）
migrations/          SQL 迁移（004 为视频管线）
data/seed.json       本地种子数据
workspace/           运行期持久化数据（gitignore；postgres/pipeline/caddy/media/backups）
openapi/             对外契约
test/                单元、契约与管线 E2E
scripts/             migrate/seed 入口
docs/                需求、架构、规范、结构说明
```

管线存储（默认 `workspace/pipeline/storage` 与 `workspace/pipeline/hls`，容器内为 `/data/storage` 与 `/data/hls`）：`sources/<assetId>/source` 存源视频，`work/<assetId>/` 为转码工作区，`hls/<assetId>/` 为对外签名的 HLS。源目录不得位于媒体根下；两目录需同卷以支持原子 rename。所有持久化数据一律落在 `workspace/`，不得写入其他仓库路径或提交入库。

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
