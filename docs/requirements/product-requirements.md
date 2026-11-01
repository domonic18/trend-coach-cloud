# 趋势交易课程云端服务需求

版本：v0.6（2026-11-01）
状态：与插件 PRD v1.6 §6、架构 §6/§9/§10/§12 对齐；v0.6 新增 M8 教材阅读层（章节教材、关键帧与文生图图示、短时签名图片、旧课程重生成）；v0.5 新增公开门户与开放注册（C11）、AI 用量与任务级模型路由（C12）；v0.4 补充 M6 公测加固（限流覆盖、压测、恢复演练、合规清单）；v0.3 将 C6 细化为 M1 视频→课程全链路（上传/转码、长音频转写、切分、文章草稿、人工发布）；v0.2 新增 M4.2 语音转写（MiniMax ASR）；接口细节见 [对接清单](../architecture/cloud-service-integration-checklist.md)。

## 1. 背景与目标

`dsh-plugin-trend-coach` 是学员本地 dsh 客户端中的伴学插件：推理走学员自己的模型（BYOK），云端只提供课程知识与内容服务。

本服务的目标：

1. 提供课程知识库检索，返回可引用的 Top-K 视频片段与权威起止秒。
2. 提供片段详情与短时效签名 HLS 播放会话，支撑插件内视频定位。
3. 提供设备码授权与令牌轮换，把云端凭据限制在插件 Host 侧。
4. 提供公开门户、开放注册与个人中心，让学员自助了解体系、安装插件并管理账号与设备。
5. 为云端 AI 任务提供用量账本、运行链路与任务级主备模型路由，支撑成本与稳定性运营。
6. 为内容后台、指标与学习进度提供清晰边界。

**不做**：学员侧生成式大模型推理、模型 API Key 托管、全库正文下发、第三方分析 SDK、客服/工单系统。云端模型能力仅限：语音转写（ASR）、查询 embedding，以及仅管理端内容生产使用的内容 LLM（生成章节/知识点/章节教材草稿）与文生图模型（生成图示）。内容 LLM 的产物必须人工审核并显式发布，不得自动进入检索；密钥仅存云端数据库或环境变量，不进浏览器、插件与日志。

**不耦合 `ai-invest`**：独立仓库、独立数据库、独立鉴权与用户体系；只借鉴 PostgreSQL halfvec + pg_trgm + RRF 的技术选型与调优经验。

## 2. 调用方与角色

| 角色 | 说明 |
|---|---|
| 访客 | 无需登录浏览门户公开页（体系、功能、向导、下载、FAQ）与公开接口（发布清单、统计） |
| 学员插件 | `dsh-plugin-trend-coach` Host 半，携带 Bearer 与 `x-device-id` 调用业务接口 |
| 浏览器播放器 | 只拿签名 `playlistUrl`，直接向媒体域取流，不持 Bearer |
| 学员账号 | 可在门户自助注册；也可由管理员创建并用一次性邀请码设置密码；设备授权页登录后绑定设备 |
| 内容运营 / 管理员 | 后台账号（用户名 + 密码）登录控制台，按角色管理账号、课程、知识点、文章与索引；运营/管理员可查看 AI 用量与运行，任务绑定仅管理员 |

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

### C6 视频→课程管线（M1，P0）

- 输入：单个录播视频 + 课程标题；输出：可人工审核的章节、章节教材、知识点、图示、片段映射、HLS 与带时间戳转写。
- 媒体素材：`POST /v1/admin/content/media-assets` 绑定 `draft` 课程；`PUT .../source` 流式上传 `application/octet-stream`（≤2GiB，可选 `x-file-sha256` 校验）；ffprobe 必须同时检测到视频流与音频流，时长 ≤14400s，否则 `422`；失败素材可重传，不做物理删除（`archived`）。
- 转码：单码率 H.264/AAC HLS（6s 分片、VOD），产物原子发布；本地文件系统经 `MediaStore` 抽象预留对象存储。播放仅选择 `status=ready` 且 `hls_path` 非空的最新素材。
- 转写：ffmpeg 抽取 16kHz 单声道 PCM16 WAV；`silencedetect` 切块 ≤480s；调用 MiniMax 长音频转写（`verbose_json` + sentence 时间戳），逐块缓存、每块最多 3 次重试；全部完成后合并为全局时间戳，按 ≤30s 分组写入数据库。已成功块不重复计费。
- 切分与生成：先基于转写节选与总时长生成全局章节大纲（3–6 章，单章不短于 5 分钟），再按 600s 窗口调用内容 LLM（最多 24 窗口）生成 ≤8 个知识点，`chapterTitle` 从全局大纲中选择；知识点 `excerpt` 必须逐字锚定，无法锚定标 `excerpt_not_found`，置信度 <0.6 标 `low_confidence`；按标题去重、同一时间段去重，无知识点的章节丢弃，只有一个知识点的章节合并到相邻章节。片段由知识点时间窗与转写片段交集确定性生成，≤120s/4000 字，超限在转写片段边界拆分。**不再生成知识点文章**；改为每章一次章节教材生成：章节转写按知识点锚点切成 3–6 节，先逐节摘要，再合成 1500–3000 字 Markdown（H2 分节、只用转写事实、正文可带知识点/片段锚点），走安全 Markdown 与 ≤20000 字校验；失败标 `article_invalid`、正文 <1200 字标 `article_short`。
- 图示生成：章节教材生成后规划 0–3 张图/章（价值低不硬凑），来源两类：① 原视频关键帧（按知识点时间锚点抽帧、去重与清晰度过滤）；② Seedream 文生图（直连火山方舟 `/images/generations`，默认 `doubao-seedream-5-0-260128`，2K，每图 2 候选）。文生图只做无长段文字的示意图，禁止生成写实 K 线/收益曲线/行情截图；每图记录 prompt、model、seed 与来源。图片生成放在独立 `illustrate` 作业，失败只标该图，不阻塞教材与课程发布。
- 任务编排：`pipeline_jobs` 状态 `queued/running/succeeded/failed/canceled`，ingest 阶段 `probe→transcode→transcribe→finalize`，generate 阶段 `structure→generate→finalize`，illustrate 阶段 `figure_plan→figure_render→finalize`；支持取消、重试、心跳与崩溃恢复；同一素材同类型同时最多一个 active job；失败只暴露稳定 `error_code` 与静态文案。
- 审核与发布：生成结果只写 `draft`，不得自动发布；`apply` 单事务把章节、章节教材、知识点、图示与片段写入草稿课程；`POST /v1/admin/content/courses/{courseId}/publish` 需显式调用，配置 embedding 时先重建索引，失败返回 `503` 且不翻状态；发布前校验教材中每个 `figure:` 引用都有已选中的已发布图片，否则 `409` 并列出缺失项。
- 边界：内容生产 LLM 只允许管理端会话调用；`sourceRelPath`、`hlsPath`、SHA、ffmpeg stderr、provider 原始响应与生成正文不进列表/预览响应或日志；转写正文只经管理端转写接口返回。
- 隐私与留存：源视频、转写与生成草稿用于建课并持久化；清理策略未冻结前不自动删除，版权授权由运营保证；学员侧 ASR 音频与文本仍不落盘（C10）。
- 转写、章节教材、图示与视频片段必须能回溯到同一章节/知识点；片段映射粒度为秒。

### C7 后台管理（M3，P0）

- 用户与权限、课程内容管理、索引重建/召回测试、模型配置（仅内容生产）、运营看板、插件版本与灰度。
- 学员不可访问后台接口；越权返回 `401/403`；密钥不明文落库、不进日志与响应。
- M3.1 交付账号与登录基础；M3.2 交付 React 后台内容控制台。
- M3.2 范围：课程、章节、知识点、文章与片段的创建/修改、发布/归档；文章保存即版本递增，发布时写入 `publishedAt`；片段可编辑标题、起止秒和文本。媒体上传与自动建课由 M1 C6 提供；召回评估看板、运营看板、插件版本与灰度不在本期。M8 起知识点文章由章节教材取代，图示在后台按章节审核选图。
- 内容写接口仅 `operator`/`admin` 会话可用；账号管理仍仅 `admin`。发布/归档即时影响学员可见性：课程非 `published` 时其下内容对学员不可见；章节教材、图示与片段状态独立。
- 控制台 `/admin` 为 React 单页应用，构建产物由服务端静态托管；会话令牌只存浏览器 `sessionStorage`，关闭页面即清除；接口逐请求鉴权，静态资源不影响鉴权边界。
- 配置 embedding 时支持 `POST /v1/admin/content/reindex` 按课程重建片段向量；未配置返回 `409`，不静默跳过。

### C8 账号与后台登录（M3.1，P0）

- 后台账号由管理员创建；学员可在门户自助注册（见 C11），注册只创建 `student`。字段：`username`（3–32，小写字母开头，唯一）、`displayName`、`role`（`student/operator/admin`）、`status`（`active/disabled`）。
- 创建或重置时可直接设置初始密码，或生成一次性邀请码（默认 7 天有效，单次使用）；邀请码只返回一次，服务端只存哈希。
- 密码 10–128 字符，使用带随机盐的 scrypt 存储；任何接口、日志与错误消息不得回显密码或哈希。
- 后台登录 `POST /v1/auth/session`：`{ username, password }` → 会话令牌；默认 12 小时有效，只存哈希，支持注销与自助改密；改密、禁用或角色变更立即吊销该账号后台会话。
- 角色边界：`admin` 可创建/修改账号与重置凭据；`operator` 可读用户列表并做内容运营；`student` 不可登录控制台、不可访问 `/v1/admin/*`。
- 首个管理员由启动配置 `BOOTSTRAP_ADMIN_USERNAME` / `BOOTSTRAP_ADMIN_PASSWORD` 在库中无管理员时创建；密码至少 12 字符，不写日志。
- 登录、邀请码兑换与设备批准按 IP 限流；账号禁用后其设备令牌立即不可用。

### C9 体系数据与学习进度（M3，P0）

- 只读体系接口：`GET /v1/catalog/courses`、`GET /v1/catalog/courses/{courseId}`、`GET /v1/catalog/courses/{courseId}/chapters/{chapterId}`、`GET /v1/catalog/knowledge-points/{knowledgePointId}`；只返回 `published` 内容，未发布或不存在返回 `404`。课程树返回 `contractVersion`（M8 起为 `2`），插件低于最低支持版本时提示升级。章节教材取代知识点文章：章节接口返回 `markdown` 与图片清单（`figureId/url/width/height/alt/caption`，`url` 为 10–15 分钟签名）；知识点详情只返回章节引用、片段与相邻知识点，不再返回 `article`。
- 新增进度接口：`PUT /v1/progress/knowledge-points/{knowledgePointId}`，请求 `{ watchedSec, completed }`；按当前授权用户与设备写入，幂等，`watchedSec` 取历史最大值，`completed` 一旦为 `true` 不可回退。
- 进度是业务写入，不走 `POST /v1/events`，不受指标同意开关影响；只允许读写本人进度，设备不匹配 `403`，越限 `429`。
- 课程树不得携带 `startSec/endSec` 或教材正文；仅返回章节与知识点目录，教材按章节懒加载。片段定位仍以 `GET /v1/kb/segments/{segmentId}` 为唯一权威来源。`segmentId` 可缺省，表示该知识点暂无可用片段。
- 响应边界：课程列表 ≤50；单课程 ≤50 章节、总知识点 ≤1000；标题 ≤200 字符；单次响应 ≤512KiB；章节教材 `markdown` ≤20000 字符、单章图片 ≤3，只允许 Markdown 子集，不下发可执行 HTML/脚本；图片 URL 只允许签名地址，不含长期令牌。
- 后台管理接口不属于插件契约；学员令牌不可访问，越权返回 `401/403`。


### C10 语音转写（M4.2，P0）

- 新增 `POST /v1/asr/transcribe`：请求 `{ audio: "<base64 WAV>", format: "wav", durationMs }`，返回 `{ text, durationMs }`。
- 音频边界：解码后 ≤1,920,044B（60s）；RIFF/WAVE、PCM（format=1）、单声道、16000Hz、16bit；`data` 字节换算时长与 `durationMs` 误差 ≤1s；`durationMs` 为整数 1–60,000；路由级请求体上限 3MiB。
- 文本边界：去除控制字符、折叠空白、trim 后 1–2000 字符；空结果 `422`，不返回空串。
- 上游：MiniMax `POST {base}/v1/speech_to_text`（Bearer；multipart `file=audio/wav` + `model` + `response_format=json`），默认 `base=https://api.minimaxi.com`、`model=asr-1.0`。业务错误为 HTTP 200 + `base_resp.status_code != 0`。
- 鉴权与限流：Bearer + `x-device-id`；按设备限流 `RATE_LIMIT_ASR_PER_MINUTE`（默认 20）。ASR 连接与密钥由后台「模型配置」维护（M4.3）；未配置或未启用时返回 `503`，不阻止服务启动。
- 错误：`400` 入参/音频非法；`401/403` 鉴权；`413` 请求过大；`422` 未识别；`429` 限流；`502` 上游协议异常；`503` 上游不可用或未配置。不自动重试。
- 隐私：音频与转写只经内存转发到 MiniMax，不落盘、不落日志、不进入指标；日志只记错误类别，不记 `status_msg`、正文或完整 deviceId。

### C11 公开门户与账号自助（M7，P0）

- 门户与后台同域部署：`/` 首页、`/system` 体系、`/features` 功能、`/guide` 安装向导、`/downloads` 版本下载、`/faq`、`/legal/privacy`、`/legal/terms`；`/admin` 保持独立控制台。门户内容来自仓库 Markdown，不做 CMS。
- 预渲染：构建期生成各路由静态 HTML、`routes.json`、`sitemap.xml` 与 `robots.txt`；深链刷新直接返回对应 HTML。未知前端路径返回 SPA 壳并带 `x-robots-tag: noindex`，`/v1/*` 未知路径仍为 JSON `404`。
- 注册 `POST /v1/portal/auth/register`：`username`（3–32，小写字母开头，`[a-z0-9._-]`）+ 密码（10–128），可选 `displayName`；只创建 `student`；成功后直接返回门户会话。用户名冲突 `409`，按 IP 限流。
- 登录 `POST /v1/portal/auth/login`：任意非禁用账号；返回 `{ token, expiresAt, user }`；按 IP 与用户名双维度限流，失败统一 `401`，超限 `429`。
- 门户会话与后台会话同表不同 `scope`（`portal`/`console`）；学员令牌只能访问 `/v1/portal/*`，访问 `/v1/admin/*` 一律 `401/403`。
- 个人中心：`GET/PATCH /v1/portal/me`、`POST /v1/portal/me/password`（改密后吊销其他会话）、`GET /v1/portal/me/devices`、`DELETE /v1/portal/me/devices/{deviceId}`（只能操作本人设备）。
- 公开数据：`GET /v1/portal/releases` 返回 `content/releases.json` 发布清单（dsh 版本、插件包文件名、SHA-256、大小、发布日期、更新说明）；`GET /v1/portal/stats` 返回已发布课程/知识点/片段/文章计数；两者 `max-age=60`，不返回内部路径。
- 下载文件位于 `dist/downloads/`，由服务端以 `Content-Disposition: attachment` 提供；发布清单缺失或格式错误时返回空版本，不返回 `500`。
- 不提供邮件/短信验证与找回密码；忘记密码走管理员重置。客服/联系入口不在本期。

### C12 AI 用量与任务级模型路由（M7，P0）

- 云端 AI 任务白名单：`content.outline`、`content.points`、`content.chapter`、`content.figure`、`content.image`、`embedding.query`、`embedding.segment`、`asr.longform`。每次调用写一条用量账本，只记数字与模型标识（任务、provider、model、configId、输入/输出/缓存 token、音频秒数、字符数、出图张数、延迟、状态、错误码），不落 prompt、转写正文、图片内容或音频。
- `ai_runs` 记录一次业务运行的来源（`pipeline`/`admin`）、主配置、是否降级、耗时与汇总；`ai_run_steps` 记录每次尝试（主/备、序号、用量 ID、错误码）。`GET /v1/admin/ai/runs/{runId}` 返回步骤链。
- 后台读接口（operator/admin）：`GET /v1/admin/ai/usage/summary?from&to&task`（总量、按日、按任务、按模型、估算成本）、`GET /v1/admin/ai/usage/events`（游标分页明细）、`GET /v1/admin/ai/runs`、`GET /v1/admin/ai/runs/{runId}`、`GET /v1/admin/ai/bindings`、`GET /v1/admin/ai/health`。
- `PUT /v1/admin/ai/bindings/{taskKey}` 仅 admin：为 LLM 任务指定主/备模型（备用可为空）；主备必须同用途且启用，主备相同 `400`，未绑定则回落到现有「按用途默认启用模型」。
- 自动切换：主模型出现 429/5xx/网络/超时等可重试错误时切到备用，仅单跳；两次调用都记用量，运行标 `fallback_used=true`，失败配置进入 60s 冷却（进程内 Map + `llm_config_health` 双写）；冷却期内直接走备用。
- 成本估算：`llm_configs` 增加输入/输出单价（微美元/千 token）与图片单价（微元/张，Seedream 默认 ¥0.12/张）；图片任务按 `images × 图片单价` 估算；任一参与计费的模型价格未配置时，该聚合成本返回 `null`，前端显示「未配置价格」，不猜测单价。
- 图片模型：`llm_configs.purpose` 增加 `image`，`protocol=openai`（走 `POST {base}/images/generations`），默认 `base=https://ark.cn-beijing.volces.com/api/v3`、`model=doubao-seedream-5-0-260128`；密钥只存密文。后台「模型配置」新增文生图条目与连通性测试（测试会真实出图，需提示计费）；`content.image` 只可绑定 `purpose=image` 的主/备配置。
- 图片限额：每章成图 0–3（默认目标 2）、每课 ≤24、每图 2 候选、每图最多重试 1 次；单课预算 ¥10、组织月度预算 ¥300，80% 预警、100% 硬停；硬停后章节教材照常发布，图片标「待生成」，不影响主链路。
- 时间范围：`from/to` 为 ISO 时间，默认最近 7 天；`from > to` 或格式非法 `400`；列表 `limit` 1–200（默认 50）；事件游标为 `usageId`，运行游标为 `startedAt:runId`。
- 后台 AI 读接口按账号限流；绑定写接口仅 admin；日志与响应不含 prompt、回答与密钥。

## 4. 非功能需求

| 类别 | 要求 |
|---|---|
| 可用性 | 知识与视频服务 ≥99.5%；staging/production 分离，有效 TLS |
| 性能 | 检索 P95 ≤300ms（云端侧）；视频起播 ≤2s（CDN）；分片支持 Range |
| 安全 | HTTPS + Bearer + `x-device-id`；门户会话 `scope=portal` 与后台隔离；按用户/设备/账号限流；业务只读；最小权限；管线上传先鉴权/限流再消费 body；ffmpeg/ffprobe 使用参数数组、禁止 shell |
| 隐私 | 数据最小化；支持注销；敏感字段脱敏；日志不记 token、完整 query、完整 deviceId、prompt 与生成正文；学员语音音频与转写不落盘、不落日志、不进指标；建课源视频/转写按管线规则持久化且不对外暴露路径 |
| 成本 | 学员 ASR 按音频时长计费、单次 ≤60s 且不做自动重试；长音频转写按块缓存成功结果，避免重复计费；内容 LLM 有窗口/知识点/文章与 token 预算上限；AI 用量按模型单价估算，价格缺失显示未配置 |
| 内容安全 | 云端文本按不可信数据处理；不得下发可执行指令；插件侧负责边界转义；生成内容必须人工审核，禁止自动发布 |
| 错误 | HTTP 状态码承载语义；响应必须为 JSON 对象；不得返回 HTML 错误页 |
| 可观测性 | 检索 P95、错误分桶、429/5xx、带宽、并发、索引任务状态；管线任务状态/阶段耗时/队列深度；AI 任务请求量/token/延迟/错误率/降级次数/估算成本/配置冷却状态 |

## 5. 数据与内容前置

- 至少一门真实课程完成结构化上线：带时间戳转写、章节/知识点、标题、片段映射；可由 M1 管线生成草稿后人工审核发布。
- 联调最小数据集：2 门课程、10+ 片段、一门加密 HLS 样片（含 key 与分片），以及一段 2–5 分钟中文样片用于管线验收。
- 视频加密方案（云点播私有加密或 AES-128）需与插件 hls.js 解密配置对齐；M1 生成的是未加密 HLS，靠签名 URL 保护。
- 真实课程与样片版权授权须覆盖转写、改写文章、入库检索；源视频保留期限由运营确认。

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
| 体系 | 课程列表 / 课程树 / 章节教材 / 知识点详情 | 仅已发布内容；章节教材可连续阅读；知识点详情不含文章；不携带起止秒 |
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
| 语音 | 未配置或未启用 ASR | `503`；服务可正常启动 |
| 语音 | 日志检查 | 无 base64、无转写正文、无完整 deviceId |
| 管线 | 创建素材 → 上传 → ingest | `202` 返回 job；转写就绪且时间戳单调；生成 HLS 可播放 |
| 管线 | 无音轨 / 超时长 / SHA 不符 / 非流式类型 | `422` / `400` / `415`，并清理半成品 |
| 管线 | 生成 → 预览 → apply | 章节/章节教材/知识点/图示/片段均为 `draft`；待审原因可见；重复 apply 返回原映射 |
| 管线 | 章节教材 | 每章 1500–3000 字、H2 分节；无知识点独立文章；单知识点章节被合并；正文只用转写事实 |
| 管线 | 发布课程 | 配置 embedding 时先重建索引；catalog/检索/播放可见；索引失败 `503` 且不翻状态；教材缺图 `409` |
| 图示 | 关键帧 + Seedream | 每章 ≤3 图、每图 2 候选；签名 URL 10–15 分钟可刷新；发布时缺图 `409` |
| 图示 | 成本与失败 | 单课 ≤¥10、月度 ≤¥300 硬停；图片失败只标该图，不影响教材发布 |
| 管线 | 取消 / 重试 / 心跳超时恢复 | 终态正确；同一素材同类型无重复 active job |
| 管线 | 学员令牌访问管线接口 | `403`；未登录 `401`；上传超限 `413` |
| 管线 | 响应与日志检查 | 无源路径、HLS 路径、SHA、provider 响应；转写正文仅管理端转写接口返回 |
| 管线 | 管线或 LLM/ASR 未配置 | 对应接口 `503`，服务仍可启动（`PIPELINE_ENABLED=false`） |
| 门户 | 直连刷新 `/`、`/guide`、`/system`、`/faq` | 返回对应预渲染 HTML；未知路径返回壳并 `noindex`；`/v1/nope` 仍 JSON `404` |
| 门户 | 注册 / 重复用户名 / 弱密码 / 限流 | `201` 自动登录；`409`；`400`；`429` |
| 门户 | 登录 / 注销 / 改密 / 设备解绑 | 会话 `scope=portal`；改密后其他会话失效；只能解绑本人设备 |
| 门户 | 学员令牌访问 `/v1/admin/*` | `401/403`；门户接口可用 |
| 门户 | 发布清单 / 统计 / 下载 | 清单缺失返回空版本；下载带 `attachment`；公开数据 `max-age=60` |
| AI | 生成任务产生用量 | `ai_usage_events` 记录 token/延迟/模型；`ai_runs` 与 steps 可查 |
| AI | 主模型 429 → 备用 | 自动切换、`fallback_used=true`、健康进入冷却；冷却期直接走备用 |
| AI | 成本估算 | 价格缺失返回 `null`；配置价格后按微美元/千 token 估算 |
| AI | 权限 | operator 可读用量/运行；绑定写仅 admin；学员 `403` |

质量门槛：召回评估集 Top-5 ≥90%；接口契约测试覆盖上表全部用例；压测满足 P95 与并发目标。真实 MiniMax ASR、content LLM（`MiniMax-M3.1-Flash`，anthropic 协议）与 embedding（智谱 `embedding-3`，1024 维）均已完成链路验证（2026-11-01，33 分钟中文样片，详见运维手册 §11），发布 `indexed=true` 且检索为词法 + 向量混合召回。

## 7. 指标与告警

- 业务：检索量、空召回率、引用点击率、播放起播成功率、问答满意度。
- 系统：检索 P95/P99、错误率分桶（400/401/403/404/429/5xx）、限流命中、数据库连接与慢查询、索引任务耗时与失败率、媒体带宽与并发。
- 告警：5xx/429 异常升高、检索 P95 超阈值、索引任务连续失败、证书到期、媒体签名失败率异常。

## 8. 里程碑

| 阶段 | 云端交付 | 出口标准 |
|---|---|---|
| M1 | 视频上传/转码、带时间戳长音频转写、章节/知识点/片段切分、文章草稿、人工发布与索引 | 1 门课程结构化上线，可检索；已落地并完成真实链路验收（ASR、content LLM、embedding） |
| M2 | 六个接口、设备码授权、签名 HLS、契约测试 | 对接清单验收通过，插件联调完成 |
| M3 | 后台管理、账号与体系数据、学习进度 | 内容可运营、用户可管理 |
| M4.2 | 语音转写（MiniMax ASR）、限流与密钥配置 | 契约测试通过；真实 MiniMax 已验收（后台录入密钥） |
| M6 | 公测加固：限流、压测、备份、合规 | 公测放行；已落地限流补齐、压测脚本、恢复演练与合规清单，账号注销/数据删除待完成 |
| M7 | 公开门户与自助账号、AI 用量账本、运行链路、任务级主备绑定与自动切换 | 门户深链可刷新；注册/登录/个人中心闭环；AI 调用可计量、主备可切换 |
| M8 | 教材阅读层（章节教材替换知识点文章）、视频关键帧与 Seedream 图示、短时签名图片、旧课程重生成 | 1 门课程按章连续阅读；每章图文完整；图片签名与成本限额验收通过 |

## 9. 待冻结事项

| 事项 | 当前建议 | 影响 |
|---|---|---|
| access/refresh TTL、并发设备数、吊销 | 待账号后台定稿 | 授权验收与安全策略 |
| 片段长度/注入策略 | 建议单片段 ≤2KB、总 ≤12KB；插件当前按 4KB/512KiB 校验 | 云端裁剪与插件上限需一致 |
| 引用 host | 暂用 `trend-coach.local`；换真实域名需插件同步 | 历史回答引用兼容 |
| 事件端点与同意模型 | 建议 `POST /v1/events`，默认关闭、可撤回 | 指标上报与隐私合规 |
| 视频加密方案 | 云点播私有加密或 AES-128 | hls.js 解密配置 |
| 相邻知识点阈值 | 空召回或最高分低于阈值（数值待定） | 召回质量 |
| 账号体系与后台登录方式 | 已定（M3.1/M7）：后台账号由管理员创建；学员可门户自助注册；密码或一次性邀请码首次登录；角色 student/operator/admin；后台会话默认 12 小时；短信登录后置 | 已替代临时 `CONSOLE_TOKEN`；短信开放时补充绑定与找回流程 |
| 教材范围与长度 | 已定：章节教材替换知识点文章；单章 1500–3000 字、≤20000 字符，仅 Markdown 子集，不含 HTML/脚本 | 内容运营与插件渲染边界 |
| 章节与知识点粒度 | 已定：3–6 章、单章 ≥5 分钟；知识点仅用于检索/锚点，单知识点章节合并 | 目录与阅读体验 |
| 图示配额与成本 | 已定：每章 2 张（上限 3）、每课 ≤24、每图 2 候选、¥0.12/张、单课 ¥10、月度 ¥300 | 成本与审核 |
| 文生图供应商 | 已定：直连火山方舟 Seedream 5.0 lite，备用 4.5；文生图不生成写实行情图 | 供应商稳定性与合规 |
| 关键帧筛选 | 建议先人工勾选，自动筛选后置 | 人力与质量 |
| 旧课程处置 | 已定：归档作废并重新生成，不做文章数据迁移 | 历史内容与审核 |
| 公测期可见范围 | 所有已登录学员可见全部已发布课程，不引入选课/权限分组 | 课程列表与进度模型复杂度 |
| ASR 供应商与模型 | MiniMax `asr-1.0`；保留 provider 接口，暂不做多供应商切换 | 供应商抖动与成本 |
| 语音成本上限 | 单次 ≤60s、每设备 20 次/分钟；不做自动重试 | 滥用与账单 |
| 内容 LLM 供应商与模型 | OpenAI 兼容 `/chat/completions`；连接信息在后台「模型配置」维护；只用于管理端草稿生成 | 生成质量、成本与供应商锁定 |
| 长音频转写参数 | 静音切块 ≤480s、每块最多 3 次重试、转写分组 ≤30s；MiniMax 真实时间戳字段需联调确认 | 计费、对齐精度与供应商限制 |
| 源视频与转写留存 | 默认保留、不自动清理；建议按版权授权人工归档 | 存储成本与合规 |
| 生成质量门槛 | 逐字锚定 + 置信度 0.6 + 人工发布；评估集与人工抽检比例待定 | 生成内容可用性 |
| 多码率与对象存储 | 本期单码率本地存储；`MediaStore` 预留 S3/MinIO | 带宽与扩容 |
| 门户内容维护 | 仓库内 Markdown + 构建期预渲染，不做 CMS | 内容更新需重新构建发布 |
| 门户会话安全 | 令牌存 `sessionStorage`，不引入刷新令牌与 Cookie | 新标签页需重新登录 |
| 客服/联系入口 | 本期不做，后续单独立项 | 门户转化与支持路径 |
| AI 限流与冷却 | 单实例内存实现，DB 记录健康状态 | 横向扩容前需换共享存储 |

## 10. 关联文档

- [云端服务对接清单](../architecture/cloud-service-integration-checklist.md)
- [云端架构设计](../architecture/architecture-design.md)
- [项目规范](../conventions/project-conventions.md)
- 插件仓库：`../dsh-plugin-trend-coach`（PRD v1.6 §6、架构 v1.6 §6/§9/§10/§12）
