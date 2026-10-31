import { useEffect, useState, type FormEvent } from 'react'
import { createSegment, listSegments, patchSegment } from './api'
import type { ContentStatus, Segment } from './types'
import { Field, Notice, StatusBadge, StatusSelect, toNumber } from './ui'

interface Filters {
  courseId: string
  knowledgePointId: string
  status: '' | ContentStatus
  query: string
  limit: string
}

const EMPTY_FILTERS: Filters = { courseId: '', knowledgePointId: '', status: '', query: '', limit: '50' }

export function SegmentsPanel({ onUnauthorized }: { onUnauthorized: () => void }) {
  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS)
  const [segments, setSegments] = useState<Segment[]>([])
  const [total, setTotal] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)

  const fail = (cause: unknown): void => {
    if (cause instanceof Error && 'status' in cause && (cause as { status: number }).status === 401) {
      onUnauthorized()
      return
    }
    setError(cause instanceof Error ? cause.message : '操作失败')
    setMessage(null)
  }

  const load = async (next: Filters): Promise<void> => {
    const limit = toNumber(next.limit)
    try {
      const page = await listSegments({
        ...(next.courseId === '' ? {} : { courseId: next.courseId.trim() }),
        ...(next.knowledgePointId === '' ? {} : { knowledgePointId: next.knowledgePointId.trim() }),
        ...(next.status === '' ? {} : { status: next.status }),
        ...(next.query === '' ? {} : { query: next.query.trim() }),
        ...(limit === undefined ? {} : { limit }),
      })
      setSegments(page.segments)
      setTotal(page.total)
    } catch (cause) {
      fail(cause)
    }
  }

  useEffect(() => {
    void load(EMPTY_FILTERS)
  }, [])

  return (
    <div className="stack">
      <Notice error={error} message={message} />

      <section className="card">
        <h2>片段检索</h2>
        <form
          className="row"
          autoComplete="off"
          onSubmit={event => {
            event.preventDefault()
            void load(filters)
          }}
        >
          <Field label="课程 ID">
            <input
              autoComplete="off"
              value={filters.courseId}
              onChange={event => setFilters({ ...filters, courseId: event.target.value })}
            />
          </Field>
          <Field label="知识点 ID">
            <input
              autoComplete="off"
              value={filters.knowledgePointId}
              onChange={event => setFilters({ ...filters, knowledgePointId: event.target.value })}
            />
          </Field>
          <Field label="状态">
            <select
              value={filters.status}
              onChange={event => setFilters({ ...filters, status: event.target.value as Filters['status'] })}
            >
              <option value="">全部</option>
              <option value="draft">draft</option>
              <option value="published">published</option>
              <option value="archived">archived</option>
            </select>
          </Field>
          <Field label="关键字">
            <input
              autoComplete="off"
              value={filters.query}
              onChange={event => setFilters({ ...filters, query: event.target.value })}
            />
          </Field>
          <Field label="条数">
            <input
              className="narrow"
              autoComplete="off"
              value={filters.limit}
              onChange={event => setFilters({ ...filters, limit: event.target.value })}
            />
          </Field>
          <button type="submit">查询</button>
        </form>
        <p className="muted">共 {total} 条</p>
        <table>
          <thead>
            <tr>
              <th>片段</th>
              <th>归属</th>
              <th>时间</th>
              <th>状态</th>
              <th>向量</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {segments.map(segment => (
              <SegmentRow
                key={`${segment.segmentId}:${segment.title}:${segment.startSec}:${segment.endSec}:${segment.text}:${segment.status}`}
                segment={segment}
                onSaved={async text => {
                  setMessage(text)
                  setError(null)
                  await load(filters)
                }}
                onError={fail}
              />
            ))}
          </tbody>
        </table>
        {segments.length === 0 ? <p className="muted">没有匹配片段。</p> : null}
      </section>

      <CreateSegmentCard
        onCreated={async () => {
          setMessage('片段已创建')
          setError(null)
          await load(filters)
        }}
        onError={fail}
      />
    </div>
  )
}

function SegmentRow({
  segment,
  onSaved,
  onError,
}: {
  segment: Segment
  onSaved: (message: string) => Promise<void>
  onError: (cause: unknown) => void
}) {
  const [editing, setEditing] = useState(false)
  const [title, setTitle] = useState(segment.title)
  const [startSec, setStartSec] = useState(String(segment.startSec))
  const [endSec, setEndSec] = useState(String(segment.endSec))
  const [text, setText] = useState(segment.text)
  const [status, setStatus] = useState<ContentStatus>(segment.status)
  const [busy, setBusy] = useState(false)

  const save = async (): Promise<void> => {
    const start = toNumber(startSec)
    const end = toNumber(endSec)
    if (start === undefined || end === undefined) {
      onError(new Error('起止秒必须是整数'))
      return
    }
    setBusy(true)
    try {
      await patchSegment(segment.segmentId, { title: title.trim(), startSec: start, endSec: end, text, status })
      setEditing(false)
      await onSaved('片段已保存；文本变更会清空旧向量')
    } catch (cause) {
      onError(cause)
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <tr>
        <td>
          <code>{segment.segmentId}</code>
          <div className="muted">{segment.title}</div>
        </td>
        <td className="muted">
          {segment.courseId}
          <br />
          {segment.chapterId} / {segment.knowledgePointId}
        </td>
        <td>{segment.startSec}–{segment.endSec}s</td>
        <td><StatusBadge status={segment.status} /></td>
        <td>{segment.hasEmbedding ? '已建立' : '无'}</td>
        <td><button className="ghost" onClick={() => setEditing(!editing)}>{editing ? '收起' : '编辑'}</button></td>
      </tr>
      {!editing ? null : (
        <tr>
          <td colSpan={6}>
            <div className="stack">
              <div className="row">
                <Field label="标题">
                  <input autoComplete="off" value={title} onChange={event => setTitle(event.target.value)} />
                </Field>
                <Field label="开始秒">
                  <input
                    className="narrow"
                    autoComplete="off"
                    value={startSec}
                    onChange={event => setStartSec(event.target.value)}
                  />
                </Field>
                <Field label="结束秒">
                  <input
                    className="narrow"
                    autoComplete="off"
                    value={endSec}
                    onChange={event => setEndSec(event.target.value)}
                  />
                </Field>
                <Field label="状态">
                  <StatusSelect value={status} onChange={setStatus} />
                </Field>
              </div>
              <textarea className="editor" value={text} onChange={event => setText(event.target.value)} />
              <div className="row">
                <button onClick={() => void save()} disabled={busy || title.trim() === '' || text.trim() === ''}>
                  保存片段
                </button>
                <span className="muted">{text.length} / 4000</span>
              </div>
            </div>
          </td>
        </tr>
      )}
    </>
  )
}

function CreateSegmentCard({
  onCreated,
  onError,
}: {
  onCreated: () => Promise<void>
  onError: (cause: unknown) => void
}) {
  const [form, setForm] = useState({
    segmentId: '',
    courseId: '',
    chapterId: '',
    knowledgePointId: '',
    title: '',
    startSec: '0',
    endSec: '',
    text: '',
    status: 'draft' as ContentStatus,
  })
  const [busy, setBusy] = useState(false)

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault()
    const start = toNumber(form.startSec)
    const end = toNumber(form.endSec)
    if (start === undefined || end === undefined) {
      onError(new Error('起止秒必须是整数'))
      return
    }
    setBusy(true)
    try {
      await createSegment({
        segmentId: form.segmentId.trim(),
        courseId: form.courseId.trim(),
        chapterId: form.chapterId.trim(),
        knowledgePointId: form.knowledgePointId.trim(),
        title: form.title.trim(),
        startSec: start,
        endSec: end,
        text: form.text,
        status: form.status,
      })
      setForm({ ...form, segmentId: '', title: '', endSec: '', text: '' })
      await onCreated()
    } catch (cause) {
      onError(cause)
    } finally {
      setBusy(false)
    }
  }

  const update = (key: keyof typeof form, value: string): void => setForm({ ...form, [key]: value })

  return (
    <section className="card">
      <h2>新建片段</h2>
      <form className="stack" autoComplete="off" onSubmit={event => void submit(event)}>
        <div className="row">
          <Field label="片段 ID">
            <input
              autoComplete="off"
              value={form.segmentId}
              onChange={event => update('segmentId', event.target.value)}
              placeholder="seg-..."
            />
          </Field>
          <Field label="课程 ID">
            <input autoComplete="off" value={form.courseId} onChange={event => update('courseId', event.target.value)} />
          </Field>
          <Field label="章节 ID">
            <input autoComplete="off" value={form.chapterId} onChange={event => update('chapterId', event.target.value)} />
          </Field>
          <Field label="知识点 ID">
            <input
              autoComplete="off"
              value={form.knowledgePointId}
              onChange={event => update('knowledgePointId', event.target.value)}
            />
          </Field>
        </div>
        <div className="row">
          <Field label="标题">
            <input autoComplete="off" value={form.title} onChange={event => update('title', event.target.value)} />
          </Field>
          <Field label="开始秒">
            <input
              className="narrow"
              autoComplete="off"
              value={form.startSec}
              onChange={event => update('startSec', event.target.value)}
            />
          </Field>
          <Field label="结束秒">
            <input
              className="narrow"
              autoComplete="off"
              value={form.endSec}
              onChange={event => update('endSec', event.target.value)}
            />
          </Field>
          <Field label="状态">
            <StatusSelect value={form.status} onChange={value => setForm({ ...form, status: value })} />
          </Field>
        </div>
        <textarea
          className="editor"
          value={form.text}
          onChange={event => update('text', event.target.value)}
          placeholder="片段文本（用于检索）"
        />
        <div className="row">
          <button type="submit" disabled={busy || form.text.trim() === ''}>创建片段</button>
          <span className="muted">{form.text.length} / 4000</span>
        </div>
      </form>
    </section>
  )
}
