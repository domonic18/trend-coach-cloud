# 云端服务对接清单

本文用于启动**独立的云端服务仓库**，供 `dsh-plugin-trend-coach` 插件对接。接口口径以 PRD v0.5 §6 与架构 v0.6 §6、§7、§9、§10、§12 为准；冲突时先改那两份文档，再同步本文。v0.3 新增门户与 AI 运营接口（§3.11、§3.12）。

## 1. 边界

云端只提供课程知识与内容服务，不承担推理（学员 BYOK）。

| 提供 | 不提供 |
|---|---|
| 知识库检索（Top-K 片段） | 大模型推理 / API Key 托管 |
| 片段元数据与权威起止秒 | 全库正文下发 |
| 签名 HLS 播放会话 | 直链 / 可下载源站地址 |
| 设备码授权与令牌轮换 | 学员侧内容写接口（一期只读） |
| 鉴权指标事件接收（M2） | 第三方分析 SDK |
| 语音转写（M4.2，MiniMax ASR，仅语音→文字） | 学员侧生成式推理 |
| 视频→课程管线（M1/M8）：上传、转码、长音频转写、切分、章节教材与图示草稿、人工发布 | 多码率 ABR、对象存储、断点续传、自动发布 |
| 公开门户、自助注册/登录与个人中心（M7） | 邮件/短信验证、找回密码、客服工单 |
| AI 用量、运行链路、任务级主备绑定与自动切换（M7） | 学员侧推理、第三方分析 SDK |

**不耦合 ai-invest**：不进其库、不调其服务、不共享代码与数据；只借鉴 PostgreSQL halfvec + pg_trgm + RRF 的技术选型（PRD D2）。

**内容生产管线现状（2026-11-01）**：M1 视频→课程管线已落地，覆盖素材上传、单码率 HLS、带时间戳长音频转写、章节/知识点/片段切分、文章草稿与人工发布；真实 MiniMax ASR、内容 LLM 与 1024 维 embedding 均已通过链路验收。M8 设计已定：阅读层改为章节教材并新增图示（关键帧 + 文生图），学员体系契约升级到 `contractVersion=2`；旧课程直接作废重跑。

## 2. 通用约定

- 传输：HTTPS，`Content-Type: application/json`；响应必须是 JSON 对象，否则插件整体失败。
- 鉴权：业务接口携带 `Authorization: Bearer <accessToken>` 与 `x-device-id: <deviceId>`；缺失/过期 `401`，设备不匹配 `403`。门户接口用门户会话 Bearer（无 `x-device-id`）；后台接口用后台会话 Bearer。门户会话 `scope=portal`，不可访问 `/v1/admin/*`。
- 时间：`expiresAt` 为毫秒时间戳；`startSec/endSec` 为整数秒。
- ID：`segmentId` 形如 `seg-[A-Za-z0-9._-]+` 且 ≤80；`courseId` ≤64 且仅 `[A-Za-z0-9._-]`；`chapterId/knowledgePointId` 非空且稳定。
- 错误：HTTP 状态码承载语义（`400/401/403/404/429/5xx`），响应体建议 `{ "error": "string" }`（待冻结）；不得返回 HTML 错误页。
- 限流：按用户/设备/IP 限流，超限返回 `429` 且带 `Retry-After: 60`；响应体不泄露内部配额细节。设备码按 IP、设备轮询按设备码、刷新与检索/进度/事件/ASR/体系读取按设备、后台内容与管线按账号；完整矩阵见架构 §9.1。
- 日志：不记录 token、完整 query、完整 deviceId；如必须排障，使用截断前缀。
- 可用性：知识/视频服务 ≥ 99.5%；检索 P95 ≤ 300ms（云端侧指标）。

## 3. 接口清单

### 3.1 设备码授权

| 方法与路径 | 请求 | 响应 |
|---|---|---|
| `POST /v1/auth/device/code` | `{ clientId, deviceId }` | `{ deviceCode, userCode, verificationUri, expiresIn, interval }` |
| `POST /v1/auth/device/token` | `{ deviceCode }` | `{ status: "pending" } \| { status: "expired" } \| { status: "authorized", grant }` |
| `POST /v1/auth/refresh` | `{ refreshToken, deviceId }` | `grant`；旧 refresh 立即失效 |
| `POST /v1/auth/revoke` | 无（Bearer + `x-device-id`） | `{ revoked: true }`；该设备全部令牌吊销，重新授权可恢复 |
| `POST /v1/auth/device/approve` | 学员：`{ userCode, username, password }` 或 `{ userCode, inviteCode, password }`；运营/管理员：后台会话 Bearer + `{ userCode, userId? }` | `{ approved: true }`；设备绑定到账号 |

`grant` 结构：

```jsonc
{ "accessToken": "string", "refreshToken": "string", "expiresAt": 0, "deviceId": "string" }
```

- `clientId` 固定为 `dsh-plugin-trend-coach`；`deviceId` 由插件首启随机生成并持久绑定。
- `expiresIn/interval` 单位为秒；`interval` 是轮询间隔。
- 刷新必须轮换 access/refresh 双令牌；旧 refresh 复用返回 `401`；设备不匹配返回 `403`。
- 注销为设备级：吊销本设备全部令牌并置 `revoked`，不影响同账号其它设备；管理员可禁用账号，禁用后设备令牌与后台会话立即失效。
- 批准必须绑定已存在账号；不存在账号或密码错误 `401`，设备码无效/过期 `404`。学员令牌不能代批。
- 待决策：access/refresh TTL、并发设备上限、多设备登录策略（架构 §15.1）。

### 3.2 检索

```http
POST /v1/kb/search
Authorization: Bearer <token>
x-device-id: <deviceId>
Content-Type: application/json

{ "query": "...", "topK": 5, "courseId": "optional" }
```

请求边界：`query` 去首尾空白后 1–500 字符；`topK` 整数 1–20；`courseId` 可选且符合白名单。越界返回 `400`。

响应：

```jsonc
{
  "segments": [{
    "segmentId": "seg-...",
    "courseId": "TC-101",
    "chapterId": "M1",
    "knowledgePointId": "KP-1.1",
    "title": "string",
    "courseTitle": "string | undefined",
    "chapterTitle": "string | undefined",
    "knowledgePointTitle": "string | undefined",
    "startSec": 0,
    "endSec": 0,
    "text": "string",
    "score": 0.0
  }],
  "relatedKnowledgePoints": [{ "knowledgePointId": "string", "title": "string" }]
}
```

硬约束：

- `score ∈ [0,1]`；`startSec < endSec`；`segmentId` 全局唯一且跨版本稳定；下架后 `GET` 返回 `404`。
- `text ≤4000` 字符；`title` 与展示标题 1–200 字符；单次响应 `≤512KiB`；越界或结构不合法整体失败，不静默截断。
- `relatedKnowledgePoints ≤5` 条，仅在空召回或最高分低于阈值时填充；**只给 `knowledgePointId/title`**，不得携带起止秒或正文。
- 只返回 Top-K 片段与元数据，不下发全库正文；查询 embedding 在云端计算。
- 响应不需要回显 `query`。

### 3.3 片段详情

```http
GET /v1/kb/segments/{segmentId}
Authorization: Bearer <token>
x-device-id: <deviceId>
```

- 返回单个 `Segment`（字段同上，`score` 可为 `1`），必须包含展示标题（若上游有）。
- 插件以此接口的 `startSec/endSec` 为权威定位依据；不存在或已下架返回 `404`。

### 3.4 播放会话

```http
POST /v1/playback/sessions
Authorization: Bearer <token>
x-device-id: <deviceId>
Content-Type: application/json

{ "segmentId": "seg-..." }
```

响应：

```jsonc
{
  "sessionId": "string",
  "playlistUrl": "https://media.example.com/hls/index.m3u8?token=...",
  "expiresAt": 1760000000000,
  "watermark": { "label": "学员 1001" }
}
```

- `playlistUrl` 为短时效签名地址；m3u8 内 key URI 与分片地址携带同一 token；浏览器不持 Bearer。
- `expiresAt` 至少覆盖一个片段播放窗口（60s）；推荐 5–10 分钟。
- 媒体域必须允许 CORS（至少 `GET/OPTIONS`、`Range`、`Content-Type`），并支持 HTTP Range。
- 播放地址绑定设备与并发数，超限拒绝；播放中过期由 hls.js 报网络错误，插件给出可读提示。
- `watermark.label` 用于客户端动态水印，建议包含用户标识但不得包含敏感信息。

### 3.5 体系与进度（M3）

本小节为 M3 契约，已进入 OpenAPI 与实现；后台管理接口不在本条范围内。

```http
GET /v1/catalog/courses
GET /v1/catalog/courses/{courseId}
GET /v1/catalog/courses/{courseId}/chapters/{chapterId}   # M8 新增
GET /v1/catalog/knowledge-points/{knowledgePointId}
PUT /v1/progress/knowledge-points/{knowledgePointId}
Authorization: Bearer <token>
x-device-id: <deviceId>
```

课程列表响应：

```jsonc
{
  "courses": [{
    "courseId": "string",
    "title": "string",
    "chapterCount": 3,
    "knowledgePointCount": 24,
    "completedCount": 5
  }]
}
```

课程树响应（知识点内联进度；**不内联章节正文**，按需拉取）：

```jsonc
{
  "contractVersion": 2,
  "courseId": "string",
  "title": "string",
  "chapters": [{
    "chapterId": "string",
    "title": "string",
    "position": 0,
    "hasArticle": true,
    "figureCount": 2,
    "knowledgePoints": [{
      "knowledgePointId": "string",
      "title": "string",
      "position": 0,
      "segmentId": "seg-...",
      "watchedSec": 120,
      "completed": false
    }]
  }]
}
```

章节教材响应（M8 新增；正文中的 `![alt](figure:<figureId>)` 由插件替换为 `figures[figureId].url`）：

```jsonc
{
  "chapterId": "string",
  "courseId": "string",
  "title": "string",
  "article": {
    "markdown": "# 章标题\n\n...\n\n![均线交叉示意](figure:fig_ab12cd34_f1)\n",
    "version": 1,
    "publishedAt": 1760000000000
  },
  "figures": {
    "fig_ab12cd34_f1": {
      "url": "https://media.example.com/figures/fig_ab12cd34_f1/cand_1.jpg?expires=1760000600&sig=...",
      "width": 1600,
      "height": 900,
      "alt": "均线交叉示意",
      "caption": "均线交叉示意"
    }
  },
  "adjacentChapters": [{ "chapterId": "string", "title": "string" }]
}
```

知识点详情响应（**不再返回文章**，仅定位与相邻导航）：

```jsonc
{
  "knowledgePointId": "string",
  "courseId": "string",
  "chapterId": "string",
  "title": "string",
  "segmentId": "seg-...",
  "adjacentKnowledgePoints": [{ "knowledgePointId": "string", "title": "string" }]
}
```

进度上报请求与响应：

```jsonc
// PUT /v1/progress/knowledge-points/{knowledgePointId}
{ "watchedSec": 120, "completed": false }

// 200
{ "knowledgePointId": "string", "watchedSec": 120, "completed": false, "updatedAt": 1760000000000 }
```

- 只下发 `published` 内容；未发布或不存在 `404`。章节 `article` 可为 `null`（生成失败或未发布）；`segmentId` 可缺省。
- `contractVersion` 为整数，M8 起为 `2`；插件低于最低支持版本时提示升级，不静默降级。缺失 `contractVersion` 视为 `1`。
- 章节教材只允许 Markdown 子集与 `figure:<figureId>` 图片引用；`figures` 中每个 `url` 为短时签名（默认 10 分钟），过期后重新请求本章接口换取。
- 图示仅返回 `published` 且已选候选；引用缺失时服务端保证不会发布，因此正常响应中 `markdown` 的每个 `figure:` 引用都能在 `figures` 中命中。
- 课程树不携带 `startSec/endSec`；播放定位仍以 `GET /v1/kb/segments/{segmentId}` 为准。
- 边界：课程 ≤50；单课程 ≤50 章节、总知识点 ≤1000；标题 ≤200 字符；单章正文 1500–3000 字、≤20000 字符；每章 ≤3 图；响应 ≤512KiB；图片单张 ≤8MiB、边缘 ≥800px。
- 进度按当前用户与设备写入；`watchedSec` 整数秒 0–86400，取历史最大值；`completed` 为 `true` 后不可回退；重复上报幂等。
- 进度属于业务写入，不走 `POST /v1/events`，不受指标同意开关影响；非本人设备 `403`，超限 `429`。
- 后台管理接口不属于本契约，学员令牌不可访问。

### 3.6 账号与后台登录（M3.1）

```http
POST /v1/auth/invite/redeem          # 公开；一次性邀请码设置密码
POST /v1/auth/session                # 后台登录（operator/admin）
GET  /v1/auth/session                # 当前后台账号
DELETE /v1/auth/session              # 注销当前后台会话
POST /v1/auth/session/password       # 自助改密
GET  /v1/admin/users                 # operator/admin
POST /v1/admin/users                 # admin
PATCH /v1/admin/users/{userId}       # admin
POST /v1/admin/users/{userId}/reset  # admin；生成邀请码或直接设密码
```

请求/响应：

```jsonc
// POST /v1/auth/invite/redeem
{ "inviteCode": "XXXX-XXXX-XXXX-XXXX", "password": "至少 10 个字符" }
// 200
{ "redeemed": true }

// POST /v1/auth/session（仅 operator/admin）
{ "username": "ops01", "password": "..." }
// 200
{ "token": "string", "expiresAt": 1760000000000,
  "user": { "userId": "usr_...", "username": "ops01", "displayName": "运营一号", "role": "operator" } }

// GET /v1/admin/users?query=&role=&status=&offset=0&limit=50
{ "users": [{ "userId": "usr_...", "username": "stu01", "displayName": "学员一号",
              "role": "student", "status": "active", "deviceCount": 1,
              "createdAt": 1760000000000, "lastActiveAt": 1760000000000 }],
  "total": 1, "offset": 0, "limit": 50 }

// POST /v1/admin/users
{ "username": "stu01", "displayName": "学员一号", "role": "student", "password": "可选" }
// 201；未提供 password 时返回一次性邀请码
{ "user": { ... }, "inviteCode": "XXXX-XXXX-XXXX-XXXX", "inviteExpiresAt": 1760000000000 }

// PATCH /v1/admin/users/{userId}
{ "displayName": "可选", "role": "可选", "status": "active|disabled" }

// POST /v1/admin/users/{userId}/reset
{ "password": "可选" }
// 有 password → { "updated": true }；否则 → { "inviteCode": "...", "inviteExpiresAt": 0 }
```

- `username` 3–32，小写字母开头，`[a-z0-9._-]`，全局唯一；`displayName` 1–200；密码 10–128。
- 邀请码默认 7 天、单次使用；同一账号新邀请码使未使用旧码失效；明文只出现一次。
- 后台会话默认 12 小时，只存哈希；注销、改密、禁用、角色变更即吊销。学员登录后台会话返回 `403`。
- `GET /v1/admin/users` 的 `query` ≤100 字符，`role/status` 为枚举，`offset` 0–100000，`limit` 1–100。
- 账号写操作仅 `admin`；读列表 `operator/admin` 均可；禁止管理员禁用/降级自己，禁止移除最后一个 active admin。
- 学员令牌访问 `/v1/admin/*` 返回 `403`；未登录 `401`。后台会话不属于 OpenAPI 的 `bearerAuth` 设备令牌方案（见 `sessionAuth`）。
- 登录、邀请码兑换与设备批准按 IP 限流，超限 `429`。

### 3.7 内容管理（M3.2）

```http
GET   /v1/admin/content/courses
POST  /v1/admin/content/courses
PATCH /v1/admin/content/courses/{courseId}
GET   /v1/admin/content/courses/{courseId}                  # 课程树
POST  /v1/admin/content/courses/{courseId}/chapters
PATCH /v1/admin/content/courses/{courseId}/chapters/{chapterId}
POST  /v1/admin/content/courses/{courseId}/chapters/{chapterId}/knowledge-points
PATCH /v1/admin/content/knowledge-points/{knowledgePointId}
GET   /v1/admin/content/courses/{courseId}/chapters/{chapterId}/article   # M8
PUT   /v1/admin/content/courses/{courseId}/chapters/{chapterId}/article   # M8
GET   /v1/admin/content/segments
POST  /v1/admin/content/segments
PATCH /v1/admin/content/segments/{segmentId}
POST  /v1/admin/content/reindex
```

请求/响应：

```jsonc
// GET /v1/admin/content/courses
{ "courses": [{ "courseId": "TC-101", "title": "趋势交易基础", "status": "draft",
                "chapterCount": 3, "knowledgePointCount": 6,
                "segmentCount": 8, "chapterArticleCount": 3, "figureCount": 5 }] }

// POST /v1/admin/content/courses
{ "courseId": "TC-101", "title": "趋势交易基础", "status": "draft" }
// 201 → { "course": { "courseId": "TC-101", "title": "...", "status": "draft" } }
// PATCH 同路径，body 可含 title/status

// GET /v1/admin/content/courses/{courseId}
{ "course": { "courseId": "TC-101", "title": "...", "status": "published" },
  "chapters": [{ "chapterId": "M1", "title": "第一章", "position": 1,
    "article": { "version": 3, "status": "published", "publishedAt": 1760000000000 },
    "figureCount": 2,
    "knowledgePoints": [{ "knowledgePointId": "KP-1.1", "title": "...", "position": 1,
      "segmentCount": 2 }] }] }

// POST /v1/admin/content/courses/{courseId}/chapters
{ "chapterId": "M4", "title": "第四章", "position": 4 }
// PATCH /v1/admin/content/courses/{courseId}/chapters/{chapterId} → title/position

// POST /v1/admin/content/courses/{courseId}/chapters/{chapterId}/knowledge-points
{ "knowledgePointId": "KP-4.1", "title": "知识点标题", "position": 1 }
// PATCH /v1/admin/content/knowledge-points/{knowledgePointId} → title/position

// GET /v1/admin/content/courses/{courseId}/chapters/{chapterId}/article
{ "article": { "markdown": "# 标题\n\n正文…\n\n![示意图](figure:fig_ab12cd34_f1)",
               "version": 2, "status": "draft", "publishedAt": null } }
// 未创建时 → { "article": null }
// PUT：{ "markdown": "...", "status": "draft|published|archived" }；每次保存 version+1
// 正文中的图片引用只接受 ![alt](figure:<figureId>)，且 figureId 必须属于该章节；否则 400

// GET /v1/admin/content/segments?courseId=&knowledgePointId=&status=&query=&offset=0&limit=50
{ "segments": [{ "segmentId": "seg-tc101-m1-kp1-1", "courseId": "TC-101",
    "chapterId": "M1", "knowledgePointId": "KP-1.1", "title": "...",
    "startSec": 192, "endSec": 400, "text": "...", "status": "published",
    "hasEmbedding": true }], "total": 1, "offset": 0, "limit": 50 }

// POST /v1/admin/content/segments
{ "segmentId": "seg-tc101-m4-kp1-1", "courseId": "TC-101", "chapterId": "M4",
  "knowledgePointId": "KP-4.1", "title": "...", "startSec": 0, "endSec": 120,
  "text": "...", "status": "draft" }
// PATCH /v1/admin/content/segments/{segmentId} → title/startSec/endSec/text/status

// POST /v1/admin/content/reindex
{ "courseId": "可选；缺省重建全部" } → { "embedded": 8 }
```

- 全部接口要求 operator/admin 会话；账号管理仍仅 admin。学员令牌 `403`，未登录 `401`。
- `courseId`、`chapterId`、`knowledgePointId` 1–64、`[A-Za-z0-9._-]`；`segmentId` `^seg-[A-Za-z0-9._-]{1,76}$`；标题 1–200；片段文本 1–4000。
- `startSec` 0–86400、`endSec` 1–86400，且 `startSec < endSec`；`position` 0–10000 整数；状态仅 `draft/published/archived`。
- 片段写入时业务校验知识点存在且归属该课程/章节；文本变更立即清空 `embedding`，避免旧向量参与检索置信。
- 章节教材 `markdown` 1–20000（建议 1500–3000），拒绝 `<script>`、`<iframe>`、`<object>`、`<embed>`、`<style>`、事件属性与 `javascript:`/`data:text/html`；图片引用只认 `figure:` 白名单格式；每次保存 `version + 1`，发布时写 `publishedAt`。
- 知识点不再有独立文章；M8 前的 `/knowledge-points/{id}/article` 接口移除，旧 `articles` 数据只读保留。
- 课程、章节、知识点、片段、章节教材、图示不提供物理删除；用 `archived` 下架。课程 `archived` 后其下内容对学员不可见；删除被正文引用的图示 `409 figure_in_use`。
- `GET /v1/admin/content/segments` 的 `query` 对标题/文本做 ILIKE，`query` ≤100；`offset` 0–100000，`limit` 1–100。
- `POST /v1/admin/content/reindex` 未配置 embedding 返回 `409`；按课程重建时课程不存在返回 `404`。
- 控制台 `/admin` 静态资源不属于 OpenAPI；会话令牌只存 `sessionStorage`，退出清除。


### 3.8 语音转写（M4.2）

```http
POST /v1/asr/transcribe
Authorization: Bearer <device accessToken>
x-device-id: <deviceId>
Content-Type: application/json
```

```jsonc
// 请求
{ "audio": "<base64 WAV>", "format": "wav", "durationMs": 12000 }
// 成功
{ "text": "趋势反转的初步信号是什么？", "durationMs": 12000 }
```

- 路由级 `bodyLimit: 3 * 1024 * 1024`；body 严格校验、`additionalProperties: false`；`format` 仅 `wav`。
- 音频：RIFF/WAVE、PCM（format=1）、单声道、16000Hz、16bit；解码后 ≤1,920,044B；`durationMs` 整数 1–60,000；`data` 字节换算时长与 `durationMs` 误差 ≤1s。
- 文本：去控制字符、折叠空白、trim 后 1–2000 字符；空结果 `422`。
- 上游：MiniMax `POST {base}/v1/speech_to_text`（Bearer；multipart `file=audio/wav` + `model` + `response_format=json`）；`base_resp.status_code != 0` 视为协议错误。
- 未配置或未启用 ASR：鉴权后 `503`；ASR 连接信息由后台「模型配置」维护（见 §3.10），缺失不阻止服务启动。
- 限流：按设备 `RATE_LIMIT_ASR_PER_MINUTE`（默认 20）；不自动重试上游。
- 错误：`400` 入参/音频非法；`401/403` 鉴权；`413` 过大；`422` 未识别；`429` 限流；`502` 上游协议异常；`503` 上游不可用/未配置。

**验收用例**

| 用例 | 期望 |
|---|---|
| 合法 WAV（16k/mono/PCM16，≤60s） | `200`，`text` 清洗后非空，`durationMs` 回显 |
| 未鉴权 / 设备不匹配 | `401` / `403` |
| 非法 base64、非 WAV、立体声、44.1k、8bit、data 长度或时长不符 | `400` |
| 请求体 >3MiB 或音频 >1,920,044B | `413` |
| 上游返回空文本 / `base_resp.status_code != 0` | `422` / `502` |
| 上游 429 / 5xx / 超时 | `429` / `503`，插件提示重试，云端不自动重试 |
| 超过按设备限流 | `429` |
| 未配置或未启用 ASR | `503` |
| 日志抽查 | 无 base64、无转写正文、无完整 deviceId |

### 3.9 视频→课程管线（M1）

全部接口位于 `/v1/admin/content/*`，要求 operator/admin 后台会话（`Authorization: Bearer <session token>`，不带 `x-device-id`）。

```http
GET   /v1/admin/content/media-assets
POST  /v1/admin/content/media-assets
PATCH /v1/admin/content/media-assets/{assetId}
PUT   /v1/admin/content/media-assets/{assetId}/source
POST  /v1/admin/content/media-assets/{assetId}/ingest
GET   /v1/admin/content/media-assets/{assetId}/transcript
POST  /v1/admin/content/media-assets/{assetId}/generations
GET   /v1/admin/content/pipeline/jobs
GET   /v1/admin/content/pipeline/jobs/{jobId}
POST  /v1/admin/content/pipeline/jobs/{jobId}/retry
POST  /v1/admin/content/pipeline/jobs/{jobId}/cancel
GET   /v1/admin/content/generations/{generationId}
POST  /v1/admin/content/generations/{generationId}/apply
POST  /v1/admin/content/generations/{generationId}/discard
POST  /v1/admin/content/courses/{courseId}/illustrate        # M8 新增
GET   /v1/admin/content/figures?courseId=&chapterId=         # M8 新增
POST  /v1/admin/content/figures/{figureId}/select            # M8 新增
POST  /v1/admin/content/figures/{figureId}/regenerate        # M8 新增
DELETE /v1/admin/content/figures/{figureId}                  # M8 新增
POST  /v1/admin/content/courses/{courseId}/publish
```

请求/响应：

```jsonc
// GET /v1/admin/content/media-assets?courseId=&status=&offset=0&limit=50
{ "assets": [{ "assetId": "asset-...", "courseId": "TC-101", "title": "...",
               "status": "awaiting_upload|uploaded|processing|ready|failed|archived",
               "durationMs": 0, "errorCode": null, "hlsReady": false,
               "transcriptStatus": null, "sourceSizeBytes": 0,
               "createdAt": 1760000000000, "updatedAt": 1760000000000 }],
  "total": 1, "offset": 0, "limit": 50 }

// POST /v1/admin/content/media-assets
{ "courseId": "TC-101", "title": "趋势反转第一课" }
// 201 → { "asset": { ... } }；课程必须为 draft

// PATCH /v1/admin/content/media-assets/{assetId}
{ "title": "可选", "status": "archived" }   // 仅允许归档
// 200 → { "asset": { ... } }

// PUT /v1/admin/content/media-assets/{assetId}/source
// Content-Type: application/octet-stream；body 为源视频流
// 可选 header: x-file-sha256: <64 位小写 hex>
// 200 → { "asset": { "assetId": "...", "status": "uploaded", "sourceSizeBytes": 0, ... } }

// POST /v1/admin/content/media-assets/{assetId}/ingest
{ "language": "auto|zh|en" }   // 可选，默认 auto
// 202 → { "job": { ... } }

// GET /v1/admin/content/media-assets/{assetId}/transcript?offset=0&limit=100
{ "transcript": { "transcriptId": "tr_...", "assetId": "...",
                  "status": "pending|processing|ready|failed", "language": "zh",
                  "model": "asr-1.0", "durationMs": 0, "chunkCount": 2,
                  "segmentCount": 40, "errorCode": null },
  "segments": [{ "idx": 0, "startMs": 0, "endMs": 30000, "text": "..." }],
  "total": 40, "offset": 0, "limit": 100 }

// POST /v1/admin/content/media-assets/{assetId}/generations
// 202 → { "job": { ... } }；要求转写 ready

// POST /v1/admin/content/courses/{courseId}/illustrate
{ "chapterIds": ["ch_..."] }   // 可选；缺省为全部已有图示计划的章节
// 202 → { "job": { ... } }；要求课程 draft 且章节教材已 apply

// GET /v1/admin/content/figures?courseId=&chapterId=&offset=0&limit=50
{ "figures": [{ "figureId": "fig_...", "chapterId": "ch_...", "kind": "keyframe|generated",
                "caption": "...", "status": "planned|rendering|ready|failed|published",
                "selectedCandidateId": "cand_... | null", "prompt": "...",
                "model": "...", "seed": 0, "reviewReasons": [],
                "candidates": [{ "candidateId": "cand_...", "status": "ready|failed",
                                 "width": 1600, "height": 900, "bytes": 0,
                                 "sourceSec": 125, "errorCode": null,
                                 "previewUrl": "https://.../admin/figures/..." }] }],
  "total": 1, "offset": 0, "limit": 50 }

// POST /v1/admin/content/figures/{figureId}/select
{ "candidateId": "cand_..." }   // 候选必须 ready
// 200 → { "figure": { ... } }

// POST /v1/admin/content/figures/{figureId}/regenerate
// 202 → { "figure": { ... } }；仅 generated 类，候选数仍为 2

// DELETE /v1/admin/content/figures/{figureId}
// 204；被已发布正文引用时 409 figure_in_use

// GET /v1/admin/content/pipeline/jobs?status=&kind=&courseId=&assetId=&offset=0&limit=50
{ "jobs": [{ "jobId": "job_...", "assetId": "... | null", "courseId": "...",
             "kind": "ingest|generate|illustrate", "status": "queued|running|succeeded|failed|canceled",
             "stage": "queued|probe|transcode|transcribe|structure|generate|figure_plan|figure_render|finalize|done",
             "progress": 0, "attempts": 0, "maxAttempts": 3, "errorCode": null,
             "createdAt": 0, "updatedAt": 0, "startedAt": null, "finishedAt": null }],
  "total": 1, "offset": 0, "limit": 50 }

// GET /v1/admin/content/pipeline/jobs/{jobId}
{ "job": { ... }, "result": { "transcriptId": "tr_... | null", "generationId": "gen_... | null" } }

// POST /v1/admin/content/pipeline/jobs/{jobId}/retry   → 202 { "job": { ... } }
// POST /v1/admin/content/pipeline/jobs/{jobId}/cancel  → 200 { "job": { ... } }

// GET /v1/admin/content/generations/{generationId}
{ "generation": { "generationId": "gen_...", "assetId": "...", "courseId": "...",
                  "status": "draft|applied|discarded|failed", "promptVersion": "m8-v1",
                  "model": "...", "counts": { "chapters": 3, "knowledgePoints": 12,
                  "chapterArticles": 3, "figures": 5, "segments": 30, "needsReview": 2 },
                  "createdAt": 0, "appliedAt": null },
  "chapters": [{ "key": "ch01", "title": "...", "position": 0,
                 "articleLength": 2450, "hasArticle": true, "figureCount": 2 }],
  "knowledgePoints": [{ "key": "kp01", "chapterKey": "ch01", "title": "...",
                        "position": 0, "confidence": 0.82, "needsReview": false,
                        "reviewReasons": [], "startMs": 0, "endMs": 120000 }],
  "figures": [{ "key": "fg01", "chapterKey": "ch01", "kind": "keyframe|generated",
                "caption": "...", "candidateCount": 2, "needsReview": false }],
  "segments": [{ "key": "sg0001", "pointKey": "kp01", "title": "...",
                 "startMs": 120000, "endMs": 245000 }] }
// 预览不返回章节正文与图片字节，只返回长度、计数与待审原因。

// POST /v1/admin/content/generations/{generationId}/apply
{ "generationId": "gen_...", "alreadyApplied": false, "courseId": "TC-101",
  "chapters": [{ "chapterId": "ch_...", "key": "ch01" }],
  "knowledgePoints": [{ "knowledgePointId": "kp_...", "key": "kp01" }],
  "figures": [{ "figureId": "fig_...", "key": "fg01" }],
  "segments": [{ "segmentId": "seg-...", "key": "sg0001" }],
  "chapterArticles": 3, "figuresApplied": 5 }

// POST /v1/admin/content/generations/{generationId}/discard → { "discarded": true }

// POST /v1/admin/content/courses/{courseId}/publish
{ "courseId": "TC-101", "published": true, "indexed": true, "embedded": 30,
  "counts": { "chapters": 3, "knowledgePoints": 12, "chapterArticles": 3,
              "figures": 5, "segments": 30 } }

// 409（存在未就绪图示引用）
{ "error": { "code": "figure_unresolved", "message": "...",
             "figureIds": ["fig_ab12cd34_f1"] } }
```

- `assetId` 形如 `asset-[A-Za-z0-9._-]{1,58}`；`jobId/generationId/transcriptId` 为服务端生成的不透明 ID；`chapterId/knowledgePointId/segmentId` 在 apply 时确定性生成。
- 上传：路由级 `bodyLimit=PIPELINE_MAX_UPLOAD_BYTES`（默认 2GiB）；只接受 `application/octet-stream`，否则 `415`；超限 `413`；`x-file-sha256` 不符 `400` 并清理半成品；鉴权与限流先于 body 消费。
- 媒体：ffprobe 必须同时有视频与音频流，时长 ≤`PIPELINE_MAX_SOURCE_SECONDS`；非法 `422`。`sourceRelPath`、`hlsPath`、SHA、URL 永不出现在响应。
- 任务：同一素材同类型同时最多一个 `queued/running`，重复 ingest/generate `409`；retry 仅 `failed/canceled` 且源文件存在；cancel 仅 `queued/running`；`errorCode` ≤64 且为稳定枚举。
- 素材状态：`awaiting_upload → uploaded → processing → ready|failed`；`archived` 仅手动；不物理删除。重新上传未归档素材会重置转写与生成。
- 转写：`GET .../transcript` 是唯一返回正文的管线接口；`segments` 按 `startMs` 升序、互不重叠，单段 1–4000 字符；未就绪时 `segments=[]`。
- 生成：只有 `draft` generation 可 apply/discard；apply 要求课程 `draft` 且无章节/知识点/片段/图示，否则 `409`；已 applied 再次 apply 返回原映射与 `alreadyApplied:true`。章节教材每章一篇；知识点不再生成文章。
- 图示：`illustrate` 仅针对 `draft` 课程且章节教材已 apply；每章 ≤3 张、每次 2 候选、每图重试 1 次；失败只标该图 `failed`，不阻塞课程发布。`select` 只接受 `ready` 候选；已选中图示的再生需显式 `regenerate`，不静默覆盖。候选预览接口走后台会话，不返回本地路径。
- 图片预算：单课 ¥10、组织月度 ¥300；80% 预警，100% 硬停 `illustrate`/`regenerate` 并返回 `409 image_budget_exceeded`，图片标「待生成」，章节教材照常发布。
- 发布：课程必须存在且非 `archived`、至少 1 个片段；先校验正文中每个 `figure:<figureId>` 都指向已选且就绪的 `published` 图示，否则 `409 figure_unresolved`；配置 embedding 时再 `reindex`，失败 `503` 且不翻状态；无 provider 时允许发布且 `indexed=false`。发布幂等，只把 `draft` 章节教材/图示/片段/课程置 `published`。
- 管线未启用（`PIPELINE_ENABLED=false`）时素材/上传/ingest/生成/图示/任务接口 `503`；ASR、LLM 或图片模型未配置时对应阶段/接口 `503`，不影响其它接口；图片未配置时生成与发布照常。
- 限流：`RATE_LIMIT_PIPELINE_PER_MINUTE`（默认 30，按后台账号）；上传按字节流不做请求级缓冲。
- 日志与指标不记转写正文、源路径、provider 响应、完整 SHA；发布与索引失败只记类别。

**验收用例**

| 用例 | 期望 |
|---|---|
| 创建 draft 课程 → 素材 → 上传 → ingest | `201/200/202`；job 依次 `probe/transcode/transcribe/finalize`，转写 `ready` 且时间戳单调 |
| 上传无音轨、超时长、SHA 不符、非 octet-stream、超 2GiB | `422/400/415/413`，半成品清理 |
| 重复 ingest / 重复 generate | `409`；同素材同类型无重复 active job |
| 生成 → 预览 | 章节/知识点/章节教材/图示计划/片段草稿；待审原因、置信度与教材长度可见；预览不含正文与图片字节 |
| apply → 课程树 | 全部 `draft`，学员 catalog/检索/播放不可见；再次 apply 幂等 |
| 图示生成 → 选图 | `illustrate` 任务走 `figure_plan/figure_render`；每章 ≤3 图、每次 2 候选；选图后 `selectedCandidateId` 落库 |
| 缺图发布 | 正文引用未选图 → `409 figure_unresolved` 并列出 figureId；补齐后重试成功 |
| 图片模型未配置 | `illustrate` 与 `regenerate` → `503`；生成、apply、发布仍可用 |
| 发布 | 先校验图示引用再索引（配置时）；catalog/检索/播放可见；索引失败 `503` 且课程仍 `draft` |
| 取消 / 重试 / 心跳超时 | 终态正确；重试从阶段续跑且成功块不重复请求 |
| 学员令牌 / 未登录 / 运营与 admin | 学员 `403`；未登录 `401`；operator/admin 可用 |
| 管线未启用或 ASR/LLM 未配置 | 对应接口 `503`；服务健康 |
| 响应与日志 | 无源路径、HLS 路径、SHA、转写正文（转写接口除外）、provider 响应 |

### 3.10 模型配置（M4.3）

全部接口位于 `/v1/admin/model-configs/*`，**仅 `admin` 后台会话**可用（operator 与学员 `403`，未登录 `401`）；按账号限流 `RATE_LIMIT_MODEL_CONFIG_PER_MINUTE`（默认 30）。

| 方法 | 路径 | 说明 |
|---|---|---|
| GET/POST | `/llm` | 列出/新增模型条目（`purpose=content\|embedding\|image`） |
| GET/PATCH/DELETE | `/llm/{configId}` | 详情/修改/删除（删除默认项时自动提升同用途最早启用项） |
| POST | `/llm/{configId}/set-default` | 切换同用途默认（按用途唯一） |
| POST | `/llm/{configId}/test` | 连通性测试（content `max_tokens:1`；embedding 校验 1024 维；image 生成 1 张 512 测试图，会产生约 ¥0.12 费用） |
| GET/PATCH | `/asr` | 单行 ASR 渠道配置（`protocol=minimax\|openai`、`enabled`） |
| POST | `/asr/test` | 用 1 秒 440Hz WAV 测试上游 |

- 响应字段：`apiKeyConfigured`、`apiKeyMasked`（前 4 + `*` + 后 4；短密钥整体打码）；**从不返回明文密钥**，请求日志与响应中不得出现 key。
- `PATCH` 中 `apiKey: ""` 表示保留原密钥；新增时空串/缺省表示不配置密钥。
- `baseUrl` 仅接受 http(s) 绝对地址；粘贴完整端点（`/chat/completions`、`/embeddings`、`/audio/transcriptions`、`/v1/speech_to_text`、`/v1/messages`）时自动归一化到 base。
- 内容 LLM `protocol=openai|anthropic`：`openai` 走 `/chat/completions` + `response_format=json_object`；`anthropic` 走 `/v1/messages` + `x-api-key` + `anthropic-version: 2023-06-01`。`purpose=embedding` 只允许 `openai`（Anthropic 无 embeddings 端点），否则 `400`。
- embedding 请求显式带 `dimensions: 1024`（智谱 `embedding-3` 默认 2048）；模型以 4xx 拒绝该参数时重试一次不带 `dimensions`，最终仍要求返回 1024 维。
- `purpose=image` 仅允许 `protocol=openai`（按 `purpose` 分流到图片端点）：`POST {base}/images/generations`，Header `Authorization: Bearer <key>`，body `{model, prompt, size, response_format:"url", watermark:false}`；默认 `baseUrl=https://ark.cn-beijing.volces.com/api/v3`、`model=doubao-seedream-5-0-260128`、`size=2K`；备用可配 `doubao-seedream-4-5-*`。`baseUrl` 粘贴完整 `/images/generations` 时自动归一化。
- 图片条目新增 `imagePriceMicros`（每张，默认 `120000` = ¥0.12）；与 `input/output_price_micros_per_1k` 互斥：`purpose=image` 忽略 token 单价，非 image 忽略图片单价。成本 = `images × imagePriceMicros`，单价为空时成本返回 `null`。
- 图片模型未配置或不可解密时 `illustrate`/`regenerate` 返回 `503`，课程生成、apply 与发布不受影响。
- 保存后运行时在下一次任务/检索/发布时解析最新默认配置，无需重启；删除密钥或不可解密时按未配置处理。
- 错误：`400` 入参/ID；`401/403` 鉴权与角色；`404` 不存在；`409` 停用项不可设默认；`429` 限流。

**验收用例**

| 用例 | 期望 |
|---|---|
| 匿名 / 学员设备令牌 / operator / admin | `401` / `401` / `403` / `200` |
| 新增带密钥的 LLM 条目 | 落库为 `v1:` 密文；响应仅有掩码；明文不出现在响应/日志 |
| 同用途两个默认项 | 后者新增/设默认后前者自动取消，数据库仅一个 `is_default` |
| `PATCH apiKey: ""` | 保留原密钥，掩码不变 |
| embedding 用途测试非 1024 维 | `success=false`，detail 说明维度 |
| image 用途新增并设默认 | `purpose` 唯一默认；`imagePriceMicros` 默认 120000；测试生成 1 张 512 图并记 1 次用量/成本 |
| image 用途绑定到 content 任务 | `409`；`llm_task_bindings` 主备必须同用途 |
| ASR 未启用/无 key | 转写阶段 `503`；其他管线阶段正常 |
| image 未配置/无 key | `illustrate`、`regenerate` `503`；生成/apply/发布正常 |
| 更换 `CREDENTIAL_ENCRYPTION_KEY` 后读取 | 掩码显示「无法解密，请重新录入」，不泄露密文 |

### 3.11 公开门户与自助账号（M7）

```http
POST   /v1/portal/auth/register        # 公开；用户名 + 密码注册，自动登录
POST   /v1/portal/auth/login           # 公开；任意非禁用账号
GET    /v1/portal/auth/session         # 门户会话
DELETE /v1/portal/auth/session         # 注销当前门户会话
GET    /v1/portal/me                   # 资料
PATCH  /v1/portal/me                   # 修改显示名
POST   /v1/portal/me/password          # 改密（吊销其他会话）
GET    /v1/portal/me/devices           # 本人设备列表
DELETE /v1/portal/me/devices/{deviceId} # 解绑本人设备
GET    /v1/portal/releases             # 公开；发布清单
GET    /v1/portal/stats                # 公开；已发布内容计数
```

```jsonc
// POST /v1/portal/auth/register → 201
{ "username": "stu01", "password": "至少 10 个字符", "displayName": "可选" }
// 响应与登录相同
{ "token": "string", "expiresAt": 1760000000000,
  "user": { "userId": "usr_...", "username": "stu01", "displayName": "学员一号", "role": "student" } }

// POST /v1/portal/auth/login → 200（同上）
{ "username": "stu01", "password": "..." }

// GET /v1/portal/auth/session → { "user": { ...PortalProfile } }
// GET /v1/portal/me → { "profile": { ...PortalProfile } }
{ "userId": "usr_...", "username": "stu01", "displayName": "学员一号",
  "role": "student", "status": "active", "createdAt": 1760000000000,
  "passwordUpdatedAt": 1760000000000, "deviceCount": 1 }

// PATCH /v1/portal/me → { "profile": { ... } }
{ "displayName": "新显示名" }

// POST /v1/portal/me/password → { "updated": true }
{ "currentPassword": "...", "newPassword": "..." }

// GET /v1/portal/me/devices → { "devices": [...] }
{ "devices": [{ "deviceId": "dev-...", "status": "active",
                "firstAuthorizedAt": 1760000000000, "lastSeenAt": 1760000000000 }] }
// DELETE /v1/portal/me/devices/{deviceId} → { "revoked": true }

// GET /v1/portal/releases → 200（max-age=60；清单缺失时 plugin=null）
{ "dshVersion": "0.2.1-rc.5", "webAppPackage": "@deepseek-ai/dsh-web-app",
  "plugin": { "name": "dsh-plugin-trend-coach", "version": "0.1.0",
              "fileName": "dsh-plugin-trend-coach-0.1.0.tgz",
              "sha256": "64 位 hex", "sizeBytes": 123456,
              "publishedAt": "2026-11-01T00:00:00Z", "notes": ["修复 ..."] } }

// GET /v1/portal/stats → 200（max-age=60）
{ "courses": 2, "knowledgePoints": 24, "segments": 30, "chapterArticles": 12, "figures": 18 }
```

- 注册只创建 `student`；`username` 3–32、小写字母开头、`[a-z0-9._-]`；密码 10–128；`displayName` 1–200。
- 用户名已存在 `409`；参数非法 `400`；登录失败统一 `401`，不区分账号是否存在或密码错误。
- 限流：注册按 IP `RATE_LIMIT_REGISTER_PER_MINUTE`（默认 5）；登录按 IP 与用户名各 `RATE_LIMIT_LOGIN_PER_MINUTE`（默认 10）；其他门户接口按 IP `RATE_LIMIT_PORTAL_PER_MINUTE`（默认 120）；超限 `429`。
- 门户会话 `scope=portal`，默认 12 小时；改密吊销该用户其他会话；设备解绑只吊销该设备令牌，非本人设备 `403`，设备不存在 `404`。
- 公开接口不返回内部路径、源文件名或密钥；`releases` 清单格式错误 `503`，文件缺失返回空版本。
- 门户静态页与下载不属于 OpenAPI；预渲染 HTML 与 SPA 壳 `no-store`，未知前端路径带 `x-robots-tag: noindex`。

**验收用例**

| 用例 | 期望 |
|---|---|
| 注册新用户名 / 重复用户名 / 弱密码 | `201` 自动登录 / `409` / `400` |
| 登录成功 / 密码错误 / 禁用账号 / 超限 | `200` / `401` / `401` / `429` |
| 学员门户令牌访问 `/v1/admin/*` | `401/403`；门户接口正常 |
| 改密 / 设备解绑 | 其他会话失效；只能解绑本人设备 |
| 发布清单缺失 / 统计 | `plugin=null` 或计数；`max-age=60` |
| 门户页深链刷新 / 未知路径 / `/v1/nope` | 预渲染 HTML / 壳 + `noindex` / JSON `404` |

### 3.12 AI 运营（M7）

全部接口位于 `/v1/admin/ai/*`，使用后台会话（`Authorization: Bearer <session token>`，不带 `x-device-id`）。读接口 operator/admin 可用，绑定写接口仅 admin；按账号限流 `RATE_LIMIT_AI_PER_MINUTE`（默认 120）。

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/usage/summary?from&to&task` | 总量、按日、按任务、按模型、成本估算 |
| GET | `/usage/events?from&to&task&model&cursor&limit` | 用量明细，游标分页 |
| GET | `/runs?from&to&task&status&source&cursor&limit` | 运行列表 |
| GET | `/runs/{runId}` | 运行详情与步骤链 |
| GET | `/bindings` | 全任务绑定与可选模型 |
| PUT | `/bindings/{taskKey}` | 设置主/备；仅 admin |
| GET | `/health` | 配置失败次数、冷却与最近错误 |

```jsonc
// GET /v1/admin/ai/usage/summary
{ "from": "2026-10-25T00:00:00.000Z", "to": "2026-11-01T00:00:00.000Z",
  "totals": { "requests": 120, "errors": 3, "fallbacks": 2,
              "inputTokens": 1000, "outputTokens": 500, "cachedTokens": 0,
              "audioSeconds": 0, "characters": 0,
              "avgLatencyMs": 850, "costMicros": 12345 },
  "daily": [{ "date": "2026-10-25", "requests": 10, "inputTokens": 0,
              "outputTokens": 0, "costMicros": 0 }],
  "byTask": [{ "taskKey": "content.chapter", "label": "章节教材生成",
               "requests": 10, "errors": 0, "inputTokens": 0, "outputTokens": 0,
               "audioSeconds": 0, "characters": 0, "images": 0, "costMicros": 0 }],
  "byModel": [{ "configId": "llmc_...", "provider": "minimax", "model": "...",
                "requests": 10, "errors": 0, "inputTokens": 0,
                "outputTokens": 0, "images": 0, "costMicros": 0 }] }

// GET /v1/admin/ai/usage/events → { "events": [...], "nextCursor": "123 | null" }
{ "usageId": "123", "runId": "uuid | null", "taskKey": "content.image",
  "label": "文生图", "provider": "volcengine-ark", "model": "doubao-seedream-5-0-260128",
  "configId": "llmc_... | null",
  "inputTokens": 0, "outputTokens": 0, "cachedTokens": 0,
  "audioSeconds": 0, "characters": 0, "images": 2, "latencyMs": 800,
  "status": "success|error|fallback", "errorCode": null,
  "createdAt": "2026-11-01T00:00:00.000Z" }

// GET /v1/admin/ai/runs → { "runs": [...], "nextCursor": "1760000000000:uuid | null" }
{ "runId": "uuid", "taskKey": "content.outline", "label": "章节大纲",
  "source": "pipeline|admin", "sourceId": "job_... | null",
  "status": "running|succeeded|failed", "primaryConfigId": "llmc_... | null",
  "fallbackUsed": false, "startedAt": "...", "finishedAt": "... | null",
  "durationMs": 1000, "errorCode": null }

// GET /v1/admin/ai/runs/{runId} → 上述字段 + summary + steps
{ ..., "summary": {}, "steps": [{ "stepId": "1", "seq": 0, "taskKey": "...",
  "configId": "llmc_... | null", "provider": "...", "model": "...",
  "attempt": 1, "status": "success|error", "latencyMs": 800,
  "usageId": "123 | null", "errorCode": null, "createdAt": "..." }] }

// GET /v1/admin/ai/bindings
{ "bindings": [{ "taskKey": "content.chapter", "label": "章节教材生成",
                 "purpose": "content", "primaryConfigId": "llmc_... | null",
                 "fallbackConfigId": "llmc_... | null", "updatedAt": "..." },
               { "taskKey": "content.image", "label": "文生图",
                 "purpose": "image", "primaryConfigId": "llmc_... | null",
                 "fallbackConfigId": "llmc_... | null", "updatedAt": "..." }],
  "configs": [{ ...LlmModelConfig }] }

// PUT /v1/admin/ai/bindings/{taskKey}（primaryConfigId=null 删除绑定）
{ "primaryConfigId": "llmc_...", "fallbackConfigId": "llmc_... | null" }

// GET /v1/admin/ai/health
{ "configs": [{ "configId": "llmc_...", "name": "...", "provider": "...",
                "model": "...", "purpose": "content|embedding|image", "isActive": true,
                "consecutiveFailures": 0, "cooldownUntil": null,
                "coolingDown": false, "lastError": null,
                "lastFailureAt": null, "lastSuccessAt": "..." }] }
```

- `from/to` 为 ISO 时间，缺省为最近 7 天；`from > to` 或格式非法 `400`；`limit` 1–200（默认 50）。
- 任务键：`content.outline|content.points|content.chapter|content.figure|content.image|embedding.query|embedding.segment|asr.longform`；绑定只接受 LLM/图片任务（ASR 不可绑定，`400`）。`content.image` 只接受 `purpose=image` 配置，其余内容任务只接受 `purpose=content`。
- 绑定校验：主/备必须与任务用途一致且启用，主备相同 `400`，停用配置 `409`，配置不存在 `404`；未绑定回落同用途默认启用模型。
- 主模型 429/5xx/网络/超时切备用，仅单跳；两次调用都记用量，运行标 `fallbackUsed=true`，失败配置进入 60s 冷却。
- 成本为微美元；LLM/embedding 按 token 单价，图片按 `images × imagePriceMicros`；任一参与计费的模型单价缺失时该聚合 `costMicros=null`，前端显示「未配置价格」。
- 日志与响应不含 prompt、回答、密钥或完整上游响应。

**验收用例**

| 用例 | 期望 |
|---|---|
| operator / admin 读用量与运行 | `200`；学员/未登录 `401/403` |
| operator 写绑定 | `403`；admin `200` |
| 绑定主备同用途且启用 | 保存后下一次调用生效 |
| 主模型 429 → 备用 | 自动切换；`fallbackUsed=true`；健康进入冷却 |
| 价格缺失 / 已配置 | `costMicros=null` / 按 token 单价或 `images × imagePriceMicros` 估算 |
| 用量与运行一致性 | 每次尝试在 steps 中可见，并关联 `usageId` |

## 4. 数据与内容前置

- M1 内容管线可产出带时间戳转写、章节/知识点切分、片段与文章草稿，经人工审核发布；真实样片与 ASR/内容 LLM/embedding 已完成验收。M8 起改为章节教材 + 图示，需另备至少 1 门样课验证章节教材与图片渲染。
- 需要至少一门真实课程与加密 HLS 样片（含 key 与分片）用于联调；建议提供 2 门课程、10+ 片段的最小数据集。
- 视频加密方案需确认（云点播私有加密 / AES-128）并与 hls.js 解密配置对齐；M1 产出未加密 HLS，靠签名 URL 保护。
- 检索质量以本产品自建评估集把关，不复用 ai-invest 的库或评估结果。

## 5. 安全与合规

- 令牌只存服务端与插件本地 credentials（0600）；不写日志、不下发浏览器、不进配置。
- 学员业务接口只读知识内容（进度与事件同意除外）；后台写接口仅 operator/admin 会话；按用户/设备限流与配额告警；视频并发限制。
- 用户数据最小化采集；支持注销；敏感字段脱敏。
- 指标事件必须鉴权、字段白名单、同意后可上报且可撤回；未登录或无 consent 不上报。
- 事件白名单（M2）：`search_requested`（耗时、topK、命中数、是否空召回）、`citation_clicked`（segmentId）、`player_started`（起播耗时、是否自动播放被拒）、`feedback_submitted`（评分 up/down，仅来自用过课程检索的会话）；不含 query 原文、回答内容、完整播放地址、反馈分类与备注。
- 事件接收端点路径待定（建议 `POST /v1/events`），需先冻结字段与同意模型。

## 6. 对接验收清单

| 类别 | 用例 | 期望 |
|---|---|---|
| 授权 | 设备码发起 → 批准 → 轮询 | 返回 grant，可调用业务接口 |
| 授权 | access 过期 → 刷新 → 重试 | 刷新成功；旧 refresh 复用被拒 |
| 授权 | deviceId 不匹配 | `403` |
| 检索 | 正常查询 | 返回 Top-K，字段与边界合法 |
| 检索 | 空召回 | `segments=[]` + `relatedKnowledgePoints`（≤5、仅标题） |
| 检索 | `query=501`、`topK=0/21`、非法 `courseId` | `400`，不发起检索 |
| 检索 | 响应含非法片段 / 超 512KiB | 插件整体失败并提示，不静默截断 |
| 片段 | 存在 / 不存在 | `200` 权威起止秒 / `404` |
| 播放 | 换会话 → 播放 | HLS 解密成功、可 seek；Range 生效 |
| 播放 | 签名过期 / token 无效 | 播放器可读提示，不黑屏 |
| 播放 | 跨域 | CORS 允许媒体请求 |
| 限流 | 超配额 | `429`，插件提示稍后重试 |
| 服务 | 5xx / 超时 | 插件报服务故障，不伪造引用 |
| 指标 | 同意 / 撤回 | 仅白名单字段上报；撤回后停止 |
| 体系 | 课程列表 / 课程树 / 知识点详情 | 仅已发布内容；字段与边界合法；不携带起止秒 |
| 体系 | 未发布或不存在 | `404`；学员令牌访问后台接口 `401/403` |
| 进度 | 上报后回读 | `watchedSec` 取最大值、`completed` 不回退、重复上报幂等 |
| 进度 | 非本人设备 | `403`；超限 `429`；不受指标同意开关影响 |
| 账号 | 管理员创建 + 邀请码首次登录 | 邀请码单次有效；密码 10–128；响应不回显密码 |
| 账号 | 登录失败 / 禁用 / 学员登录控制台 | 统一 `401/403`，不泄露账号是否存在 |
| 账号 | 注销 / 改密 / 禁用 | 旧后台会话失效；禁用后设备令牌 `401` |
| 账号 | 学员/运营访问账号写接口 | 学员 `403`；运营 `403`；admin 可写 |
| 设备授权 | 学员账号批准 | 设备绑定账号；错误密码或未知账号 `401` |
| 设备授权 | 运营会话代批 | 需 operator/admin 会话；学员令牌 `403` |
| 内容管理 | operator 创建课程/章节/知识点/片段 | `200/201`；学员令牌 `403`；未发布内容学员不可见 |
| 内容管理 | 发布 / 归档课程与章节教材 | 学员可见性即时变化；归档后 `404` |
| 内容管理 | 章节教材保存与发布 | `version` 递增、发布写 `publishedAt`；超长或含可执行 HTML `400`；跨章 `figure` 引用 `400` |
| 内容管理 | 图示选图 / 删除 | 只能选 `ready` 候选；被引用图示删除 `409 figure_in_use` |
| 内容管理 | 片段时间轴或知识点归属非法 | `400`，不写入 |
| 内容管理 | 修改片段文本后重建向量 | 旧向量清空；reindex 成功；未配置 embedding `409` |
| 内容管理 | `/admin` 控制台 | 未登录不可操作；退出清除 `sessionStorage` 令牌 |
| 语音 | 合法 WAV 转写 | `200`，文本清洗、`durationMs` 回显 |
| 语音 | 鉴权 / 设备不匹配 | `401` / `403` |
| 语音 | 非法音频 / 超长 / 空文本 | `400` / `413` / `422` |
| 语音 | 上游 429 / 5xx / 超时 | `429` / `503`，不自动重试 |
| 语音 | 未配置 ASR（local） | `503`；staging/production 启动失败 |
| 管线 | 素材上传 → ingest → 转写 | `202`；job 阶段推进；转写时间戳单调、可查询 |
| 管线 | 非法媒体 / SHA 不符 / 上传超限 | `422` / `400` / `413`，清理半成品 |
| 管线 | 生成 → 预览 → apply | 结果均为 `draft`；待审原因可见；重复 apply 幂等 |
| 管线 | 发布 | 先索引；学员可见；索引失败 `503` 且不翻状态 |
| 管线 | 取消 / 重试 / 心跳恢复 | 终态正确；无重复 active job；成功转写块复用 |
| 管线 | 学员令牌访问管线接口 | `403`；未登录 `401` |
| 管线 | 管线/ASR/LLM 未配置 | 对应接口 `503`，服务可启动 |
| 门户 | 注册 / 重复用户名 / 弱密码 | `201` 自动登录 / `409` / `400` |
| 门户 | 登录 / 禁用 / 限流 | `200` / `401` / `429` |
| 门户 | 改密 / 设备解绑 / 越权 | 其他会话失效；仅本人设备；非本人 `403` |
| 门户 | 学员门户令牌访问后台 | `401/403` |
| 门户 | 公开页深链 / 未知路径 / API 404 | 预渲染 HTML / 壳 + `noindex` / JSON `404` |
| AI | 用量汇总与明细 | token/延迟/模型一致；分页游标可用 |
| AI | 运行与步骤 | 主备尝试可见；`fallbackUsed` 正确 |
| AI | 绑定与权限 | operator 只读；admin 可写；主备校验生效 |
| AI | 主模型 429 | 切备用并冷却；冷却期直接走备用 |
| AI | 成本 | 价格缺失 `null`；配置后按微美元估算 |

## 7. 交付物

1. 服务骨架与部署说明（staging / production），有效 TLS 证书。
2. OpenAPI 3 文档，字段与本文一致；契约变更先改 PRD §6 与架构 §6。
3. 数据库 schema 与迁移（课程、章节、知识点、片段、章节教材、图示与候选、进度、账号/会话/邀请码、用户/设备、令牌、事件、管线任务/转写/生成、AI 用量/运行/绑定/健康）。
4. 学员接口（设备码、检索、片段、播放会话、体系/进度、事件、语音转写）、门户接口（注册/登录/个人中心/发布清单/统计）与后台接口（账号、内容管理、视频管线、模型配置、AI 运营）。
5. 鉴权中间件（Bearer + `x-device-id`、门户 `scope`、后台角色）、限流（含 ASR、门户、AI 与管线按账号限流）、错误码映射、日志脱敏。
6. 签名 HLS 下发与 CORS/Range 配置；管线 HLS 目录与媒体根一致。
7. 最小联调数据集（真实课程 + 加密样片 + 2–5 分钟建课样片）与测试账号。
8. 契约测试与 CI：覆盖第 6 节全部用例；至少一个与插件 mock 对齐的响应夹具；管线假 provider E2E、门户静态/认证测试、AI 计量与切换测试、可选真实 ffmpeg 用例。
9. 指标看板与告警：检索 P95、错误分桶、429/5xx、带宽与并发、AI 用量/降级/成本。
10. 门户构建与静态托管产物（`dist/portal`、`routes.json`、`sitemap.xml`、`robots.txt`）与下载目录（`dist/downloads`、`content/releases.json`）。

## 8. 待冻结事项

| 事项 | 当前建议 | 影响 |
|---|---|---|
| access/refresh TTL、并发设备数、吊销 | 默认 900s / 30d；后台会话 12h；设备并发上限仍待定 | 授权验收与安全策略 |
| 片段长度/注入策略 | 架构 §16.3 建议单片段 ≤2KB、总 ≤12KB；当前插件按 4KB/512KiB 校验 | 云端裁剪与插件上限需一致 |
| 引用 host | 暂用 `trend-coach.local`；若换真实域名需插件同步支持 | 历史回答引用兼容 |
| 事件端点与同意模型 | 建议 `POST /v1/events`，本地默认关闭、可撤回 | 指标上报与隐私合规 |
| 视频加密方案 | 云点播私有加密或 AES-128 | hls.js 解密配置 |
| 相邻知识点阈值 | 空召回或最高分低于阈值（待定数值） | F1.4 召回质量 |
| ASR 供应商与模型 | MiniMax `asr-1.0`；provider 接口保留 | 供应商抖动与成本 |
| 语音成本上限 | 单次 ≤60s、每设备 20 次/分钟；不自动重试 | 滥用与账单 |
| 内容 LLM 供应商与模型 | OpenAI 兼容 `/chat/completions` 或 Anthropic `/v1/messages`；模型在后台「模型配置」维护 | 生成质量与成本 |
| 长音频切块与重试 | ≤480s/块、3 次重试、30s 分组；真实时间戳字段待联调 | 计费与对齐精度 |
| 源视频与转写留存 | 默认保留，不自动清理；按版权授权人工归档 | 存储与合规 |
| 多码率与对象存储 | 本期单码率本地存储；`MediaStore` 预留 | 带宽与扩容 |
| 门户内容维护 | 仓库 Markdown + 构建期预渲染，无 CMS | 内容更新需重新构建 |
| 门户会话 | 令牌存 `sessionStorage`，无刷新令牌 | 新标签页需重新登录 |
| 客服/联系入口 | 本期不做，后续单独立项 | 门户支持路径 |
| AI 限流与冷却 | 单实例内存 + DB 健康记录 | 横向扩容前需共享存储 |
| 章节教材粒度 | 已定：3–6 章、每章 ≥5 分钟素材、1500–3000 字；替换知识点短文 | 生成成本与阅读体验 |
| 图示数量与候选 | 已定：每章 0–3 张、每图 2 候选、重试 1 次；≤24 张/课程 | 图片成本与审核工作量 |
| 图片模型与价格 | 已定：直连火山方舟 `doubao-seedream-5-0-260128`，2K，¥0.12/张；后台 `purpose=image` 配置 | 成本核算与模型切换 |
| 图片预算上限 | 已定：¥10/课程、¥300/月；超限暂停 `illustrate` 并提示 | 账单保护 |
| 图示 URL 策略 | 已定：短时签名（默认 10 分钟）；插件需验证 dsh-web-app CSP 是否允许外部图片域 | 插件渲染与回退方案 |
| 旧课程处置 | 已定：直接 `archived` 并重跑，不迁移；保留 30 天后清理 | 学员进度与通知 |
| 体系契约版本 | 已定：M8 起 `contractVersion=2`，插件低版本提示升级 | 插件发版节奏 |
