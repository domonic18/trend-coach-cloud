import { DeleteOutlined, PlusOutlined } from '@ant-design/icons'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Alert, App, Button, Card, Drawer, Input, Radio, Select, Space, Spin, Tag, Typography } from 'antd'
import { useEffect, useState } from 'react'
import { getChapterQuiz, putChapterQuiz } from '../../api'
import { qk } from '../../lib/queryKeys'
import type { Chapter, ContentStatus, QuizQuestion } from '../../types'

const QUESTION_ID = /^q_[A-Za-z0-9._-]{1,40}$/
const MAX_QUESTIONS = 5
const MIN_PUBLISHED = 3
const MIN_OPTIONS = 2
const MAX_OPTIONS = 6
const MAX_PROMPT = 300
const MAX_OPTION = 200
const MAX_EXPLANATION = 500

function blankQuestion(existing: QuizQuestion[]): QuizQuestion {
  let serial = existing.length + 1
  const used = new Set(existing.map(question => question.questionId))
  while (used.has(`q_${serial}`)) serial += 1
  return { questionId: `q_${serial}`, prompt: '', options: ['', '', ''], answerIndex: 0, explanation: '' }
}

function validate(questions: QuizQuestion[], publish: boolean): string | undefined {
  if (questions.length === 0) return '至少添加 1 道题'
  if (publish && (questions.length < MIN_PUBLISHED || questions.length > MAX_QUESTIONS)) {
    return `发布需要 ${MIN_PUBLISHED}–${MAX_QUESTIONS} 道题`
  }
  const ids = new Set<string>()
  for (const [index, question] of questions.entries()) {
    if (!QUESTION_ID.test(question.questionId)) return `第 ${index + 1} 题 ID 格式不正确`
    if (ids.has(question.questionId)) return `第 ${index + 1} 题 ID 重复`
    ids.add(question.questionId)
    if (question.prompt.trim().length === 0) return `第 ${index + 1} 题缺少题干`
    if (question.options.length < MIN_OPTIONS || question.options.length > MAX_OPTIONS) {
      return `第 ${index + 1} 题需要 ${MIN_OPTIONS}–${MAX_OPTIONS} 个选项`
    }
    if (question.options.some(option => option.trim().length === 0)) return `第 ${index + 1} 题存在空选项`
    if (new Set(question.options).size !== question.options.length) return `第 ${index + 1} 题选项重复`
    if (question.answerIndex < 0 || question.answerIndex >= question.options.length) {
      return `第 ${index + 1} 题未选择正确答案`
    }
    if (question.explanation.trim().length === 0) return `第 ${index + 1} 题缺少解析`
  }
  return undefined
}

export function QuizDrawer({
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
  const { message, modal } = App.useApp()
  const [questions, setQuestions] = useState<QuizQuestion[]>([])
  const [status, setStatus] = useState<ContentStatus>('draft')
  const [dirty, setDirty] = useState(false)
  const chapterId = chapter?.chapterId ?? ''

  const quiz = useQuery({
    queryKey: qk.chapterQuiz(courseId, chapterId),
    queryFn: () => getChapterQuiz(courseId, chapterId),
    enabled: open && chapterId !== '',
  })

  useEffect(() => {
    if (!open) return
    setQuestions([])
    setStatus('draft')
    setDirty(false)
  }, [open, courseId, chapterId])

  useEffect(() => {
    if (!open || quiz.data === undefined) return
    setQuestions(quiz.data?.questions ?? [])
    setStatus(quiz.data?.status ?? 'draft')
    setDirty(false)
  }, [quiz.data, open])

  const save = useMutation({
    mutationFn: () => putChapterQuiz(courseId, chapterId, { questions, status }),
    onSuccess: async () => {
      setDirty(false)
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: qk.chapterQuiz(courseId, chapterId) }),
        queryClient.invalidateQueries({ queryKey: qk.course(courseId) }),
      ])
      void message.success('题库已保存')
      onClose()
    },
  })

  const submit = (): void => {
    const problem = validate(questions, status === 'published')
    if (problem !== undefined) {
      void message.warning(problem)
      return
    }
    save.mutate()
  }

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

  const patch = (index: number, next: Partial<QuizQuestion>): void => {
    setQuestions(list => list.map((question, position) => (position === index ? { ...question, ...next } : question)))
    setDirty(true)
  }

  const patchOption = (questionIndex: number, optionIndex: number, value: string): void => {
    setQuestions(list => list.map((question, position) => {
      if (position !== questionIndex) return question
      return {
        ...question,
        options: question.options.map((option, index) => (index === optionIndex ? value : option)),
      }
    }))
    setDirty(true)
  }

  const addOption = (questionIndex: number): void => {
    setQuestions(list => list.map((question, position) => (
      position === questionIndex && question.options.length < MAX_OPTIONS
        ? { ...question, options: [...question.options, ''] }
        : question
    )))
    setDirty(true)
  }

  const removeOption = (questionIndex: number, optionIndex: number): void => {
    setQuestions(list => list.map((question, position) => {
      if (position !== questionIndex || question.options.length <= MIN_OPTIONS) return question
      const options = question.options.filter((_, index) => index !== optionIndex)
      const answerIndex = question.answerIndex > optionIndex
        ? question.answerIndex - 1
        : question.answerIndex === optionIndex
          ? 0
          : question.answerIndex
      return { ...question, options, answerIndex: Math.min(answerIndex, options.length - 1) }
    }))
    setDirty(true)
  }

  const title = chapter?.title ?? '随堂测验'
  const meta = quiz.data === null ? null : quiz.data
  const publishedCount = questions.filter(question => question.options.length > 1).length

  return (
    <Drawer
      open={open}
      onClose={requestClose}
      width="min(920px, 94vw)"
      destroyOnHidden
      title={
        <Space wrap>
          <span>{title} · 随堂测验</span>
          <Tag bordered={false}>{chapterId || '未选择章节'}</Tag>
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
          <Button type="primary" loading={save.isPending} disabled={!dirty} onClick={submit}>
            保存
          </Button>
        </Space>
      }
    >
      {chapterId === '' ? (
        <Typography.Text type="secondary">请先在课程结构中创建章节。</Typography.Text>
      ) : quiz.isLoading ? (
        <div className="page-loading"><Spin /></div>
      ) : (
        <Space direction="vertical" size={12} style={{ width: '100%' }}>
          <Alert
            type="info"
            showIcon
            message="题库在课程制作阶段一次写入，学员课堂内即时评分。"
            description={`发布需要 ${MIN_PUBLISHED}–${MAX_QUESTIONS} 道题；每题 ${MIN_OPTIONS}–${MAX_OPTIONS} 个选项，答案与解析随题库下发。当前 ${questions.length} 题（${publishedCount} 题可作答）。`}
          />
          {questions.map((question, index) => (
            <Card
              key={`${question.questionId}-${index}`}
              size="small"
              title={`第 ${index + 1} 题`}
              extra={
                <Button
                  type="text"
                  size="small"
                  danger
                  icon={<DeleteOutlined />}
                  onClick={() => {
                    setQuestions(list => list.filter((_, position) => position !== index))
                    setDirty(true)
                  }}
                >
                  删除
                </Button>
              }
            >
              <Space direction="vertical" size={10} style={{ width: '100%' }}>
                <Input
                  addonBefore="题目 ID"
                  value={question.questionId}
                  maxLength={42}
                  onChange={event => patch(index, { questionId: event.target.value })}
                />
                <Input.TextArea
                  value={question.prompt}
                  maxLength={MAX_PROMPT}
                  showCount
                  autoSize={{ minRows: 2, maxRows: 4 }}
                  placeholder="题干"
                  onChange={event => patch(index, { prompt: event.target.value })}
                />
                <Radio.Group
                  value={question.answerIndex}
                  onChange={event => patch(index, { answerIndex: Number(event.target.value) })}
                  style={{ display: 'flex', flexDirection: 'column', gap: 6 }}
                >
                  {question.options.map((option, optionIndex) => (
                    <Space.Compact key={optionIndex} style={{ width: '100%' }}>
                      <Radio value={optionIndex} style={{ marginRight: 8, alignSelf: 'center' }} />
                      <Input
                        value={option}
                        maxLength={MAX_OPTION}
                        placeholder={`选项 ${optionIndex + 1}`}
                        onChange={event => patchOption(index, optionIndex, event.target.value)}
                      />
                      <Button
                        icon={<DeleteOutlined />}
                        disabled={question.options.length <= MIN_OPTIONS}
                        onClick={() => removeOption(index, optionIndex)}
                      />
                    </Space.Compact>
                  ))}
                </Radio.Group>
                <Button
                  type="dashed"
                  size="small"
                  icon={<PlusOutlined />}
                  disabled={question.options.length >= MAX_OPTIONS}
                  onClick={() => addOption(index)}
                >
                  添加选项
                </Button>
                <Input.TextArea
                  value={question.explanation}
                  maxLength={MAX_EXPLANATION}
                  showCount
                  autoSize={{ minRows: 2, maxRows: 4 }}
                  placeholder="解析（提交后展示）"
                  onChange={event => patch(index, { explanation: event.target.value })}
                />
              </Space>
            </Card>
          ))}
          <Button
            type="dashed"
            icon={<PlusOutlined />}
            disabled={questions.length >= MAX_QUESTIONS}
            onClick={() => {
              setQuestions(list => [...list, blankQuestion(list)])
              setDirty(true)
            }}
          >
            添加题目
          </Button>
        </Space>
      )}
    </Drawer>
  )
}
