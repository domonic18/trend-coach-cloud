# 监控与告警

版本：v0.1（2026-10-31）

云端保留 `/metrics` 指标接口，但**默认不部署 Prometheus/Grafana**。需要监控时，由部署方把外部 Prometheus 指向该接口；本文另提供可选的抓取、告警与看板模板。

## 1. 指标

`GET /metrics` 由 `src/metrics.ts` 生成，Prometheus 文本格式，需 `Authorization: Bearer $METRICS_TOKEN`。

| 指标 | 标签 | 用途 |
|---|---|---|
| `trend_coach_http_requests_total` | `method`、`route`、`status` | 请求量、5xx/429 比例 |
| `trend_coach_http_request_duration_seconds` | `method`、`route`、`status` | P50/P95 延迟（直方图） |
| `trend_coach_process_*`、`trend_coach_nodejs_*` | 默认标签 | CPU、内存、事件循环、GC |

约束：

- `route` 使用注册模板（如 `/v1/kb/segments/:segmentId`），不使用实际路径，避免标签基数膨胀。
- 指标不包含 token、设备 ID、query 原文、片段内容或播放地址。
- 业务事件（检索/引用/播放/满意度）留在事件表，不转成指标标签。

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

通知渠道（Alertmanager、飞书、邮件）由部署方现有的监控体系接入。

## 4. 排障入口

| 现象 | 先看 | 下一步 |
|---|---|---|
| 服务不可达 | `docker compose ps`、`/health`、数据库日志 | 数据库不可用先恢复数据库；app 崩溃看 stdout 日志 |
| 5xx 升高 | app JSON 日志的 `statusCode` 与 `err` | 区分数据库超时、embedding 依赖、未处理异常 |
| 检索 P95 升高 | 数据库慢查询与连接数 | 检查 pgvector 索引、`SEARCH_MIN_*` 配置与 embedding 超时 |
| 429 升高 | 按路由与设备来源统计 | 确认是否异常客户端；调整 `RATE_LIMIT_*` 前先评估成本 |

容量基线：单实例 2 vCPU 可承载日常检索；持续 CPU > 70% 或 P95 接近阈值时先扩容 app 实例（迁移有 advisory lock，可安全多实例），再考虑数据库规格。
