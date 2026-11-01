import { ReloadOutlined } from '@ant-design/icons'
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  Button,
  Card,
  Col,
  DatePicker,
  Empty,
  Row,
  Select,
  Space,
  Statistic,
  Table,
  Tag,
  Typography,
} from 'antd'
import dayjs, { type Dayjs } from 'dayjs'
import { useState } from 'react'
import { getAiUsageSummary, listAiUsageEvents } from '../../api'
import { PageHeader } from '../../components/PageHeader'
import { StatusTag } from '../../components/StatusTag'
import { AI_TASK_OPTIONS } from '../../lib/ai'
import { formatCost, formatCount, formatIso } from '../../lib/format'
import { qk } from '../../lib/queryKeys'
import type { AiEventFilters, AiUsageFilters } from '../../lib/queryKeys'
import type {
  AiTaskKey,
  AiUsageByModel,
  AiUsageByTask,
  AiUsageDailyPoint,
  AiUsageEvent,
} from '../../types'

const { RangePicker } = DatePicker

function defaultRange(): [Dayjs, Dayjs] {
  return [dayjs().subtract(6, 'day').startOf('day'), dayjs()]
}

function usageFilters(range: [Dayjs, Dayjs], task: '' | AiTaskKey): AiUsageFilters {
  return {
    from: range[0].startOf('day').toISOString(),
    to: range[1].toISOString(),
    task,
  }
}

export function UsagePage() {
  const queryClient = useQueryClient()
  const [range, setRange] = useState<[Dayjs, Dayjs]>(defaultRange)
  const [task, setTask] = useState<'' | AiTaskKey>('')
  const filters = usageFilters(range, task)

  const summary = useQuery({
    queryKey: qk.aiUsageSummary(filters),
    queryFn: () => getAiUsageSummary(filters),
  })

  const eventFilters: AiEventFilters = { ...filters, model: '', limit: 20 }
  const events = useInfiniteQuery({
    queryKey: qk.aiUsageEvents(eventFilters),
    queryFn: ({ pageParam }) => listAiUsageEvents({
      from: eventFilters.from,
      to: eventFilters.to,
      task: eventFilters.task,
      limit: eventFilters.limit,
      ...(pageParam === null ? {} : { cursor: pageParam }),
    }),
    initialPageParam: null as string | null,
    getNextPageParam: page => page.nextCursor,
  })

  const totals = summary.data?.totals
  const errorRate = totals === undefined || totals.requests === 0
    ? '0%'
    : `${((totals.errors / totals.requests) * 100).toFixed(1)}%`
  const eventRows = events.data?.pages.flatMap(page => page.events) ?? []

  return (
    <>
      <PageHeader
        title="AI 用量"
        subtitle="云端 AI 任务的调用量、Token、错误与成本估算；只记录数字与模型标识，不落提问与正文。"
        extra={
          <Button
            icon={<ReloadOutlined />}
            onClick={() => void queryClient.invalidateQueries({ queryKey: ['ai', 'usage'] })}
          >
            刷新
          </Button>
        }
      />

      <Card className="ai-toolbar-card">
        <Space wrap size={12}>
          <RangePicker
            allowClear={false}
            value={range}
            onChange={values => {
              if (values !== null && values[0] !== null && values[1] !== null) {
                setRange([values[0], values[1]])
              }
            }}
          />
          <Select
            style={{ width: 180 }}
            value={task}
            onChange={value => setTask(value)}
            options={[{ value: '', label: '全部任务' }, ...AI_TASK_OPTIONS]}
          />
          <Typography.Text type="secondary">
            成本按模型配置的单价估算；未配置价格的模型显示为未配置。
          </Typography.Text>
        </Space>
      </Card>

      <Row gutter={[16, 16]} className="ai-stats">
        <Col xs={24} sm={12} xl={6}>
          <Card loading={summary.isLoading}>
            <Statistic title="请求数" value={formatCount(totals?.requests ?? 0)} />
          </Card>
        </Col>
        <Col xs={24} sm={12} xl={6}>
          <Card loading={summary.isLoading}>
            <Statistic
              title="输入 / 输出 Token"
              value={`${formatCount(totals?.inputTokens ?? 0)} / ${formatCount(totals?.outputTokens ?? 0)}`}
            />
          </Card>
        </Col>
        <Col xs={24} sm={12} xl={6}>
          <Card loading={summary.isLoading}>
            <Statistic
              title="错误率"
              value={errorRate}
              suffix={totals === undefined ? undefined : (
                <Typography.Text type="secondary">降级 {totals.fallbacks}</Typography.Text>
              )}
            />
          </Card>
        </Col>
        <Col xs={24} sm={12} xl={6}>
          <Card loading={summary.isLoading}>
            <Statistic
              title="估算成本"
              value={formatCost(totals?.costMicros ?? null)}
              suffix={totals === undefined ? undefined : (
                <Typography.Text type="secondary">均延迟 {totals.avgLatencyMs} ms</Typography.Text>
              )}
            />
          </Card>
        </Col>
      </Row>

      <Card title="每日请求趋势" className="ai-chart-card" loading={summary.isLoading}>
        <TrendChart points={summary.data?.daily ?? []} />
      </Card>

      <Card title="按任务" loading={summary.isLoading}>
        <Table<AiUsageByTask>
          rowKey="taskKey"
          size="middle"
          pagination={false}
          dataSource={summary.data?.byTask ?? []}
          locale={{ emptyText: '该时间范围内没有调用' }}
          columns={[
            {
              title: '任务',
              dataIndex: 'label',
              render: (label: string, row) => (
                <div className="segment-cell">
                  <Typography.Text strong>{label}</Typography.Text>
                  <Typography.Text type="secondary" code>{row.taskKey}</Typography.Text>
                </div>
              ),
            },
            { title: '请求', dataIndex: 'requests', width: 90 },
            { title: '错误', dataIndex: 'errors', width: 90 },
            {
              title: '用量',
              key: 'usage',
              width: 220,
              render: (_value, row) => (
                row.audioSeconds > 0 || row.characters > 0
                  ? `${row.audioSeconds.toFixed(1)} s / ${formatCount(row.characters)} 字符`
                  : `${formatCount(row.inputTokens)} / ${formatCount(row.outputTokens)}`
              ),
            },
            {
              title: '成本',
              dataIndex: 'costMicros',
              width: 140,
              render: (micros: number | null) => formatCost(micros),
            },
          ]}
        />
      </Card>

      <Card title="按模型" className="ai-section-card" loading={summary.isLoading}>
        <Table<AiUsageByModel>
          rowKey={row => row.configId ?? `${row.provider ?? 'unknown'}:${row.model ?? 'unknown'}`}
          size="middle"
          pagination={false}
          dataSource={summary.data?.byModel ?? []}
          locale={{ emptyText: '该时间范围内没有调用' }}
          columns={[
            {
              title: '模型',
              key: 'model',
              render: (_value, row) => (
                <div className="segment-cell">
                  <Typography.Text strong>{row.model ?? '未记录模型'}</Typography.Text>
                  <Typography.Text type="secondary">{row.provider ?? '—'}</Typography.Text>
                </div>
              ),
            },
            {
              title: '配置',
              dataIndex: 'configId',
              width: 220,
              render: (configId: string | null) => configId === null
                ? <Typography.Text type="secondary">未关联配置</Typography.Text>
                : <Typography.Text code>{configId}</Typography.Text>,
            },
            { title: '请求', dataIndex: 'requests', width: 90 },
            { title: '错误', dataIndex: 'errors', width: 90 },
            {
              title: '输入 / 输出 Token',
              key: 'tokens',
              width: 200,
              render: (_value, row) => `${formatCount(row.inputTokens)} / ${formatCount(row.outputTokens)}`,
            },
            {
              title: '成本',
              dataIndex: 'costMicros',
              width: 140,
              render: (micros: number | null) => formatCost(micros),
            },
          ]}
        />
      </Card>

      <Card title="调用明细" className="ai-section-card">
        <Table<AiUsageEvent>
          rowKey="usageId"
          size="middle"
          loading={events.isLoading}
          dataSource={eventRows}
          pagination={false}
          scroll={{ x: 980 }}
          locale={{ emptyText: '该时间范围内没有调用' }}
          columns={[
            {
              title: '时间',
              dataIndex: 'createdAt',
              width: 170,
              render: (value: string) => formatIso(value),
            },
            {
              title: '任务',
              dataIndex: 'label',
              width: 150,
              render: (label: string) => label,
            },
            {
              title: '模型',
              key: 'model',
              width: 200,
              render: (_value, row) => (
                <div className="segment-cell">
                  <span>{row.model ?? '—'}</span>
                  <Typography.Text type="secondary">{row.provider ?? '—'}</Typography.Text>
                </div>
              ),
            },
            {
              title: '状态',
              dataIndex: 'status',
              width: 100,
              render: (status: string) => <StatusTag value={status} />,
            },
            {
              title: 'Token / 用量',
              key: 'tokens',
              width: 180,
              render: (_value, row) => row.audioSeconds > 0 || row.characters > 0
                ? `${row.audioSeconds.toFixed(1)} s / ${formatCount(row.characters)} 字符`
                : `${formatCount(row.inputTokens)} / ${formatCount(row.outputTokens)}`,
            },
            {
              title: '延迟',
              dataIndex: 'latencyMs',
              width: 100,
              render: (value: number) => `${value} ms`,
            },
            {
              title: '错误码',
              dataIndex: 'errorCode',
              width: 150,
              render: (value: string | null) => value === null ? '—' : <Tag color="red">{value}</Tag>,
            },
          ]}
        />
        {events.hasNextPage ? (
          <div className="ai-load-more">
            <Button
              loading={events.isFetchingNextPage}
              onClick={() => void events.fetchNextPage()}
            >
              加载更多
            </Button>
          </div>
        ) : null}
      </Card>
    </>
  )
}

function TrendChart({ points }: { points: AiUsageDailyPoint[] }) {
  if (points.length === 0) {
    return <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="该时间范围内没有调用" />
  }
  const width = 720
  const height = 180
  const pad = 28
  const max = Math.max(1, ...points.map(point => point.requests))
  const step = points.length > 1 ? (width - pad * 2) / (points.length - 1) : 0
  const coords = points.map((point, index) => ({
    x: pad + index * step,
    y: height - pad - (point.requests / max) * (height - pad * 2),
    point,
  }))
  const line = coords.map(coord => `${coord.x},${coord.y}`).join(' ')
  const first = points[0]!
  const last = points[points.length - 1]!

  return (
    <div className="ai-chart">
      <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label="每日请求趋势">
        <line x1={pad} y1={height - pad} x2={width - pad} y2={height - pad} className="ai-chart-axis" />
        <line x1={pad} y1={pad} x2={pad} y2={height - pad} className="ai-chart-axis" />
        <polyline points={line} className="ai-chart-line" />
        {coords.map(coord => (
          <circle key={coord.point.date} cx={coord.x} cy={coord.y} r={3.5} className="ai-chart-dot">
            <title>{`${coord.point.date}：${coord.point.requests} 次请求`}</title>
          </circle>
        ))}
        <text x={pad} y={height - 8} className="ai-chart-label">{first.date}</text>
        <text x={width - pad} y={height - 8} className="ai-chart-label" textAnchor="end">{last.date}</text>
        <text x={pad} y={pad - 10} className="ai-chart-label">峰值 {formatCount(max)} 次/日</text>
      </svg>
    </div>
  )
}
