import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { App, Button, Descriptions, Drawer, Space, Table, Tag, Typography } from 'antd'
import type { ColumnsType } from 'antd/es/table'
import { useNavigate } from 'react-router-dom'
import { applyGeneration, discardGeneration, getGeneration } from '../../api'
import { StatusTag } from '../../components/StatusTag'
import { formatClock, formatDateTime } from '../../lib/format'
import { qk } from '../../lib/queryKeys'
import type { GenerationPreview } from '../../types'

type PreviewPoint = GenerationPreview['knowledgePoints'][number]
type PreviewSegment = GenerationPreview['segments'][number]

const pointColumns: ColumnsType<PreviewPoint> = [
  {
    title: '知识点',
    dataIndex: 'title',
    render: (title: string, point) => (
      <div className="generation-cell">
        <Typography.Text strong>{title}</Typography.Text>
        <Typography.Text type="secondary">{point.key}</Typography.Text>
      </div>
    ),
  },
  {
    title: '置信度',
    dataIndex: 'confidence',
    width: 96,
    render: (value: number) => value.toFixed(2),
  },
  {
    title: '审核',
    key: 'review',
    width: 240,
    render: (_value, point) => {
      if (point.needsReview) {
        return <Tag color="gold">待审：{point.reviewReasons.join('、')}</Tag>
      }
      return <Tag color="green">正常</Tag>
    },
  },
]

const segmentColumns: ColumnsType<PreviewSegment> = [
  { title: '片段', dataIndex: 'title' },
  {
    title: '时间',
    key: 'time',
    width: 180,
    render: (_value, segment) => `${formatClock(segment.startMs)} – ${formatClock(segment.endMs)}`,
  },
  { title: '知识点', dataIndex: 'pointKey', width: 220 },
]

export function GenerationDrawer({
  generationId,
  open,
  onClose,
}: {
  generationId: string | null
  open: boolean
  onClose: () => void
}) {
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const { message, modal } = App.useApp()

  const preview = useQuery({
    queryKey: qk.generation(generationId ?? ''),
    queryFn: () => getGeneration(generationId ?? ''),
    enabled: open && generationId !== null,
  })

  const apply = useMutation({
    mutationFn: () => applyGeneration(generationId ?? ''),
    onSuccess: async result => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: qk.generation(generationId ?? '') }),
        queryClient.invalidateQueries({ queryKey: qk.courses }),
        queryClient.invalidateQueries({ queryKey: ['content'] }),
        queryClient.invalidateQueries({ queryKey: ['pipeline'] }),
      ])
      void message.success(
        result.alreadyApplied
          ? '该生成结果此前已应用'
          : `已应用：章节 ${result.chapters.length}、教材 ${result.chapterArticles}、知识点 ${result.knowledgePoints.length}、图示 ${result.figuresApplied}、片段 ${result.segments.length}`,
      )
    },
  })

  const discard = useMutation({
    mutationFn: () => discardGeneration(generationId ?? ''),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['pipeline'] })
      void message.success('生成草稿已丢弃')
      onClose()
    },
  })

  const data = preview.data
  const generation = data?.generation
  const isDraft = generation?.status === 'draft'

  return (
    <Drawer
      open={open}
      onClose={onClose}
      width="min(1080px, 94vw)"
      destroyOnHidden
      title="生成预览"
      extra={
        <Space wrap>
          <Button
            disabled={!isDraft}
            loading={discard.isPending}
            onClick={() => {
              modal.confirm({
                title: '丢弃该生成草稿？',
                content: '丢弃后无法恢复，需要重新运行生成任务。',
                okText: '丢弃',
                cancelText: '取消',
                okButtonProps: { danger: true },
                onOk: () => discard.mutateAsync().then(() => undefined),
              })
            }}
          >
            丢弃
          </Button>
          <Button
            type="primary"
            disabled={!isDraft}
            loading={apply.isPending}
            onClick={() => {
              modal.confirm({
                title: '应用到课程草稿？',
                content: '生成内容会写入课程草稿结构，仍需在课程内容页检查后发布。',
                okText: '应用',
                cancelText: '取消',
                onOk: () => apply.mutateAsync().then(() => undefined),
              })
            }}
          >
            应用到草稿课程
          </Button>
          {generation?.status === 'applied' ? (
            <Button onClick={() => navigate(`/courses/${generation.courseId}`)}>前往课程内容</Button>
          ) : null}
        </Space>
      }
    >
      {preview.isLoading || generation === undefined || data === undefined ? (
        <div className="page-loading">加载中…</div>
      ) : (
        <Space direction="vertical" size={20} className="pipeline-drawer-body">
          <Descriptions
            size="small"
            column={{ xs: 1, sm: 2, lg: 3 }}
            items={[
              { key: 'status', label: '状态', children: <StatusTag value={generation.status} /> },
              { key: 'course', label: '课程', children: generation.courseId },
              { key: 'model', label: '模型', children: generation.model },
              { key: 'prompt', label: '提示词', children: generation.promptVersion },
              { key: 'chapters', label: '章节', children: generation.counts.chapters },
              { key: 'articles', label: '教材', children: generation.counts.chapterArticles },
              { key: 'points', label: '知识点', children: generation.counts.knowledgePoints },
              { key: 'figures', label: '图示', children: generation.counts.figures },
              { key: 'segments', label: '片段', children: generation.counts.segments },
              { key: 'review', label: '待审', children: generation.counts.needsReview },
              { key: 'created', label: '创建时间', children: formatDateTime(generation.createdAt) },
            ]}
          />

          <div>
            <Typography.Title level={5}>章节</Typography.Title>
            <Space wrap>
              {data.chapters.length === 0 ? <Typography.Text type="secondary">无</Typography.Text> : null}
              {data.chapters.map(chapter => (
                <Tag key={chapter.key}>
                  {chapter.title}
                  {chapter.hasArticle ? ` · 教材 ${chapter.articleLength} 字` : ' · 无教材'}
                  {chapter.figureCount > 0 ? ` · 图示 ${chapter.figureCount}` : ''}
                </Tag>
              ))}
            </Space>
          </div>

          <div>
            <Typography.Title level={5}>图示</Typography.Title>
            <Space wrap>
              {data.figures.length === 0 ? <Typography.Text type="secondary">无</Typography.Text> : null}
              {data.figures.map(figure => (
                <Tag key={figure.key} color={figure.needsReview ? 'gold' : undefined}>
                  {figure.caption} · {figure.kind} · {figure.candidateCount} 候选
                </Tag>
              ))}
            </Space>
          </div>

          <div>
            <Typography.Title level={5}>知识点</Typography.Title>
            <Table<PreviewPoint>
              size="small"
              rowKey="key"
              columns={pointColumns}
              dataSource={data.knowledgePoints}
              pagination={false}
              scroll={{ x: 640 }}
            />
          </div>

          <div>
            <Typography.Title level={5}>片段</Typography.Title>
            <Table<PreviewSegment>
              size="small"
              rowKey="key"
              dataSource={data.segments}
              pagination={false}
              scroll={{ x: 640 }}
              columns={segmentColumns}
            />
          </div>
        </Space>
      )}
    </Drawer>
  )
}
