import { EditOutlined, PlusOutlined, ReloadOutlined, SearchOutlined } from '@ant-design/icons'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  App,
  Button,
  Card,
  Input,
  Select,
  Space,
  Table,
  Tag,
  Typography,
} from 'antd'
import type { ColumnsType } from 'antd/es/table'
import { useState } from 'react'
import { createSegment, listCourses, listSegments } from '../../api'
import { PageHeader } from '../../components/PageHeader'
import { StatusTag } from '../../components/StatusTag'
import { formatSeconds } from '../../lib/format'
import { qk } from '../../lib/queryKeys'
import type { SegmentFilters } from '../../lib/queryKeys'
import type { ContentStatus, Segment } from '../../types'
import { CreateSegmentModal, type CreateSegmentValues } from './CreateSegmentModal'
import { SegmentDrawer } from './SegmentDrawer'

export function SegmentsPage() {
  const queryClient = useQueryClient()
  const { message } = App.useApp()
  const [courseId, setCourseId] = useState('')
  const [keywordInput, setKeywordInput] = useState('')
  const [query, setQuery] = useState('')
  const [pointId, setPointId] = useState('')
  const [status, setStatus] = useState<'' | ContentStatus>('')
  const [offset, setOffset] = useState(0)
  const [limit, setLimit] = useState(20)
  const [editing, setEditing] = useState<Segment | null>(null)
  const [creating, setCreating] = useState(false)

  const filters: SegmentFilters = {
    courseId,
    knowledgePointId: pointId,
    status,
    query,
    offset,
    limit,
  }

  const courses = useQuery({ queryKey: qk.courses, queryFn: listCourses })
  const segments = useQuery({
    queryKey: qk.segments(filters),
    queryFn: () => listSegments({
      courseId: courseId === '' ? undefined : courseId,
      knowledgePointId: pointId === '' ? undefined : pointId,
      status: status === '' ? undefined : status,
      query: query === '' ? undefined : query,
      offset,
      limit,
    }),
  })

  const create = useMutation({
    mutationFn: (values: CreateSegmentValues) => createSegment(values),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['segments'] }),
        queryClient.invalidateQueries({ queryKey: qk.courses }),
      ])
      setCreating(false)
      void message.success('片段已创建')
    },
  })

  const resetFilters = (): void => {
    setCourseId('')
    setPointId('')
    setStatus('')
    setQuery('')
    setKeywordInput('')
    setOffset(0)
  }

  const columns: ColumnsType<Segment> = [
    {
      title: '片段',
      dataIndex: 'title',
      render: (title: string, segment) => (
        <div className="segment-cell">
          <Typography.Text strong ellipsis={{ tooltip: title }}>{title}</Typography.Text>
          <Typography.Text type="secondary" ellipsis={{ tooltip: segment.text }}>
            {segment.text}
          </Typography.Text>
        </div>
      ),
    },
    {
      title: '位置',
      key: 'location',
      width: 230,
      render: (_value, segment) => (
        <div className="segment-cell">
          <Typography.Text>{segment.courseId}</Typography.Text>
          <Typography.Text type="secondary">{segment.knowledgePointId}</Typography.Text>
        </div>
      ),
    },
    {
      title: '时间范围',
      key: 'range',
      width: 150,
      render: (_value, segment) => `${formatSeconds(segment.startSec)} – ${formatSeconds(segment.endSec)}`,
    },
    {
      title: '状态',
      dataIndex: 'status',
      width: 100,
      render: (value: string) => <StatusTag value={value} />,
    },
    {
      title: '向量',
      dataIndex: 'hasEmbedding',
      width: 100,
      render: (value: boolean) => (
        value ? <Tag color="green">已索引</Tag> : <Tag>未索引</Tag>
      ),
    },
    {
      title: '操作',
      key: 'actions',
      width: 96,
      render: (_value, segment) => (
        <Button type="link" size="small" icon={<EditOutlined />} onClick={() => setEditing(segment)}>
          编辑
        </Button>
      ),
    },
  ]

  return (
    <>
      <PageHeader
        title="片段管理"
        subtitle="按课程与知识点维护可检索的课程片段，支持按状态筛选与分页浏览。"
        extra={<Button type="primary" icon={<PlusOutlined />} onClick={() => setCreating(true)}>新建片段</Button>}
      />

      <Card className="filter-card">
        <Space size={12} wrap>
          <Select
            allowClear
            showSearch
            optionFilterProp="label"
            placeholder="全部课程"
            style={{ width: 260 }}
            value={courseId === '' ? undefined : courseId}
            loading={courses.isLoading}
            onChange={value => {
              setCourseId(value ?? '')
              setOffset(0)
            }}
            options={(courses.data ?? []).map(course => ({
              value: course.courseId,
              label: `${course.title}（${course.courseId}）`,
            }))}
          />
          <Input
            allowClear
            placeholder="知识点 ID"
            style={{ width: 200 }}
            value={pointId}
            onChange={event => {
              setPointId(event.target.value)
              setOffset(0)
            }}
          />
          <Select
            allowClear
            placeholder="全部状态"
            style={{ width: 130 }}
            value={status === '' ? undefined : status}
            onChange={value => {
              setStatus((value ?? '') as '' | ContentStatus)
              setOffset(0)
            }}
            options={[
              { value: 'draft', label: '草稿' },
              { value: 'published', label: '已发布' },
              { value: 'archived', label: '已归档' },
            ]}
          />
          <Input.Search
            allowClear
            prefix={<SearchOutlined />}
            placeholder="搜索标题或正文"
            style={{ width: 260 }}
            value={keywordInput}
            onChange={event => setKeywordInput(event.target.value)}
            onSearch={value => {
              setQuery(value.trim())
              setOffset(0)
            }}
          />
          <Button icon={<ReloadOutlined />} onClick={resetFilters}>重置</Button>
        </Space>
      </Card>

      <Card>
        <Table<Segment>
          rowKey="segmentId"
          loading={segments.isLoading}
          columns={columns}
          dataSource={segments.data?.segments ?? []}
          tableLayout="fixed"
          scroll={{ x: 980 }}
          pagination={{
            current: Math.floor(offset / limit) + 1,
            pageSize: limit,
            total: segments.data?.total ?? 0,
            showSizeChanger: true,
            showTotal: total => `共 ${total} 个片段`,
            onChange: (page, size) => {
              setOffset((page - 1) * size)
              setLimit(size)
            },
          }}
          locale={{ emptyText: '没有符合条件的片段' }}
        />
      </Card>

      <SegmentDrawer
        segment={editing}
        open={editing !== null}
        onClose={() => setEditing(null)}
      />

      <CreateSegmentModal
        open={creating}
        submitting={create.isPending}
        onCancel={() => setCreating(false)}
        onSubmit={values => create.mutate(values)}
      />
    </>
  )
}
