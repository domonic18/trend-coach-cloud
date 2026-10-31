# 云端服务对接清单

本文用于启动**独立的云端服务仓库**，供 `dsh-plugin-trend-coach` 插件对接。接口口径以 PRD v1.3 §6 与架构 §6、§9、§10、§12 为准；冲突时先改那两份文档，再同步本文。

## 1. 边界

云端只提供课程知识与内容服务，不承担推理（学员 BYOK）。

| 提供 | 不提供 |
|---|---|
| 知识库检索（Top-K 片段） | 大模型推理 / API Key 托管 |
| 片段元数据与权威起止秒 | 全库正文下发 |
| 签名 HLS 播放会话 | 直链 / 可下载源站地址 |
| 设备码授权与令牌轮换 | 写接口（一期只读） |
| 鉴权指标事件接收（M2） | 第三方分析 SDK |

**不耦合 ai-invest**：不进其库、不调其服务、不共享代码与数据；只借鉴 PostgreSQL halfvec + pg_trgm + RRF 的技术选型（PRD D2）。

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

`grant` 结构：

```jsonc
{ "accessToken": "string", "refreshToken": "string", "expiresAt": 0, "deviceId": "string" }
```

- `clientId` 固定为 `dsh-plugin-trend-coach`；`deviceId` 由插件首启随机生成并持久绑定。
- `expiresIn/interval` 单位为秒；`interval` 是轮询间隔。
- 刷新必须轮换 access/refresh 双令牌；旧 refresh 复用返回 `401`；设备不匹配返回 `403`。
- 待决策：access/refresh TTL、并发设备上限、主动吊销、多设备登录策略（架构 §16.1）。

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

## 4. 数据与内容前置

- 需要 M1 内容管线产出：带时间戳转写、章节/知识点切分、`segmentId` 分配、课程/章节/知识点标题。
- 需要至少一门真实课程与加密 HLS 样片（含 key 与分片）用于联调；建议提供 2 门课程、10+ 片段的最小数据集。
- 视频加密方案需确认（云点播私有加密 / AES-128）并与 hls.js 解密配置对齐。
- 检索质量以本产品自建评估集把关，不复用 ai-invest 的库或评估结果。

## 5. 安全与合规

- 令牌只存服务端与插件本地 credentials（0600）；不写日志、不下发浏览器、不进配置。
- 业务接口只读；按用户/设备限流与配额告警；视频并发限制。
- 用户数据最小化采集；支持注销；敏感字段脱敏。
- 指标事件必须鉴权、字段白名单、同意后可上报且可撤回；未登录或无 consent 不上报。
- 事件白名单（M2）：`search_requested`（耗时、topK、命中数、是否空召回）、`citation_clicked`（segmentId）、`player_started`（起播耗时、是否自动播放被拒）；不含 query 原文、回答内容、完整播放地址。
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

## 7. 交付物

1. 服务骨架与部署说明（staging / production），有效 TLS 证书。
2. OpenAPI 3 文档，字段与本文一致；契约变更先改 PRD §6 与架构 §6。
3. 数据库 schema 与迁移（课程、章节、知识点、片段、用户/设备、令牌、事件）。
4. 六个接口（设备码 3 个、检索、片段、播放会话）及 M2 事件接口。
5. 鉴权中间件（Bearer + `x-device-id`）、限流、错误码映射、日志脱敏。
6. 签名 HLS 下发与 CORS/Range 配置。
7. 最小联调数据集（真实课程 + 加密样片）与测试账号。
8. 契约测试与 CI：覆盖第 6 节全部用例；至少一个与插件 mock 对齐的响应夹具。
9. 指标看板与告警：检索 P95、错误分桶、429/5xx、带宽与并发。

## 8. 待冻结事项

| 事项 | 当前建议 | 影响 |
|---|---|---|
| access/refresh TTL、并发设备数、吊销 | 待账号后台定稿 | 授权验收与安全策略 |
| 片段长度/注入策略 | 架构 §16.3 建议单片段 ≤2KB、总 ≤12KB；当前插件按 4KB/512KiB 校验 | 云端裁剪与插件上限需一致 |
| 引用 host | 暂用 `trend-coach.local`；若换真实域名需插件同步支持 | 历史回答引用兼容 |
| 事件端点与同意模型 | 建议 `POST /v1/events`，本地默认关闭、可撤回 | 指标上报与隐私合规 |
| 视频加密方案 | 云点播私有加密或 AES-128 | hls.js 解密配置 |
| 相邻知识点阈值 | 空召回或最高分低于阈值（待定数值） | F1.4 召回质量 |
