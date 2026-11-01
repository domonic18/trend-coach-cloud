# 云端服务对接清单

本文用于启动**独立的云端服务仓库**，供 `dsh-plugin-trend-coach` 插件对接。接口口径以 PRD v0.2 §6 与架构 v0.2 §6、§7.5、§9、§10、§12 为准；冲突时先改那两份文档，再同步本文。

## 1. 边界

云端只提供课程知识与内容服务，不承担推理（学员 BYOK）。

| 提供 | 不提供 |
|---|---|
| 知识库检索（Top-K 片段） | 大模型推理 / API Key 托管 |
| 片段元数据与权威起止秒 | 全库正文下发 |
| 签名 HLS 播放会话 | 直链 / 可下载源站地址 |
| 设备码授权与令牌轮换 | 学员侧内容写接口（一期只读） |
| 鉴权指标事件接收（M2） | 第三方分析 SDK |
| 语音转写（M4.2，MiniMax ASR，仅语音→文字） | 生成式推理 / 内容生成 |

**不耦合 ai-invest**：不进其库、不调其服务、不共享代码与数据；只借鉴 PostgreSQL halfvec + pg_trgm + RRF 的技术选型（PRD D2）。

**内容生产管线现状（2026-11-01）**：M1 视频→课程管线未实现；当前课程、章节、知识点、文章与片段由管理端手工录入或种子数据导入，媒体 HLS 由外部准备。插件侧契约不受影响。

## 2. 通用约定

- 传输：HTTPS，`Content-Type: application/json`；响应必须是 JSON 对象，否则插件整体失败。
- 鉴权：业务接口携带 `Authorization: Bearer <accessToken>` 与 `x-device-id: <deviceId>`；缺失/过期 `401`，设备不匹配 `403`。
- 时间：`expiresAt` 为毫秒时间戳；`startSec/endSec` 为整数秒。
- ID：`segmentId` 形如 `seg-[A-Za-z0-9._-]+` 且 ≤80；`courseId` ≤64 且仅 `[A-Za-z0-9._-]`；`chapterId/knowledgePointId` 非空且稳定。
- 错误：HTTP 状态码承载语义（`400/401/403/404/429/5xx`），响应体建议 `{ "error": "string" }`（待冻结）；不得返回 HTML 错误页。
- 限流：按用户/设备限流，超限返回 `429`；响应体不泄露内部配额细节。
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

课程树响应（知识点内联进度）：

```jsonc
{
  "courseId": "string",
  "title": "string",
  "chapters": [{
    "chapterId": "string",
    "title": "string",
    "position": 0,
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

知识点详情响应：

```jsonc
{
  "knowledgePointId": "string",
  "courseId": "string",
  "chapterId": "string",
  "title": "string",
  "article": { "markdown": "string", "version": 1, "publishedAt": 1760000000000 },
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

- 只下发 `published` 内容；未发布或不存在 `404`。`article` 可为 `null`；`segmentId` 可缺省。
- 课程树不携带 `startSec/endSec`；播放定位仍以 `GET /v1/kb/segments/{segmentId}` 为准。
- 边界：课程 ≤50；单课程 ≤50 章节、总知识点 ≤1000；标题 ≤200 字符；响应 ≤512KiB；文章 `markdown` ≤20000 字符，仅 Markdown 子集，不含 HTML/脚本。
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
GET   /v1/admin/content/knowledge-points/{knowledgePointId}/article
PUT   /v1/admin/content/knowledge-points/{knowledgePointId}/article
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
                "segmentCount": 8, "articleCount": 6 }] }

// POST /v1/admin/content/courses
{ "courseId": "TC-101", "title": "趋势交易基础", "status": "draft" }
// 201 → { "course": { "courseId": "TC-101", "title": "...", "status": "draft" } }
// PATCH 同路径，body 可含 title/status

// GET /v1/admin/content/courses/{courseId}
{ "course": { "courseId": "TC-101", "title": "...", "status": "published" },
  "chapters": [{ "chapterId": "M1", "title": "第一章", "position": 1,
    "knowledgePoints": [{ "knowledgePointId": "KP-1.1", "title": "...", "position": 1,
      "segmentCount": 2,
      "article": { "version": 3, "status": "published", "publishedAt": 1760000000000 } }] }] }

// POST /v1/admin/content/courses/{courseId}/chapters
{ "chapterId": "M4", "title": "第四章", "position": 4 }
// PATCH /v1/admin/content/courses/{courseId}/chapters/{chapterId} → title/position

// POST /v1/admin/content/courses/{courseId}/chapters/{chapterId}/knowledge-points
{ "knowledgePointId": "KP-4.1", "title": "知识点标题", "position": 1 }
// PATCH /v1/admin/content/knowledge-points/{knowledgePointId} → title/position

// GET /v1/admin/content/knowledge-points/{knowledgePointId}/article
{ "article": { "markdown": "# 标题", "version": 2, "status": "draft", "publishedAt": null } }
// 未创建时 → { "article": null }
// PUT：{ "markdown": "...", "status": "draft|published|archived" }；每次保存 version+1

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
- 文章 `markdown` 1–20000，拒绝 `<script>`、`<iframe>`、`<object>`、`<embed>`、`<style>`、事件属性与 `javascript:`/`data:text/html`；每次保存 `version + 1`，发布时写 `publishedAt`。
- 课程、章节、知识点、片段、文章不提供物理删除；用 `archived` 下架。课程 `archived` 后其下内容对学员不可见。
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
- 未配置 `ASR_API_KEY`：local 鉴权后 `503`；staging/production 启动失败。
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
| 未配置 `ASR_API_KEY`（local） | `503` |
| 日志抽查 | 无 base64、无转写正文、无完整 deviceId |

## 4. 数据与内容前置

- 需要 M1 内容管线产出：带时间戳转写、章节/知识点切分、`segmentId` 分配、课程/章节/知识点标题。
- 需要至少一门真实课程与加密 HLS 样片（含 key 与分片）用于联调；建议提供 2 门课程、10+ 片段的最小数据集。
- 视频加密方案需确认（云点播私有加密 / AES-128）并与 hls.js 解密配置对齐。
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
| 内容管理 | 发布 / 归档课程与文章 | 学员可见性即时变化；归档后 `404` |
| 内容管理 | 文章保存与发布 | `version` 递增、发布写 `publishedAt`；超长或含可执行 HTML `400` |
| 内容管理 | 片段时间轴或知识点归属非法 | `400`，不写入 |
| 内容管理 | 修改片段文本后重建向量 | 旧向量清空；reindex 成功；未配置 embedding `409` |
| 内容管理 | `/admin` 控制台 | 未登录不可操作；退出清除 `sessionStorage` 令牌 |
| 语音 | 合法 WAV 转写 | `200`，文本清洗、`durationMs` 回显 |
| 语音 | 鉴权 / 设备不匹配 | `401` / `403` |
| 语音 | 非法音频 / 超长 / 空文本 | `400` / `413` / `422` |
| 语音 | 上游 429 / 5xx / 超时 | `429` / `503`，不自动重试 |
| 语音 | 未配置 ASR（local） | `503`；staging/production 启动失败 |

## 7. 交付物

1. 服务骨架与部署说明（staging / production），有效 TLS 证书。
2. OpenAPI 3 文档，字段与本文一致；契约变更先改 PRD §6 与架构 §6。
3. 数据库 schema 与迁移（课程、章节、知识点、片段、文章、进度、账号/会话/邀请码、用户/设备、令牌、事件）。
4. 学员接口（设备码、检索、片段、播放会话、体系/进度、事件、语音转写）与后台接口（账号、内容管理）。
5. 鉴权中间件（Bearer + `x-device-id`）、限流（含 ASR 按设备限流）、错误码映射、日志脱敏。
6. 签名 HLS 下发与 CORS/Range 配置。
7. 最小联调数据集（真实课程 + 加密样片）与测试账号。
8. 契约测试与 CI：覆盖第 6 节全部用例；至少一个与插件 mock 对齐的响应夹具。
9. 指标看板与告警：检索 P95、错误分桶、429/5xx、带宽与并发。

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
