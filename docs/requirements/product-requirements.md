# 趋势交易课程云端服务需求

版本：v0.2（2026-11-01）
状态：与插件 PRD v1.6 §6、架构 §6/§9/§10/§12 对齐；v0.2 新增 M4.2 语音转写（MiniMax ASR）；接口细节见 [对接清单](../architecture/cloud-service-integration-checklist.md)。

## 1. 背景与目标

`dsh-plugin-trend-coach` 是学员本地 dsh 客户端中的伴学插件：推理走学员自己的模型（BYOK），云端只提供课程知识与内容服务。

本服务的目标：

1. 提供课程知识库检索，返回可引用的 Top-K 视频片段与权威起止秒。
2. 提供片段详情与短时效签名 HLS 播放会话，支撑插件内视频定位。
3. 提供设备码授权与令牌轮换，把云端凭据限制在插件 Host 侧。
4. 为后续账号、内容后台、指标与学习进度预留清晰边界。

**不做**：生成式大模型推理、模型 API Key 托管、全库正文下发、第三方分析 SDK。语音转写（ASR）是唯一允许的模型能力：只做语音→文字，不生成内容，密钥仅存云端环境变量。

**不耦合 `ai-invest`**：独立仓库、独立数据库、独立鉴权与用户体系；只借鉴 PostgreSQL halfvec + pg_trgm + RRF 的技术选型与调优经验。

## 2. 调用方与角色

| 角色 | 说明 |
|---|---|
| 学员插件 | `dsh-plugin-trend-coach` Host 半，携带 Bearer 与 `x-device-id` 调用业务接口 |
| 浏览器播放器 | 只拿签名 `playlistUrl`，直接向媒体域取流，不持 Bearer |
| 学员账号 | 管理员创建；首次用一次性邀请码设置密码，或由管理员直接设初始密码；设备授权页登录后绑定设备 |
| 内容运营 / 管理员 | 后台账号（用户名 + 密码）登录控制台，按角色管理账号、课程、知识点、文章与索引 |

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
- 设备批准必须绑定已存在的账号：学员在授权页用用户名密码，或用一次性邀请码设置密码后批准；运营/管理员可用后台会话代批并指定 `userId`。不再使用共享控制台令牌。
- grant 只存在于插件 Host 与 dsh credentials，云端不得把令牌下发给浏览器、写入日志或返回额外字段。

### C5 指标事件（M2，P1，待冻结）

- 端点建议 `POST /v1/events`，必须鉴权、字段白名单、用户同意后可上报且可撤回。
- 一期字段：`search_requested`（耗时、topK、命中数、是否空召回）、`citation_clicked`（segmentId）、`player_started`（起播耗时、是否自动播放被拒）、`feedback_submitted`（评分 up/down）。
- 不采集 query 原文、回答内容、完整播放地址；未登录或无 consent 不上报。

### C6 内容与索引管线（M1 起，P0）

- 输入：录播视频、带时间戳转写、章节/知识点切分、课程文章、片段映射。
- 输出：已发布课程、知识点、片段、索引；发布与索引分离，未审核内容不进入问答。
- 转写、文章、视频片段必须共享同一知识点 ID。
- 片段映射粒度为秒；一章可拆多个知识点片段。

### C7 后台管理（M3，P0）

- 用户与权限、课程内容管理、索引重建/召回测试、模型配置（仅内容生产）、运营看板、插件版本与灰度。
- 学员不可访问后台接口；越权返回 `401/403`；密钥不明文落库、不进日志与响应。
- M3.1 交付账号与登录基础；M3.2 交付 React 后台内容控制台。
- M3.2 范围：课程、章节、知识点、文章与片段的创建/修改、发布/归档；文章保存即版本递增，发布时写入 `publishedAt`；片段可编辑标题、起止秒和文本。媒体上传、召回评估、运营看板、插件版本与灰度不在本期。
- 内容写接口仅 `operator`/`admin` 会话可用；账号管理仍仅 `admin`。发布/归档即时影响学员可见性：课程非 `published` 时其下内容对学员不可见；文章与片段状态独立。
- 控制台 `/admin` 为 React 单页应用，构建产物由服务端静态托管；会话令牌只存浏览器 `sessionStorage`，关闭页面即清除；接口逐请求鉴权，静态资源不影响鉴权边界。
- 配置 embedding 时支持 `POST /v1/admin/content/reindex` 按课程重建片段向量；未配置返回 `409`，不静默跳过。

### C8 账号与后台登录（M3.1，P0）

- 账号由管理员创建，字段：`username`（3–32，小写字母开头，唯一）、`displayName`、`role`（`student/operator/admin`）、`status`（`active/disabled`）。
- 创建或重置时可直接设置初始密码，或生成一次性邀请码（默认 7 天有效，单次使用）；邀请码只返回一次，服务端只存哈希。
- 密码 10–128 字符，使用带随机盐的 scrypt 存储；任何接口、日志与错误消息不得回显密码或哈希。
- 后台登录 `POST /v1/auth/session`：`{ username, password }` → 会话令牌；默认 12 小时有效，只存哈希，支持注销与自助改密；改密、禁用或角色变更立即吊销该账号后台会话。
- 角色边界：`admin` 可创建/修改账号与重置凭据；`operator` 可读用户列表并做内容运营；`student` 不可登录控制台、不可访问 `/v1/admin/*`。
- 首个管理员由启动配置 `BOOTSTRAP_ADMIN_USERNAME` / `BOOTSTRAP_ADMIN_PASSWORD` 在库中无管理员时创建；密码至少 12 字符，不写日志。
- 登录、邀请码兑换与设备批准按 IP 限流；账号禁用后其设备令牌立即不可用。

### C9 体系数据与学习进度（M3，P0）

- 新增只读体系接口：`GET /v1/catalog/courses`、`GET /v1/catalog/courses/{courseId}`、`GET /v1/catalog/knowledge-points/{knowledgePointId}`；只返回 `published` 课程、章节、知识点与文章，未发布或不存在返回 `404`。
- 新增进度接口：`PUT /v1/progress/knowledge-points/{knowledgePointId}`，请求 `{ watchedSec, completed }`；按当前授权用户与设备写入，幂等，`watchedSec` 取历史最大值，`completed` 一旦为 `true` 不可回退。
- 进度是业务写入，不走 `POST /v1/events`，不受指标同意开关影响；只允许读写本人进度，设备不匹配 `403`，越限 `429`。
- 课程树不得携带 `startSec/endSec`；片段定位仍以 `GET /v1/kb/segments/{segmentId}` 为唯一权威来源。`segmentId` 可缺省，表示该知识点暂无可用片段。
- 响应边界：课程列表 ≤50；单课程 ≤50 章节、总知识点 ≤1000；标题 ≤200 字符；单次响应 ≤512KiB；文章 `markdown` ≤20000 字符，只允许 Markdown 子集，不下发可执行 HTML/脚本。
- 后台管理接口不属于插件契约；学员令牌不可访问，越权返回 `401/403`。


### C10 语音转写（M4.2，P0）

- 新增 `POST /v1/asr/transcribe`：请求 `{ audio: "<base64 WAV>", format: "wav", durationMs }`，返回 `{ text, durationMs }`。
- 音频边界：解码后 ≤1,920,044B（60s）；RIFF/WAVE、PCM（format=1）、单声道、16000Hz、16bit；`data` 字节换算时长与 `durationMs` 误差 ≤1s；`durationMs` 为整数 1–60,000；路由级请求体上限 3MiB。
- 文本边界：去除控制字符、折叠空白、trim 后 1–2000 字符；空结果 `422`，不返回空串。
- 上游：MiniMax `POST {base}/v1/speech_to_text`（Bearer；multipart `file=audio/wav` + `model` + `response_format=json`），默认 `base=https://api.minimaxi.com`、`model=asr-1.0`。业务错误为 HTTP 200 + `base_resp.status_code != 0`。
- 鉴权与限流：Bearer + `x-device-id`；按设备限流 `RATE_LIMIT_ASR_PER_MINUTE`（默认 20）。未配置 `ASR_API_KEY` 时 local 返回 `503`；staging/production 启动失败。
- 错误：`400` 入参/音频非法；`401/403` 鉴权；`413` 请求过大；`422` 未识别；`429` 限流；`502` 上游协议异常；`503` 上游不可用或未配置。不自动重试。
- 隐私：音频与转写只经内存转发到 MiniMax，不落盘、不落日志、不进入指标；日志只记错误类别，不记 `status_msg`、正文或完整 deviceId。

## 4. 非功能需求

| 类别 | 要求 |
|---|---|
| 可用性 | 知识与视频服务 ≥99.5%；staging/production 分离，有效 TLS |
| 性能 | 检索 P95 ≤300ms（云端侧）；视频起播 ≤2s（CDN）；分片支持 Range |
| 安全 | HTTPS + Bearer + `x-device-id`；按用户/设备限流；业务只读；最小权限 |
| 隐私 | 数据最小化；支持注销；敏感字段脱敏；日志不记 token、完整 query、完整 deviceId；语音音频与转写不落盘、不落日志、不进指标 |
| 成本 | ASR 按音频时长计费；单次 ≤60s、按设备限流；不做自动重试，避免重复计费 |
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
| 体系 | 课程列表 / 课程树 / 知识点详情 | 仅已发布内容；字段与边界合法；不携带起止秒 |
| 体系 | 未发布或不存在 | `404`；学员令牌访问后台接口 `401/403` |
| 进度 | 上报后回读 | `watchedSec` 取最大值、`completed` 不回退、重复上报幂等 |
| 进度 | 非本人设备 | `403`；超限 `429`；不受指标同意开关影响 |
| 账号 | 管理员创建 + 邀请码首次登录 | 邀请码单次有效；密码 10–128；账号与角色可回读 |
| 账号 | 登录 / 注销 / 改密 / 禁用 | 会话只存哈希；注销改密禁用后旧会话失效；禁用后设备令牌 `401` |
| 账号 | 越权访问 `/v1/admin/*` | 未登录 `401`；学员 `403`；运营不可写账号 |
| 设备授权 | 学员账号登录批准 | 设备绑定到该账号；未知账号/错误密码 `401`；成功后 grant 可用 |
| 设备授权 | 运营/管理员代批 | 需后台会话；可指定 `userId`；学员令牌不可代批 |
| 语音 | 合法 WAV（16kHz/单声道/PCM16，≤60s） | `200`，返回清洗后的 `text` 与 `durationMs` |
| 语音 | 未鉴权 / 设备不匹配 | `401` / `403` |
| 语音 | 非法 base64、非 WAV、立体声/44.1k/8bit、时长不符 | `400` |
| 语音 | 请求体 >3MiB / 音频 >1,920,044B | `413` |
| 语音 | 上游返回空文本或 `base_resp.status_code != 0` | `422` / `502` |
| 语音 | 上游 429 / 5xx / 超时 | `429` / `503`，不自动重试 |
| 语音 | 超过按设备限流 | `429` |
| 语音 | 未配置 `ASR_API_KEY`（local） | `503`；staging/production 启动失败 |
| 语音 | 日志检查 | 无 base64、无转写正文、无完整 deviceId |

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
| M4.2 | 语音转写（MiniMax ASR）、限流与密钥配置 | 契约测试通过；真实 MiniMax 需 `ASR_API_KEY` |
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
| 账号体系与后台登录方式 | 已定（M3.1）：管理员创建账号，密码或一次性邀请码首次登录；角色 student/operator/admin；后台会话默认 12 小时；短信登录后置 | 已替代临时 `CONSOLE_TOKEN`；短信开放时补充绑定与找回流程 |
| 文章范围与长度 | 单知识点 Markdown ≤20000 字符、仅 Markdown 子集，不含 HTML/脚本 | 内容运营与插件渲染边界 |
| 公测期可见范围 | 所有已登录学员可见全部已发布课程，不引入选课/权限分组 | 课程列表与进度模型复杂度 |
| ASR 供应商与模型 | MiniMax `asr-1.0`；保留 provider 接口，暂不做多供应商切换 | 供应商抖动与成本 |
| 语音成本上限 | 单次 ≤60s、每设备 20 次/分钟；不做自动重试 | 滥用与账单 |

## 10. 关联文档

- [云端服务对接清单](../architecture/cloud-service-integration-checklist.md)
- [云端架构设计](../architecture/architecture-design.md)
- [项目规范](../conventions/project-conventions.md)
- 插件仓库：`../dsh-plugin-trend-coach`（PRD v1.3 §6、架构 §6/§9/§10/§12）
