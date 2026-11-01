import {
  PlayCircleOutlined,
  PlusOutlined,
  ReadOutlined,
  RobotOutlined,
  TeamOutlined,
  VideoCameraOutlined,
} from '@ant-design/icons'
import { useQuery } from '@tanstack/react-query'
import { Alert, Button, Card, Col, Progress, Row, Statistic, Table, Tooltip } from 'antd'
import type { ColumnsType } from 'antd/es/table'
import { Link, useNavigate } from 'react-router-dom'
import { listCourses, listMediaAssets, listPipelineJobs, listUsers } from '../../api'
import { useAuth } from '../../auth/AuthProvider'
import { PageHeader } from '../../components/PageHeader'
import { STAGE_LABELS, StatusTag } from '../../components/StatusTag'
import { formatDateTime } from '../../lib/format'
import { qk } from '../../lib/queryKeys'
import type { JobFilters } from '../../lib/queryKeys'
import type { PipelineJob } from '../../types'

const ACTIVE_STATUSES = new Set(['queued', 'running'])

const jobColumns: ColumnsType<PipelineJob> = [
  {
    title: '任务',
    dataIndex: 'jobId',
    render: (jobId: string, job) => (
      <Tooltip title={jobId}>
        <code>{jobId.slice(0, 8)}</code>
      </Tooltip>
    ),
  },
  {
    title: '类型',
    dataIndex: 'kind',
    width: 96,
    render: (kind: string) => (kind === 'ingest' ? '转写' : '生成'),
  },
  {
    title: '阶段',
    dataIndex: 'stage',
    width: 110,
    render: (stage: string) => STAGE_LABELS[stage] ?? stage,
  },
  {
    title: '状态',
    dataIndex: 'status',
    width: 96,
    render: (status: string) => <StatusTag value={status} />,
  },
  {
    title: '进度',
    dataIndex: 'progress',
    width: 160,
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
]

export function OverviewPage() {
  const { user } = useAuth()
  const navigate = useNavigate()
  const isAdmin = user?.role === 'admin'

  const courses = useQuery({ queryKey: qk.courses, queryFn: listCourses })
  const assets = useQuery({ queryKey: qk.assets(null), queryFn: () => listMediaAssets({ limit: 1 }) })
  const jobFilter: JobFilters = { limit: 10 }
  const jobs = useQuery({
    queryKey: qk.jobs(jobFilter),
    queryFn: () => listPipelineJobs({ limit: 10 }),
    refetchInterval: query =>
      (query.state.data?.jobs ?? []).some(job => ACTIVE_STATUSES.has(job.status)) ? 2500 : false,
  })
  const activeJobs = useQuery({
    queryKey: qk.jobs({ status: 'running', limit: 1 }),
    queryFn: () => listPipelineJobs({ status: 'running', limit: 1 }),
    refetchInterval: 5000,
  })
  const queuedJobs = useQuery({
    queryKey: qk.jobs({ status: 'queued', limit: 1 }),
    queryFn: () => listPipelineJobs({ status: 'queued', limit: 1 }),
    refetchInterval: 5000,
  })
  const users = useQuery({
    queryKey: qk.users({ query: '', role: '', status: '', offset: 0, limit: 1 }),
    queryFn: () => listUsers({ limit: 1 }),
    enabled: isAdmin,
  })

  const courseList = courses.data ?? []
  const draftCount = courseList.filter(course => course.status === 'draft').length
  const runningCount = (activeJobs.data?.total ?? 0) + (queuedJobs.data?.total ?? 0)
  const failed = courses.isError || assets.isError || jobs.isError

  return (
    <>
      <PageHeader
        title="概览"
        subtitle="课程内容、建课管线与团队账号的整体状态。"
        extra={
          <>
            <Button icon={<PlusOutlined />} onClick={() => navigate('/courses?create=1')}>新建课程</Button>
            <Button icon={<VideoCameraOutlined />} onClick={() => navigate('/pipeline')}>上传视频</Button>
            {isAdmin ? (
              <Button icon={<RobotOutlined />} onClick={() => navigate('/system/models')}>模型配置</Button>
            ) : null}
          </>
        }
      />

      {failed ? (
        <Alert
          type="warning"
          showIcon
          className="overview-alert"
          message="部分概览数据加载失败"
          description="可刷新页面重试；核心功能不受影响。"
        />
      ) : null}

      <Row gutter={[16, 16]} className="overview-stats">
        <Col xs={24} sm={12} xl={6}>
          <Card loading={courses.isLoading}>
            <Statistic
              title="课程总数"
              value={courseList.length}
              prefix={<ReadOutlined />}
              suffix={<span className="statistic-hint">草稿 {draftCount}</span>}
            />
          </Card>
        </Col>
        <Col xs={24} sm={12} xl={6}>
          <Card loading={assets.isLoading}>
            <Statistic
              title="视频素材"
              value={assets.data?.total ?? 0}
              prefix={<VideoCameraOutlined />}
            />
          </Card>
        </Col>
        <Col xs={24} sm={12} xl={6}>
          <Card loading={activeJobs.isLoading || queuedJobs.isLoading}>
            <Statistic
              title="运行中任务"
              value={runningCount}
              prefix={<PlayCircleOutlined />}
              valueStyle={runningCount > 0 ? { color: '#5e6ad2' } : undefined}
            />
          </Card>
        </Col>
        <Col xs={24} sm={12} xl={6}>
          <Card loading={isAdmin && users.isLoading}>
            <Statistic
              title="账号数"
              value={isAdmin ? users.data?.total ?? 0 : '—'}
              prefix={<TeamOutlined />}
            />
          </Card>
        </Col>
      </Row>

      <Card
        title="近期建课任务"
        className="overview-jobs"
        extra={<Link to="/pipeline">前往视频建课</Link>}
        loading={jobs.isLoading}
      >
        <Table<PipelineJob>
          rowKey="jobId"
          size="middle"
          columns={jobColumns}
          dataSource={jobs.data?.jobs ?? []}
          pagination={false}
          scroll={{ x: 760 }}
          locale={{ emptyText: '暂无建课任务' }}
        />
      </Card>
    </>
  )
}
