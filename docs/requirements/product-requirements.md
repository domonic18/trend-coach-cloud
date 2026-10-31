# 趋势交易课程云端服务需求

版本：v0.1（2026-10-31）
状态：与插件 PRD v1.3 §6、架构 §6/§9/§10/§12 对齐；接口细节见 [对接清单](../architecture/cloud-service-integration-checklist.md)。

## 1. 背景与目标

`dsh-plugin-trend-coach` 是学员本地 dsh 客户端中的伴学插件：推理走学员自己的模型（BYOK），云端只提供课程知识与内容服务。

本服务的目标：

1. 提供课程知识库检索，返回可引用的 Top-K 视频片段与权威起止秒。
2. 提供片段详情与短时效签名 HLS 播放会话，支撑插件内视频定位。
3. 提供设备码授权与令牌轮换，把云端凭据限制在插件 Host 侧。
4. 为后续账号、内容后台、指标与学习进度预留清晰边界。

**不做**：大模型推理、API Key 托管、全库正文下发、写接口（一期只读）、第三方分析 SDK。

**不耦合 `ai-invest`**：独立仓库、独立数据库、独立鉴权与用户体系；只借鉴 PostgreSQL halfvec + pg_trgm + RRF 的技术选型与调优经验。

## 2. 调用方与角色

| 角色 | 说明 |
|---|---|
| 学员插件 | `dsh-plugin-trend-coach` Host 半，携带 Bearer 与 `x-device-id` 调用业务接口 |
| 浏览器播放器 | 只拿签名 `playlistUrl`，直接向媒体域取流，不持 Bearer |
| 内容运营 / 管理员 | M3 后台，管理课程、知识点、片段与索引（本期仅预留） |

## 3. 功能需求

### C1 知识库检索（M2，P0）

- `POST /v1/kb/search`，请求 `query`、可选 `topK` / `courseId`。
- 只返回 Top-K 片段与元数据，不下发全库正文；查询 embedding 在云端计算。
- 每个片段必须包含：`segmentId、courseId、chapterId、knowledgePointId、title、startSec、endSec、text、score`，以及可选展示标题 `courseTitle、chapterTitle、knowledgePointTitle`。
- 空召回或最高分低于阈值时返回 `relatedKnowledgePoints`（≤5 条，仅 `knowledgePointId/title`），不得携带起止秒或正文。
- 请求边界：`query` 去首尾空白后 1–500 字符；`topK` 整数 1–20（默认 5）；`courseId` ≤64 且仅 `[A-Za-z0-9._-]`；越界返回 `400`。
- 响应边界：单次 ≤512KiB；`text` ≤4000 字符；`title` 与展示标题 ≤200 字符；结构不合法整体失败，不静默截断。
- 召回质量：以自建评估集把关，≥100 条真实学员问题，Top-5 命中率 ≥90%。

### C2 片段详情（M2，P0）

- `GET /v1/kb/segments/{segmentId}`，返回单个片段元数据与展示标题，`score` 可为 `1`。
- 插件以此接口的 `startSec/endSec` 为唯一权威定位依据；不存在或已下架返回 `404`。
- `segmentId` 形如 `seg-[A-Za-z0-9._-]+` 且 ≤80 字符，全局唯一、跨版本稳定。

### C3 播放会话与签名 HLS（M2，P0）

- `POST /v1/playback/sessions`，请求 `segmentId`，返回 `sessionId / playlistUrl / expiresAt / watermark.label`。
- `playlistUrl` 为短时效签名地址；m3u8 内 key URI 与分片地址携带同一 token。
- `expiresAt` 至少覆盖一个片段播放窗口（60s），推荐 5–10 分钟。
- 媒体域必须支持 CORS（至少 `GET/OPTIONS`、`Range`、`Content-Type`）与 HTTP Range。
- 播放地址绑定设备与并发数；播放中过期由播放器给出可读提示，不静默黑屏。

### C4 设备码授权与令牌轮换（M2，P0）

- `POST /v1/auth/device/code`：`{ clientId, deviceId }` → `{ deviceCode, userCode, verificationUri, expiresIn, interval }`。
- `POST /v1/auth/device/token`：`{ deviceCode }` → `pending | expired | authorized(grant)`。
- `POST /v1/auth/refresh`：`{ refreshToken, deviceId }` → 新 grant；access/refresh 同时轮换，旧 refresh 立即失效。
- 业务接口统一携带 `Authorization: Bearer <accessToken>` 与 `x-device-id`；缺失/过期 `401`，设备不匹配 `403`。
- grant 只存在于插件 Host 与 dsh credentials，云端不得把令牌下发给浏览器、写入日志或返回额外字段。

### C5 指标事件（M2，P1，待冻结）

- 端点建议 `POST /v1/events`，必须鉴权、字段白名单、用户同意后可上报且可撤回。
- 一期字段：`search_requested`（耗时、topK、命中数、是否空召回）、`citation_clicked`（segmentId）、`player_started`（起播耗时、是否自动播放被拒）。
- 不采集 query 原文、回答内容、完整播放地址；未登录或无 consent 不上报。

### C6 内容与索引管线（M1 起，P0）

- 输入：录播视频、带时间戳转写、章节/知识点切分、课程文章、片段映射。
- 输出：已发布课程、知识点、片段、索引；发布与索引分离，未审核内容不进入问答。
- 转写、文章、视频片段必须共享同一知识点 ID。
- 片段映射粒度为秒；一章可拆多个知识点片段。

### C7 后台管理（M3，P0，本期预留）

- 用户与权限、课程内容管理、索引重建/召回测试、模型配置（仅内容生产）、运营看板、插件版本与灰度。
- 学员不可访问后台接口；越权返回 `401/403`；密钥不明文落库、不进日志与响应。

## 4. 非功能需求

| 类别 | 要求 |
|---|---|
| 可用性 | 知识与视频服务 ≥99.5%；staging/production 分离，有效 TLS |
| 性能 | 检索 P95 ≤300ms（云端侧）；视频起播 ≤2s（CDN）；分片支持 Range |
| 安全 | HTTPS + Bearer + `x-device-id`；按用户/设备限流；业务只读；最小权限 |
| 隐私 | 数据最小化；支持注销；敏感字段脱敏；日志不记 token、完整 query、完整 deviceId |
| 内容安全 | 云端文本按不可信数据处理；不得下发可执行指令；插件侧负责边界转义 |
| 错误 | HTTP 状态码承载语义；响应必须为 JSON 对象；不得返回 HTML 错误页 |
| 可观测性 | 检索 P95、错误分桶、429/5xx、带宽、并发、索引任务状态 |

## 5. 数据与内容前置

- 至少一门真实课程完成结构化上线：带时间戳转写、章节/知识点、标题、片段映射。
- 联调最小数据集：2 门课程、10+ 片段、一门加密 HLS 样片（含 key 与分片）。
- 视频加密方案（云点播私有加密或 AES-128）需与插件 hls.js 解密配置对齐。
- 真实课程与样片版权授权须覆盖转写、改写文章、入库检索。

## 6. 验收标准

| 类别 | 用例 | 期望 |
|---|---|---|
| 授权 | 设备码发起 → 批准 → 轮询 | 返回 grant，可调用业务接口 |
| 授权 | access 过期 → 刷新 → 重试 | 刷新成功；旧 refresh 复用被拒 |
| 授权 | deviceId 不匹配 | `403` |
| 检索 | 正常查询 | Top-K 字段与边界合法，展示标题可用 |
| 检索 | 空召回 | `segments=[]` + `relatedKnowledgePoints`（≤5、仅标题） |
| 检索 | `query=501`、`topK=0/21`、非法 `courseId` | `400`，不发起检索 |
| 检索 | 非法片段或响应超 512KiB | 整体失败，不静默截断 |
| 片段 | 存在 / 不存在 | `200` 权威起止秒 / `404` |
| 播放 | 换会话 → 播放 | HLS 解密成功、可 seek；Range 生效 |
| 播放 | 签名过期 / token 无效 | 播放器可读提示，不黑屏 |
| 播放 | 跨域 | CORS 允许媒体请求 |
| 限流 | 超配额 | `429`，插件提示稍后重试 |
| 服务 | 5xx / 超时 | 插件报服务故障，不伪造引用 |
| 指标 | 同意 / 撤回 | 仅白名单字段上报；撤回后停止 |

质量门槛：召回评估集 Top-5 ≥90%；接口契约测试覆盖上表全部用例；压测满足 P95 与并发目标。

## 7. 指标与告警

- 业务：检索量、空召回率、引用点击率、播放起播成功率、问答满意度。
- 系统：检索 P95/P99、错误率分桶（400/401/403/404/429/5xx）、限流命中、数据库连接与慢查询、索引任务耗时与失败率、媒体带宽与并发。
- 告警：5xx/429 异常升高、检索 P95 超阈值、索引任务连续失败、证书到期、媒体签名失败率异常。

## 8. 里程碑

| 阶段 | 云端交付 | 出口标准 |
|---|---|---|
| M1 | 内容管线、课程/知识点/片段入库、索引 | 1 门课程结构化上线，可检索 |
| M2 | 六个接口、设备码授权、签名 HLS、契约测试 | 对接清单验收通过，插件联调完成 |
| M3 | 后台管理、账号与体系数据、学习进度 | 内容可运营、用户可管理 |
| M6 | 公测加固：限流、压测、备份、合规 | 公测放行 |

## 9. 待冻结事项

| 事项 | 当前建议 | 影响 |
|---|---|---|
| access/refresh TTL、并发设备数、吊销 | 待账号后台定稿 | 授权验收与安全策略 |
| 片段长度/注入策略 | 建议单片段 ≤2KB、总 ≤12KB；插件当前按 4KB/512KiB 校验 | 云端裁剪与插件上限需一致 |
| 引用 host | 暂用 `trend-coach.local`；换真实域名需插件同步 | 历史回答引用兼容 |
| 事件端点与同意模型 | 建议 `POST /v1/events`，默认关闭、可撤回 | 指标上报与隐私合规 |
| 视频加密方案 | 云点播私有加密或 AES-128 | hls.js 解密配置 |
| 相邻知识点阈值 | 空召回或最高分低于阈值（数值待定） | 召回质量 |

## 10. 关联文档

- [云端服务对接清单](../architecture/cloud-service-integration-checklist.md)
- [云端架构设计](../architecture/architecture-design.md)
- [项目规范](../conventions/project-conventions.md)
- 插件仓库：`../dsh-plugin-trend-coach`（PRD v1.3 §6、架构 §6/§9/§10/§12）
