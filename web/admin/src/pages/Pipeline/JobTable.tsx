import { EyeOutlined, RedoOutlined, StopOutlined } from '@ant-design/icons'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { App, Button, Popconfirm, Progress, Space, Table, Tooltip, Typography } from 'antd'
import type { ColumnsType } from 'antd/es/table'
import { cancelPipelineJob, getPipelineJob, retryPipelineJob } from '../../api'
import { STAGE_LABELS, StatusTag } from '../../components/StatusTag'
import { errorText, formatDateTime } from '../../lib/format'
import type { PipelineJob } from '../../types'

export function JobTable({
  jobs,
  loading,
  onPreview,
}: {
  jobs: PipelineJob[]
  loading: boolean
  onPreview: (generationId: string) => void
}) {
  const queryClient = useQueryClient()
  const { message } = App.useApp()

  const cancel = useMutation({
    mutationFn: (jobId: string) => cancelPipelineJob(jobId),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['pipeline'] })
      void message.success('已请求取消')
    },
  })

  const retry = useMutation({
    mutationFn: (jobId: string) => retryPipelineJob(jobId),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['pipeline'] })
      void message.success('已重新入队')
    },
  })

  const openPreview = async (job: PipelineJob): Promise<void> => {
    try {
      const detail = await getPipelineJob(job.jobId)
      const generationId = detail.result.generationId
      if (generationId === null) {
        void message.warning('任务没有生成结果')
        return
      }
      onPreview(generationId)
    } catch (cause) {
      void message.error(errorText(cause))
    }
  }

  const columns: ColumnsType<PipelineJob> = [
    {
      title: '任务',
      dataIndex: 'jobId',
      render: (jobId: string, job) => (
        <div className="segment-cell">
          <Tooltip title={jobId}>
            <Typography.Text code>{jobId.slice(0, 12)}</Typography.Text>
          </Tooltip>
          <Typography.Text type="secondary">
            {job.kind === 'ingest' ? '转写' : '内容生成'} · 尝试 {job.attempts}/{job.maxAttempts}
          </Typography.Text>
          {job.errorCode === null ? null : (
            <Typography.Text type="danger">错误：{job.errorCode}</Typography.Text>
          )}
        </div>
      ),
    },
    {
      title: '状态',
      dataIndex: 'status',
      width: 150,
      render: (status: string, job) => (
        <Space direction="vertical" size={2}>
          <StatusTag value={status} />
          <Typography.Text type="secondary">{STAGE_LABELS[job.stage] ?? job.stage}</Typography.Text>
        </Space>
      ),
    },
    {
      title: '进度',
      dataIndex: 'progress',
      width: 150,
      render: (progress: number, job) => (
        <Progress
          size="small"
          percent={Math.round(progress * 100)}
          status={job.status === 'failed' ? 'exception' : job.status === 'succeeded' ? 'success' : 'active'}
        />
      ),
    },
    {
      title: '创建时间',
      dataIndex: 'createdAt',
      width: 160,
      render: (value: number) => formatDateTime(value),
    },
    {
      title: '操作',
      key: 'actions',
      width: 190,
      render: (_value, job) => (
        <Space wrap size={4}>
          {job.kind === 'generate' && job.status === 'succeeded' ? (
            <Button size="small" icon={<EyeOutlined />} onClick={() => void openPreview(job)}>
              预览
            </Button>
          ) : null}
          <Popconfirm
            title="取消该任务？"
            okText="取消任务"
            cancelText="保留"
            disabled={job.status !== 'queued' && job.status !== 'running'}
            onConfirm={() => cancel.mutate(job.jobId)}
          >
            <Button
              size="small"
              icon={<StopOutlined />}
              disabled={job.status !== 'queued' && job.status !== 'running'}
            >
              取消
            </Button>
          </Popconfirm>
          <Popconfirm
            title="重新入队该任务？"
            okText="重试"
            cancelText="取消"
            disabled={job.status !== 'failed' && job.status !== 'canceled'}
            onConfirm={() => retry.mutate(job.jobId)}
          >
            <Button
              size="small"
              icon={<RedoOutlined />}
              disabled={job.status !== 'failed' && job.status !== 'canceled'}
            >
              重试
            </Button>
          </Popconfirm>
        </Space>
      ),
    },
  ]

  return (
    <Table<PipelineJob>
      rowKey="jobId"
      loading={loading}
      columns={columns}
      dataSource={jobs}
      pagination={false}
      scroll={{ x: 900 }}
      locale={{ emptyText: '该课程暂无建课任务' }}
    />
  )
}
