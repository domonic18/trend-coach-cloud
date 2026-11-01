import { DeleteOutlined, PictureOutlined, ReloadOutlined, ThunderboltOutlined } from '@ant-design/icons'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { App, Button, Drawer, Empty, Popconfirm, Space, Spin, Tag, Tooltip, Typography } from 'antd'
import { useEffect, useState } from 'react'
import {
  deleteFigure,
  enqueueIllustrate,
  getFigureCandidateBlob,
  listFigures,
  regenerateFigure,
  selectFigure,
} from '../../api'
import { qk } from '../../lib/queryKeys'
import type { Chapter, Figure, FigureCandidate } from '../../types'

export function FiguresDrawer({
  courseId,
  chapter,
  open,
  onClose,
}: {
  courseId: string
  chapter: Chapter | null
  open: boolean
  onClose: () => void
}) {
  const queryClient = useQueryClient()
  const { message } = App.useApp()
  const chapterId = chapter?.chapterId ?? ''
  const [generating, setGenerating] = useState(false)
  const [startedAt, setStartedAt] = useState(0)

  const figures = useQuery({
    queryKey: qk.figures(courseId, chapterId),
    queryFn: () => listFigures({ courseId, chapterId, limit: 100 }),
    enabled: open && chapterId !== '',
    refetchInterval: query => (
      open && (generating || hasPending(query.state.data?.figures ?? [])) ? 3_000 : false
    ),
  })

  useEffect(() => {
    if (!open) {
      setGenerating(false)
      return
    }
    if (!generating) return
    if (figures.dataUpdatedAt <= startedAt) return
    if (hasPending(figures.data?.figures ?? [])) return
    setGenerating(false)
  }, [figures.data, figures.dataUpdatedAt, generating, open, startedAt])

  const invalidate = async (): Promise<void> => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: qk.figures(courseId, chapterId) }),
      queryClient.invalidateQueries({ queryKey: qk.course(courseId) }),
    ])
  }

  const illustrate = useMutation({
    mutationFn: () => enqueueIllustrate(courseId, [chapterId]),
    onSuccess: async () => {
      setStartedAt(Date.now())
      setGenerating(true)
      await invalidate()
      void message.success('已提交图示生成任务')
    },
  })

  const select = useMutation({
    mutationFn: ({ figureId, candidateId }: { figureId: string; candidateId: string }) =>
      selectFigure(figureId, candidateId),
    onSuccess: async () => {
      await invalidate()
      void message.success('已选定候选图')
    },
  })

  const regenerate = useMutation({
    mutationFn: (figureId: string) => regenerateFigure(figureId),
    onSuccess: async () => {
      setStartedAt(Date.now())
      setGenerating(true)
      await invalidate()
      void message.success('已提交重新生成任务')
    },
    onError: error => {
      void message.error(error instanceof Error ? error.message : '重新生成失败')
    },
  })

  const remove = useMutation({
    mutationFn: (figureId: string) => deleteFigure(figureId),
    onSuccess: async () => {
      await invalidate()
      void message.success('图示已删除')
    },
    onError: error => {
      void message.error(error instanceof Error ? error.message : '删除失败')
    },
  })

  const data = figures.data?.figures ?? []

  return (
    <Drawer
      open={open}
      onClose={onClose}
      width="min(980px, 94vw)"
      destroyOnHidden
      title={
        <Space wrap>
          <span>章节图示</span>
          <Tag bordered={false}>{chapterId}</Tag>
          <Typography.Text type="secondary">{chapter?.title ?? ''}</Typography.Text>
        </Space>
      }
      extra={
        <Tooltip title="仅对本章节教材中的 figure 引用生成候选图">
          <Button
            type="primary"
            icon={<ThunderboltOutlined />}
            loading={illustrate.isPending || generating}
            onClick={() => illustrate.mutate()}
          >
            生成图示
          </Button>
        </Tooltip>
      }
    >
      {figures.isLoading ? (
        <div className="page-loading"><Spin /></div>
      ) : data.length === 0 ? (
        <Empty description="本章节还没有图示。先在教材中插入 figure 引用，再生成图示。" />
      ) : (
        <Space direction="vertical" size={16} style={{ width: '100%' }}>
          {data.map(figure => (
            <FigureCard
              key={figure.figureId}
              figure={figure}
              busy={select.isPending || regenerate.isPending || remove.isPending}
              onSelect={candidateId => select.mutate({ figureId: figure.figureId, candidateId })}
              onRegenerate={() => regenerate.mutate(figure.figureId)}
              onDelete={() => remove.mutate(figure.figureId)}
            />
          ))}
        </Space>
      )}
    </Drawer>
  )
}

function FigureCard({
  figure,
  busy,
  onSelect,
  onRegenerate,
  onDelete,
}: {
  figure: Figure
  busy: boolean
  onSelect: (candidateId: string) => void
  onRegenerate: () => void
  onDelete: () => void
}) {
  return (
    <div className="figure-card">
      <div className="figure-card-header">
        <Space wrap>
          <Typography.Text strong>{figure.caption}</Typography.Text>
          <Tag bordered={false}>{figure.figureId}</Tag>
          <Tag bordered={false} color={figure.status === 'ready' ? 'green' : undefined}>{figure.status}</Tag>
          {figure.reviewReasons.length > 0 ? (
            <Tooltip title={figure.reviewReasons.join('；')}>
              <Tag bordered={false} color="orange">需复核</Tag>
            </Tooltip>
          ) : null}
        </Space>
        <Space>
          <Button size="small" icon={<ReloadOutlined />} disabled={busy} onClick={onRegenerate}>
            重新生成
          </Button>
          <Popconfirm
            title="删除该图示？"
            description="已发布或仍被教材引用的图示不能删除。"
            okText="删除"
            cancelText="取消"
            onConfirm={onDelete}
          >
            <Button size="small" danger icon={<DeleteOutlined />} disabled={busy}>删除</Button>
          </Popconfirm>
        </Space>
      </div>
      {figure.candidates.length === 0 ? (
        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无候选图" />
      ) : (
        <div className="figure-candidates">
          {figure.candidates.map(candidate => (
            <CandidateCard
              key={candidate.candidateId}
              candidate={candidate}
              selected={candidate.candidateId === figure.selectedCandidateId}
              disabled={busy || candidate.status !== 'ready'}
              onSelect={() => onSelect(candidate.candidateId)}
            />
          ))}
        </div>
      )}
    </div>
  )
}

function CandidateCard({
  candidate,
  selected,
  disabled,
  onSelect,
}: {
  candidate: FigureCandidate
  selected: boolean
  disabled: boolean
  onSelect: () => void
}) {
  const image = useQuery({
    queryKey: ['content', 'figure-candidate', candidate.candidateId],
    queryFn: () => getFigureCandidateBlob(candidate.candidateId),
    enabled: candidate.status === 'ready',
    staleTime: Infinity,
    gcTime: 5 * 60_000,
  })

  useEffect(() => {
    const url = image.data
    return () => {
      if (url !== undefined) URL.revokeObjectURL(url)
    }
  }, [image.data])

  return (
    <div className={`figure-candidate${selected ? ' is-selected' : ''}`}>
      <button
        type="button"
        className="figure-candidate-image"
        disabled={disabled}
        onClick={onSelect}
      >
        {candidate.status === 'ready' && image.data !== undefined ? (
          <img src={image.data} alt={candidate.candidateId} />
        ) : candidate.status === 'failed' ? (
          <Space direction="vertical" size={4}>
            <PictureOutlined />
            <Typography.Text type="danger">{candidate.errorCode ?? '生成失败'}</Typography.Text>
          </Space>
        ) : (
          <Spin size="small" />
        )}
      </button>
      <div className="figure-candidate-meta">
        <Typography.Text type="secondary">
          {candidate.width !== null && candidate.height !== null
            ? `${candidate.width}×${candidate.height}`
            : candidate.status}
        </Typography.Text>
        {selected ? <Tag color="blue" bordered={false}>已选</Tag> : null}
      </div>
    </div>
  )
}

function hasPending(figures: Figure[]): boolean {
  return figures.some(figure =>
    figure.status === 'planned'
    || figure.status === 'rendering'
    || figure.candidates.some(candidate => candidate.status === 'rendering'),
  )
}
