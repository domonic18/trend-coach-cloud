# 监控与告警

版本：v0.3（2026-11-01）

云端保留 `/metrics` 指标接口，但**默认不部署 Prometheus/Grafana**。需要监控时，由部署方把外部 Prometheus 指向该接口；本文另提供可选的抓取、告警与看板模板。

## 1. 指标

`GET /metrics` 由 `src/metrics.ts` 生成，Prometheus 文本格式，需 `Authorization: Bearer $METRICS_TOKEN`。

| 指标 | 标签 | 用途 |
|---|---|---|
| `trend_coach_http_requests_total` | `method`、`route`、`status` | 请求量、5xx/429 比例 |
| `trend_coach_http_request_duration_seconds` | `method`、`route`、`status` | P50/P95 延迟（直方图） |
| `trend_coach_pipeline_jobs_total` | `kind`、`status` | 管线任务成功/失败/取消量 |
| `trend_coach_pipeline_job_duration_seconds` | `kind`、`stage` | 各阶段耗时（直方图） |
| `trend_coach_pipeline_queue_depth` | `kind` | 队列积压 |
| `trend_coach_pipeline_transcript_chunks_total` | `status` | 转写块成功/失败，观察上游稳定性 |
| `trend_coach_pipeline_generation_total` | `status`、`reason` | 生成成功、预算拒绝、待审比例 |
| `trend_coach_pipeline_publish_total` | `result` | 发布与索引成败 |
| `trend_coach_process_*`、`trend_coach_nodejs_*` | 默认标签 | CPU、内存、事件循环、GC |

约束：

- `route` 使用注册模板（如 `/v1/kb/segments/:segmentId`），不使用实际路径，避免标签基数膨胀。
- 指标不包含 token、设备 ID、query 原文、片段内容、转写正文、源路径或播放地址。
- 管线指标只按 `kind/status/stage/reason` 聚合，不使用素材 ID、课程 ID、任务 ID 作标签。
- 业务事件（检索/引用/播放/满意度）留在事件表，不转成指标标签。
- AI 用量不做 Prometheus 指标：token、成本、任务/模型维度与单次运行链路在 `/v1/admin/ai/usage/*`、`/v1/admin/ai/runs` 查看；`/metrics` 只覆盖这些请求自身的 HTTP 计数与耗时。用量表只记数字与模型标识，不含 prompt、正文或用户身份。

## 2. 接入外部 Prometheus

`/metrics` 不改变部署形态，外部 Prometheus 可直接抓取，亦可经反向代理转发。抓取时需要 Bearer token：

```yaml
scrape_configs:
  - job_name: trend-coach
    metrics_path: /metrics
    scheme: https
    authorization:
      type: Bearer
      credentials_file: /etc/prometheus/metrics_token
    static_configs:
      - targets: ["api.example.com"]
```

`metrics_token` 文件内容为 `METRICS_TOKEN`，权限 600。示例配置在 `deploy/monitoring/prometheus.yml`，告警规则在 `deploy/monitoring/alerts.yml`，Grafana 看板 JSON 在 `deploy/monitoring/grafana/dashboards/trend-coach.json`，可按现有监控体系取用或删除，均不参与 Compose 启动。

验证：

```bash
curl -fsS -H "Authorization: Bearer $METRICS_TOKEN" https://$DOMAIN/metrics | head
```

## 3. 告警规则（模板）

| 告警 | 条件 | 持续 | 级别 |
|---|---|---|---|
| `TrendCoachDown` | `up{job="trend-coach"} == 0` | 2m | critical |
| `TrendCoachHigh5xxRate` | 5xx 请求占比 > 1% | 5m | critical |
| `TrendCoachSearchLatencyHigh` | `/v1/kb/search` 成功请求 P95 > 300ms | 10m | warning |
| `TrendCoachRateLimitSpike` | 429 请求占比 > 5% | 10m | warning |
| `TrendCoachPipelineFailures` | 10 分钟内 `pipeline_jobs_total{status="failed"}` 增加 ≥3 | 0m | warning |
| `TrendCoachPipelineQueueBacklog` | `pipeline_queue_depth > 3` | 30m | warning |
| `TrendCoachPipelineStale` | `rate(pipeline_transcript_chunks_total{status="failed"}[15m]) > 0.2` | 15m | warning |
| `TrendCoachPublishIndexFailed` | 15 分钟内 `pipeline_publish_total{result="index_failed"}` 增加 | 0m | critical |

通知渠道（Alertmanager、飞书、邮件）由部署方现有的监控体系接入。

## 4. 排障入口

| 现象 | 先看 | 下一步 |
|---|---|---|
| 服务不可达 | `docker compose ps`、`/health`、数据库日志 | 数据库不可用先恢复数据库；app 崩溃看 stdout 日志 |
| 5xx 升高 | app JSON 日志的 `statusCode` 与 `err` | 区分数据库超时、embedding 依赖、未处理异常 |
| 检索 P95 升高 | 数据库慢查询与连接数 | 检查 pgvector 索引、`SEARCH_MIN_*` 配置与 embedding 超时 |
| 429 升高 | 按路由与设备来源统计，响应带 `Retry-After: 60` | 确认是否异常客户端；调整 `RATE_LIMIT_*` 前先评估成本 |
| 管线任务失败 | `pipeline_jobs.error_code` 与阶段耗时 | ffmpeg 超时/磁盘满/ASR 429 分开处理；先确认 `/health` 与磁盘余量 |
| 管线队列积压 | `pipeline_queue_depth`、CPU 与 ffmpeg 进程 | 单 worker 并发 1 是默认值；扩容前评估 API 延迟与磁盘 IO |
| 发布返回 503 | 是否配置 embedding、reindex 错误类别 | 索引失败不翻课程状态；修复 provider 后重试发布 |
| 转写块失败率高 | `transcript_chunks` 失败数、上游错误类别 | 上游 429/5xx 会重试；持续失败检查密钥与限流 |
| AI 成本或失败率异常 | `/v1/admin/ai/usage/summary` 按任务/模型与错误码 | 先看 `/v1/admin/ai/health` 是否冷却；主备绑定与价格在后台「模型配置」核对 |
| 门户登录/注册 429 升高 | 按路由统计的 429 与来源 IP | 登录按 IP+用户名双维度限流；确认是否为脚本撞库，必要时临时调 `RATE_LIMIT_*` |

容量基线：单实例 2 vCPU 可承载日常检索；持续 CPU > 70% 或 P95 接近阈值时先扩容 app 实例（迁移有 advisory lock，可安全多实例），再考虑数据库规格。

## 5. 压测基线

`scripts/load-test.mjs`（`npm run loadtest`）是零依赖固定并发压测脚本，用于发布前后对比与容量评估。默认读环境变量传令牌，避免密钥进入 shell 历史：

```bash
# 公开端点
npm run loadtest -- --base-url http://127.0.0.1:3939 --path /health --concurrency 20 --duration 20

# 鉴权端点（令牌与设备 ID 只从环境变量读取）
LOAD_TEST_TOKEN=$SESSION_TOKEN LOAD_TEST_DEVICE_ID=$DEVICE_ID \
  npm run loadtest -- --path /v1/catalog/courses --concurrency 10 --duration 20 --max-p95-ms 300

# CI 汇总
npm run loadtest -- --json --duration 30 | tee loadtest.json
```

- 阈值：默认 P95 ≤500ms、错误率 ≤1%（网络错误 + 5xx + 非 429 的 4xx）；`--max-p95-ms`、`--max-error-rate` 可按端点调整。
- `429` 单独计数并提示：命中限流说明配额先于容量到顶；压测账号应单独准备，或临时调高 `RATE_LIMIT_*`，不要混入普通用户配额。
- 不在生产压写接口；读接口压测避开业务高峰，记录机器规格、并发与 P95，作为下次发布的对照基线。
- 脚本超时（`--timeout-ms`）与预热（`--warmup`）默认 10s / 1s，预热请求不计入统计。

公测放行前建议至少覆盖：`/health`、`/v1/catalog/courses`、`/v1/kb/search`（单设备配额内）、`POST /v1/playback/sessions`（单设备并发上限内），并同时观察 `/metrics` 的 5xx、429 与 P95。
