import { BoldOutlined, LinkOutlined, OrderedListOutlined, UnorderedListOutlined } from '@ant-design/icons'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { App, Button, Drawer, Input, Select, Space, Spin, Tag, Tooltip, Typography } from 'antd'
import { useEffect, useRef, useState } from 'react'
import { getArticle, putArticle } from '../../api'
import { MarkdownPreview } from '../../lib/markdown'
import { qk } from '../../lib/queryKeys'
import type { ContentStatus, KnowledgePoint } from '../../types'

const MAX_LENGTH = 20_000

export function ArticleDrawer({
  courseId,
  point,
  open,
  onClose,
}: {
  courseId: string
  point: KnowledgePoint | null
  open: boolean
  onClose: () => void
}) {
  const queryClient = useQueryClient()
  const { message, modal } = App.useApp()
  const [markdown, setMarkdown] = useState('')
  const [status, setStatus] = useState<ContentStatus>('draft')
  const [dirty, setDirty] = useState(false)
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)
  const pointId = point?.knowledgePointId ?? ''

  const article = useQuery({
    queryKey: qk.article(pointId),
    queryFn: () => getArticle(pointId),
    enabled: open && pointId !== '',
  })

  useEffect(() => {
    if (!open || article.data === undefined) return
    setMarkdown(article.data?.markdown ?? '')
    setStatus(article.data?.status ?? 'draft')
    setDirty(false)
  }, [article.data, open, pointId])

  useEffect(() => {
    if (!open) setDirty(false)
  }, [open])

  const save = useMutation({
    mutationFn: () => putArticle(pointId, { markdown, status }),
    onSuccess: async () => {
      setDirty(false)
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: qk.article(pointId) }),
        queryClient.invalidateQueries({ queryKey: qk.course(courseId) }),
        queryClient.invalidateQueries({ queryKey: qk.courses }),
      ])
      void message.success('文章已保存')
      onClose()
    },
  })

  const requestClose = (): void => {
    if (!dirty) {
      onClose()
      return
    }
    modal.confirm({
      title: '放弃未保存的修改？',
      content: '关闭后本次编辑内容不会保留。',
      okText: '放弃修改',
      cancelText: '继续编辑',
      okButtonProps: { danger: true },
      onOk: onClose,
    })
  }

  const insert = (before: string, after = ''): void => {
    const textarea = textareaRef.current
    if (textarea === null) return
    const start = textarea.selectionStart
    const end = textarea.selectionEnd
    const selected = markdown.slice(start, end)
    const next = `${markdown.slice(0, start)}${before}${selected}${after}${markdown.slice(end)}`
    if (next.length > MAX_LENGTH) {
      void message.warning(`正文最多 ${MAX_LENGTH} 字符`)
      return
    }
    setMarkdown(next)
    setDirty(true)
    requestAnimationFrame(() => {
      textarea.focus()
      textarea.setSelectionRange(start + before.length, start + before.length + selected.length)
    })
  }

  const title = point?.title ?? '文章'
  const meta = article.data

  return (
    <Drawer
      open={open}
      onClose={requestClose}
      width="min(1180px, 94vw)"
      destroyOnHidden
      title={
        <Space wrap>
          <span>{title}</span>
          <Tag bordered={false}>{pointId}</Tag>
        </Space>
      }
      extra={
        <Space>
          {meta === null || meta === undefined ? null : (
            <Typography.Text type="secondary">版本 v{meta.version}</Typography.Text>
          )}
          <Select<ContentStatus>
            size="small"
            value={status}
            onChange={value => {
              setStatus(value)
              setDirty(true)
            }}
            options={[
              { value: 'draft', label: '草稿' },
              { value: 'published', label: '已发布' },
              { value: 'archived', label: '已归档' },
            ]}
            style={{ width: 104 }}
          />
          <Button type="primary" loading={save.isPending} disabled={!dirty} onClick={() => save.mutate()}>
            保存
          </Button>
        </Space>
      }
    >
      {article.isLoading ? (
        <div className="page-loading"><Spin /></div>
      ) : (
        <div className="article-editor">
          <div className="article-editor-pane">
            <div className="article-toolbar">
              <Tooltip title="加粗">
                <Button size="small" type="text" icon={<BoldOutlined />} onClick={() => insert('**', '**')} />
              </Tooltip>
              <Tooltip title="无序列表">
                <Button size="small" type="text" icon={<UnorderedListOutlined />} onClick={() => insert('- ')} />
              </Tooltip>
              <Tooltip title="有序列表">
                <Button size="small" type="text" icon={<OrderedListOutlined />} onClick={() => insert('1. ')} />
              </Tooltip>
              <Tooltip title="插入链接">
                <Button size="small" type="text" icon={<LinkOutlined />} onClick={() => insert('[链接文本](https://)')} />
              </Tooltip>
              <span className="article-count">
                {markdown.length} / {MAX_LENGTH}
              </span>
            </div>
            <Input.TextArea
              ref={instance => {
                textareaRef.current = instance?.resizableTextArea?.textArea ?? null
              }}
              className="article-textarea"
              value={markdown}
              onChange={event => {
                setMarkdown(event.target.value)
                setDirty(true)
              }}
              placeholder="使用 Markdown 编写知识点正文。"
              autoSize={false}
            />
          </div>
          <div className="article-preview-pane">
            <MarkdownPreview value={markdown} />
          </div>
        </div>
      )}
    </Drawer>
  )
}
