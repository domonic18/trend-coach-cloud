import { ReloadOutlined } from '@ant-design/icons'
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  Button,
  Card,
  DatePicker,
  Descriptions,
  Drawer,
  Select,
  Space,
  Table,
  Tag,
  Typography,
} from 'antd'
import type { ColumnsType } from 'antd/es/table'
import dayjs, { type Dayjs } from 'dayjs'
import { useState } from 'react'
import { getAiRun, listAiRuns } from '../../api'
import { PageHeader } from '../../components/PageHeader'
import { StatusTag } from '../../components/StatusTag'
import {
  AI_TASK_OPTIONS,
  RUN_SOURCE_LABELS,
  RUN_SOURCE_OPTIONS,
  RUN_STATUS_OPTIONS,
} from '../../lib/ai'
import { formatDuration, formatIso } from '../../lib/format'
import { qk } from '../../lib/queryKeys'
import type { AiRunFilters } from '../../lib/queryKeys'
import type { AiRun, AiRunSource, AiRunStatus, AiRunStep, AiTaskKey } from '../../types'

const { RangePicker } = DatePicker

function defaultRange(): [Dayjs, Dayjs] {
  return [dayjs().subtract(6, 'day').startOf('day'), dayjs()]
}

export function RunsPage() {
  const queryClient = useQueryClient()
  const [range, setRange] = useState<[Dayjs, Dayjs]>(defaultRange)
  const [task, setTask] = useState<'' | AiTaskKey>('')
  const [status, setStatus] = useState<'' | AiRunStatus>('')
  const [source, setSource] = useState<'' | AiRunSource>('')
  const [selected, setSelected] = useState<string | null>(null)

  const filters: AiRunFilters = {
    from: range[0].startOf('day').toISOString(),
    to: range[1].toISOString(),
    task,
    status,
    source,
    limit: 20,
  }

  const runs = useInfiniteQuery({
    queryKey: qk.aiRuns(filters),
    queryFn: ({ pageParam }) => listAiRuns({
      from: filters.from,
      to: filters.to,
      task: filters.task,
      status: filters.status,
      source: filters.source,
      limit: filters.limit,
      ...(pageParam === null ? {} : { cursor: pageParam }),
    }),
    initialPageParam: null as string | null,
    getNextPageParam: page => page.nextCursor,
    refetchInterval: query =>
      (query.state.data?.pages ?? []).some(page => page.runs.some(run => run.status === 'running'))
        ? 5000
        : false,
  })

  const rows = runs.data?.pages.flatMap(page => page.runs) ?? []

  const columns: ColumnsType<AiRun> = [
    {
      title: '开始时间',
      dataIndex: 'startedAt',
      width: 170,
      render: (value: string) => formatIso(value),
    },
    {
      title: '任务',
      dataIndex: 'label',
      width: 140,
      render: (label: string, run) => (
        <div className="segment-cell">
          <Typography.Text strong>{label}</Typography.Text>
          <Typography.Text type="secondary" code>{run.taskKey}</Typography.Text>
        </div>
      ),
    },
    {
      title: '来源',
      dataIndex: 'source',
      width: 120,
      render: (value: AiRunSource, run) => (
        <div className="segment-cell">
          <span>{RUN_SOURCE_LABELS[value]}</span>
          {run.sourceId === null ? null : (
            <Typography.Text type="secondary" ellipsis>{run.sourceId}</Typography.Text>
          )}
        </div>
      ),
    },
    {
      title: '状态',
      dataIndex: 'status',
      width: 100,
      render: (value: AiRunStatus) => <StatusTag value={value} />,
    },
    {
      title: '主 / 备',
      key: 'configs',
      width: 180,
      render: (_value, run) => (
        <div className="segment-cell">
          <Typography.Text code>{run.primaryConfigId ?? '默认'}</Typography.Text>
          {run.fallbackUsed ? <Tag color="gold">已降级</Tag> : null}
        </div>
      ),
    },
    {
      title: '耗时',
      dataIndex: 'durationMs',
      width: 110,
      render: (value: number | null) => formatDuration(value),
    },
    {
      title: '错误码',
      dataIndex: 'errorCode',
      width: 150,
      render: (value: string | null) => value === null ? '—' : <Tag color="red">{value}</Tag>,
    },
    {
      title: '操作',
      key: 'actions',
      width: 90,
      render: (_value, run) => (
        <Button size="small" onClick={event => {
          event.stopPropagation()
          setSelected(run.runId)
        }}>
          详情
        </Button>
      ),
    },
  ]

  return (
    <>
      <PageHeader
        title="AI 运行"
        subtitle="按任务查看主备切换与实际调用步骤；运行中任务每 5 秒自动刷新。"
        extra={
          <Button
            icon={<ReloadOutlined />}
            onClick={() => void queryClient.invalidateQueries({ queryKey: ['ai', 'runs'] })}
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
            style={{ width: 170 }}
            value={task}
            onChange={value => setTask(value)}
            options={[{ value: '', label: '全部任务' }, ...AI_TASK_OPTIONS]}
          />
          <Select
            style={{ width: 140 }}
            value={status}
            onChange={value => setStatus(value)}
            options={[{ value: '', label: '全部状态' }, ...RUN_STATUS_OPTIONS]}
          />
          <Select
            style={{ width: 140 }}
            value={source}
            onChange={value => setSource(value)}
            options={[{ value: '', label: '全部来源' }, ...RUN_SOURCE_OPTIONS]}
          />
        </Space>
      </Card>

      <Card>
        <Table<AiRun>
          rowKey="runId"
          size="middle"
          loading={runs.isLoading}
          columns={columns}
          dataSource={rows}
          pagination={false}
          scroll={{ x: 1080 }}
          locale={{ emptyText: '该时间范围内没有运行记录' }}
          onRow={run => ({ onClick: () => setSelected(run.runId), className: 'ai-run-row' })}
        />
        {runs.hasNextPage ? (
          <div className="ai-load-more">
            <Button loading={runs.isFetchingNextPage} onClick={() => void runs.fetchNextPage()}>
              加载更多
            </Button>
          </div>
        ) : null}
      </Card>

      <RunDrawer runId={selected} onClose={() => setSelected(null)} />
    </>
  )
}

function RunDrawer({ runId, onClose }: { runId: string | null; onClose: () => void }) {
  const detail = useQuery({
    queryKey: qk.aiRun(runId ?? ''),
    queryFn: () => getAiRun(runId ?? ''),
    enabled: runId !== null,
  })
  const run = detail.data

  return (
    <Drawer
      open={runId !== null}
      onClose={onClose}
      width={780}
      title="运行详情"
      destroyOnHidden
    >
      {detail.isLoading || run === undefined ? (
        <Typography.Text type="secondary">加载中…</Typography.Text>
      ) : (
        <>
          <Descriptions column={2} size="small" bordered className="ai-run-meta">
            <Descriptions.Item label="运行 ID" span={2}>
              <Typography.Text code>{run.runId}</Typography.Text>
            </Descriptions.Item>
            <Descriptions.Item label="任务">{run.label}</Descriptions.Item>
            <Descriptions.Item label="状态"><StatusTag value={run.status} /></Descriptions.Item>
            <Descriptions.Item label="来源">
              {RUN_SOURCE_LABELS[run.source]}
              {run.sourceId === null ? '' : ` · ${run.sourceId}`}
            </Descriptions.Item>
            <Descriptions.Item label="主模型配置">
              {run.primaryConfigId ?? '未绑定（默认配置）'}
            </Descriptions.Item>
            <Descriptions.Item label="开始时间">{formatIso(run.startedAt)}</Descriptions.Item>
            <Descriptions.Item label="结束时间">{formatIso(run.finishedAt)}</Descriptions.Item>
            <Descriptions.Item label="耗时">{formatDuration(run.durationMs)}</Descriptions.Item>
            <Descriptions.Item label="降级">
              {run.fallbackUsed ? <Tag color="gold">已切换到备用模型</Tag> : '未降级'}
            </Descriptions.Item>
            {run.errorCode === null ? null : (
              <Descriptions.Item label="错误码" span={2}>
                <Tag color="red">{run.errorCode}</Tag>
              </Descriptions.Item>
            )}
          </Descriptions>

          <Typography.Title level={5}>调用步骤</Typography.Title>
          <Table<AiRunStep>
            rowKey="stepId"
            size="small"
            pagination={false}
            dataSource={run.steps}
            locale={{ emptyText: '没有步骤记录' }}
            columns={[
              { title: '#', dataIndex: 'seq', width: 50 },
              { title: '尝试', dataIndex: 'attempt', width: 60 },
              {
                title: '模型',
                key: 'model',
                width: 180,
                render: (_value, step) => (
                  <div className="segment-cell">
                    <span>{step.model ?? '—'}</span>
                    <Typography.Text type="secondary">{step.provider ?? '—'}</Typography.Text>
                  </div>
                ),
              },
              {
                title: '状态',
                dataIndex: 'status',
                width: 90,
                render: (value: string) => <StatusTag value={value} />,
              },
              {
                title: '延迟',
                dataIndex: 'latencyMs',
                width: 90,
                render: (value: number) => `${value} ms`,
              },
              {
                title: '用量 ID',
                dataIndex: 'usageId',
                width: 110,
                render: (value: string | null) => value === null ? '—' : <Typography.Text code>{value}</Typography.Text>,
              },
              {
                title: '错误码',
                dataIndex: 'errorCode',
                width: 120,
                render: (value: string | null) => value === null ? '—' : <Tag color="red">{value}</Tag>,
              },
            ]}
          />

          <Typography.Title level={5}>摘要</Typography.Title>
          <pre className="ai-json">
            {run.summary === null || run.summary === undefined
              ? '无摘要'
              : JSON.stringify(run.summary, null, 2)}
          </pre>
        </>
      )}
    </Drawer>
  )
}
