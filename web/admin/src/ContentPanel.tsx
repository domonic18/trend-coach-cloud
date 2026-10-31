import { useEffect, useState, type FormEvent } from 'react'
import {
  createChapter,
  createCourse,
  createKnowledgePoint,
  getArticle,
  getCourseTree,
  listCourses,
  patchChapter,
  patchCourse,
  patchKnowledgePoint,
  putArticle,
  reindex,
} from './api'
import type {
  Article,
  ArticleMeta,
  Chapter,
  ContentStatus,
  CourseSummary,
  CourseTree,
  KnowledgePoint,
} from './types'
import { Field, formatTime, Notice, StatusBadge, StatusSelect, toNumber } from './ui'

export function ContentPanel({ onUnauthorized }: { onUnauthorized: () => void }) {
  const [courses, setCourses] = useState<CourseSummary[]>([])
  const [selected, setSelected] = useState<string | null>(null)
  const [tree, setTree] = useState<CourseTree | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [articleTarget, setArticleTarget] = useState<string | null>(null)

  const fail = (cause: unknown): void => {
    if (cause instanceof Error && 'status' in cause && (cause as { status: number }).status === 401) {
      onUnauthorized()
      return
    }
    setError(cause instanceof Error ? cause.message : '操作失败')
    setMessage(null)
  }

  const loadCourses = async (): Promise<void> => {
    try {
      setCourses(await listCourses())
    } catch (cause) {
      fail(cause)
    }
  }

  const loadTree = async (courseId: string): Promise<void> => {
    try {
      setSelected(courseId)
      setTree(await getCourseTree(courseId))
    } catch (cause) {
      fail(cause)
    }
  }

  useEffect(() => {
    void loadCourses()
  }, [])

  const run = async (action: () => Promise<void>, success: string): Promise<void> => {
    try {
      await action()
      setError(null)
      setMessage(success)
      await loadCourses()
      if (selected !== null) setTree(await getCourseTree(selected))
    } catch (cause) {
      fail(cause)
    }
  }

  return (
    <div className="stack">
      <Notice error={error} message={message} />

      <section className="card">
        <h2>课程</h2>
        <CreateCourseForm
          onCreate={async input => {
            await run(async () => {
              await createCourse(input)
            }, '课程已创建')
          }}
        />
        <table>
          <thead>
            <tr>
              <th>课程</th>
              <th>状态</th>
              <th>章节</th>
              <th>知识点</th>
              <th>片段</th>
              <th>文章</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {courses.map(course => (
              <tr key={course.courseId} className={selected === course.courseId ? 'selected' : undefined}>
                <td>
                  <strong>{course.courseId}</strong>
                  <div className="muted">{course.title}</div>
                </td>
                <td><StatusBadge status={course.status} /></td>
                <td>{course.chapterCount}</td>
                <td>{course.knowledgePointCount}</td>
                <td>{course.segmentCount}</td>
                <td>{course.articleCount}</td>
                <td>
                  <button onClick={() => void loadTree(course.courseId)}>管理</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {courses.length === 0 ? <p className="muted">暂无课程。</p> : null}
      </section>

      {tree === null ? null : (
        <section className="card">
          <CourseEditor
            tree={tree}
            onReload={async () => {
              await loadCourses()
              await loadTree(tree.course.courseId)
            }}
            onEditArticle={setArticleTarget}
            onError={fail}
            onMessage={text => {
              setMessage(text)
              setError(null)
            }}
          />
        </section>
      )}

      {articleTarget === null ? null : (
        <ArticleEditor
          knowledgePointId={articleTarget}
          onClose={() => setArticleTarget(null)}
          onSaved={async () => {
            setMessage('文章已保存')
            setError(null)
            if (selected !== null) await loadTree(selected)
            await loadCourses()
          }}
          onError={fail}
        />
      )}
    </div>
  )
}

function CreateCourseForm({ onCreate }: { onCreate: (input: { courseId: string; title: string }) => Promise<void> }) {
  const [courseId, setCourseId] = useState('')
  const [title, setTitle] = useState('')
  const [busy, setBusy] = useState(false)

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault()
    setBusy(true)
    try {
      await onCreate({ courseId: courseId.trim(), title: title.trim() })
      setCourseId('')
      setTitle('')
    } finally {
      setBusy(false)
    }
  }

  return (
    <form className="row" onSubmit={event => void submit(event)}>
      <Field label="课程 ID">
        <input value={courseId} onChange={event => setCourseId(event.target.value)} placeholder="TC-101" />
      </Field>
      <Field label="标题">
        <input value={title} onChange={event => setTitle(event.target.value)} />
      </Field>
      <button type="submit" disabled={busy || courseId.trim() === '' || title.trim() === ''}>新建课程</button>
    </form>
  )
}

function CourseEditor({
  tree,
  onReload,
  onEditArticle,
  onError,
  onMessage,
}: {
  tree: CourseTree
  onReload: () => Promise<void>
  onEditArticle: (knowledgePointId: string) => void
  onError: (cause: unknown) => void
  onMessage: (message: string) => void
}) {
  const [title, setTitle] = useState(tree.course.title)
  const [status, setStatus] = useState<ContentStatus>(tree.course.status)
  const [busy, setBusy] = useState(false)
  const { course } = tree

  const save = async (): Promise<void> => {
    setBusy(true)
    try {
      await patchCourse(course.courseId, { title: title.trim(), status })
      onMessage('课程已保存')
      await onReload()
    } catch (cause) {
      onError(cause)
    } finally {
      setBusy(false)
    }
  }

  const rebuild = async (): Promise<void> => {
    try {
      const embedded = await reindex(course.courseId)
      onMessage(`已重建 ${embedded} 条片段向量`)
    } catch (cause) {
      onError(cause)
    }
  }

  return (
    <div className="stack">
      <div className="spread">
        <h2>课程：{course.courseId}</h2>
        <button className="ghost" onClick={() => void rebuild()}>重建向量</button>
      </div>
      <div className="row">
        <Field label="标题">
          <input value={title} onChange={event => setTitle(event.target.value)} />
        </Field>
        <Field label="状态">
          <StatusSelect value={status} onChange={setStatus} />
        </Field>
        <button onClick={() => void save()} disabled={busy || title.trim() === ''}>保存课程</button>
      </div>
      <p className="hint">课程归档后，其下章节、知识点、片段与文章对学员不可见；内容不做物理删除。</p>

      {tree.chapters.map(chapter => (
        <ChapterCard
          key={`${chapter.chapterId}:${chapter.title}:${chapter.position}`}
          courseId={course.courseId}
          chapter={chapter}
          onReload={onReload}
          onEditArticle={onEditArticle}
          onError={onError}
          onMessage={onMessage}
        />
      ))}
      <AddChapterForm courseId={course.courseId} onReload={onReload} onError={onError} onMessage={onMessage} />
    </div>
  )
}

function ChapterCard({
  courseId,
  chapter,
  onReload,
  onEditArticle,
  onError,
  onMessage,
}: {
  courseId: string
  chapter: Chapter
  onReload: () => Promise<void>
  onEditArticle: (knowledgePointId: string) => void
  onError: (cause: unknown) => void
  onMessage: (message: string) => void
}) {
  const [title, setTitle] = useState(chapter.title)
  const [position, setPosition] = useState(String(chapter.position))

  const save = async (): Promise<void> => {
    const parsed = toNumber(position)
    if (parsed === undefined) {
      onError(new Error('position 必须是整数'))
      return
    }
    try {
      await patchChapter(courseId, chapter.chapterId, { title: title.trim(), position: parsed })
      onMessage('章节已保存')
      await onReload()
    } catch (cause) {
      onError(cause)
    }
  }

  return (
    <div className="subcard">
      <div className="row">
        <strong>{chapter.chapterId}</strong>
        <Field label="标题">
          <input value={title} onChange={event => setTitle(event.target.value)} />
        </Field>
        <Field label="排序">
          <input className="narrow" value={position} onChange={event => setPosition(event.target.value)} />
        </Field>
        <button onClick={() => void save()} disabled={title.trim() === ''}>保存章节</button>
      </div>

      {chapter.knowledgePoints.map(point => (
        <PointRow
          key={`${point.knowledgePointId}:${point.title}:${point.position}`}
          point={point}
          onEditArticle={onEditArticle}
          onReload={onReload}
          onError={onError}
          onMessage={onMessage}
        />
      ))}

      <AddPointForm
        courseId={courseId}
        chapterId={chapter.chapterId}
        onReload={onReload}
        onError={onError}
        onMessage={onMessage}
      />
    </div>
  )
}

function PointRow({
  point,
  onEditArticle,
  onReload,
  onError,
  onMessage,
}: {
  point: KnowledgePoint
  onEditArticle: (knowledgePointId: string) => void
  onReload: () => Promise<void>
  onError: (cause: unknown) => void
  onMessage: (message: string) => void
}) {
  const [title, setTitle] = useState(point.title)
  const [position, setPosition] = useState(String(point.position))

  const save = async (): Promise<void> => {
    const parsed = toNumber(position)
    if (parsed === undefined) {
      onError(new Error('position 必须是整数'))
      return
    }
    try {
      await patchKnowledgePoint(point.knowledgePointId, { title: title.trim(), position: parsed })
      onMessage('知识点已保存')
      await onReload()
    } catch (cause) {
      onError(cause)
    }
  }

  return (
    <div className="point">
      <code>{point.knowledgePointId}</code>
      <input value={title} onChange={event => setTitle(event.target.value)} />
      <input className="narrow" value={position} onChange={event => setPosition(event.target.value)} />
      <button onClick={() => void save()} disabled={title.trim() === ''}>保存</button>
      <button className="ghost" onClick={() => onEditArticle(point.knowledgePointId)}>
        文章{point.article === null ? '（无）' : ` v${point.article.version}`}
      </button>
      <span className="muted">片段 {point.segmentCount}</span>
      {point.article === null ? null : <StatusBadge status={point.article.status} />}
    </div>
  )
}

function AddChapterForm({
  courseId,
  onReload,
  onError,
  onMessage,
}: {
  courseId: string
  onReload: () => Promise<void>
  onError: (cause: unknown) => void
  onMessage: (message: string) => void
}) {
  const [chapterId, setChapterId] = useState('')
  const [title, setTitle] = useState('')
  const [position, setPosition] = useState('')

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault()
    const parsed = position.trim() === '' ? undefined : toNumber(position)
    if (position.trim() !== '' && parsed === undefined) {
      onError(new Error('position 必须是整数'))
      return
    }
    try {
      await createChapter(courseId, {
        chapterId: chapterId.trim(),
        title: title.trim(),
        ...(parsed === undefined ? {} : { position: parsed }),
      })
      setChapterId('')
      setTitle('')
      setPosition('')
      onMessage('章节已创建')
      await onReload()
    } catch (cause) {
      onError(cause)
    }
  }

  return (
    <form className="row" onSubmit={event => void submit(event)}>
      <Field label="章节 ID">
        <input value={chapterId} onChange={event => setChapterId(event.target.value)} />
      </Field>
      <Field label="标题">
        <input value={title} onChange={event => setTitle(event.target.value)} />
      </Field>
      <Field label="排序">
        <input className="narrow" value={position} onChange={event => setPosition(event.target.value)} />
      </Field>
      <button type="submit" disabled={chapterId.trim() === '' || title.trim() === ''}>新增章节</button>
    </form>
  )
}

function AddPointForm({
  courseId,
  chapterId,
  onReload,
  onError,
  onMessage,
}: {
  courseId: string
  chapterId: string
  onReload: () => Promise<void>
  onError: (cause: unknown) => void
  onMessage: (message: string) => void
}) {
  const [knowledgePointId, setKnowledgePointId] = useState('')
  const [title, setTitle] = useState('')
  const [position, setPosition] = useState('')

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault()
    const parsed = position.trim() === '' ? undefined : toNumber(position)
    if (position.trim() !== '' && parsed === undefined) {
      onError(new Error('position 必须是整数'))
      return
    }
    try {
      await createKnowledgePoint(courseId, chapterId, {
        knowledgePointId: knowledgePointId.trim(),
        title: title.trim(),
        ...(parsed === undefined ? {} : { position: parsed }),
      })
      setKnowledgePointId('')
      setTitle('')
      setPosition('')
      onMessage('知识点已创建')
      await onReload()
    } catch (cause) {
      onError(cause)
    }
  }

  return (
    <form className="row" onSubmit={event => void submit(event)}>
      <Field label="知识点 ID">
        <input value={knowledgePointId} onChange={event => setKnowledgePointId(event.target.value)} />
      </Field>
      <Field label="标题">
        <input value={title} onChange={event => setTitle(event.target.value)} />
      </Field>
      <Field label="排序">
        <input className="narrow" value={position} onChange={event => setPosition(event.target.value)} />
      </Field>
      <button type="submit" disabled={knowledgePointId.trim() === '' || title.trim() === ''}>新增知识点</button>
    </form>
  )
}

function ArticleEditor({
  knowledgePointId,
  onClose,
  onSaved,
  onError,
}: {
  knowledgePointId: string
  onClose: () => void
  onSaved: () => Promise<void>
  onError: (cause: unknown) => void
}) {
  const [article, setArticle] = useState<Article | null>(null)
  const [loaded, setLoaded] = useState(false)
  const [markdown, setMarkdown] = useState('')
  const [status, setStatus] = useState<ContentStatus>('draft')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let active = true
    void getArticle(knowledgePointId)
      .then(value => {
        if (!active) return
        setArticle(value)
        setMarkdown(value?.markdown ?? '')
        setStatus(value?.status ?? 'draft')
        setLoaded(true)
      })
      .catch(onError)
    return () => {
      active = false
    }
  }, [knowledgePointId])

  const save = async (): Promise<void> => {
    setBusy(true)
    try {
      const saved = await putArticle(knowledgePointId, { markdown, status })
      setArticle(saved)
      await onSaved()
    } catch (cause) {
      onError(cause)
    } finally {
      setBusy(false)
    }
  }

  const meta: ArticleMeta | null = article
  return (
    <section className="card">
      <div className="spread">
        <h2>文章：{knowledgePointId}</h2>
        <button className="ghost" onClick={onClose}>关闭</button>
      </div>
      {!loaded ? <p className="muted">加载中…</p> : null}
      <p className="muted">
        版本 {meta?.version ?? '—'} · 最后发布 {formatTime(meta?.publishedAt ?? null)} · 支持 Markdown 子集，禁止 HTML/脚本。
      </p>
      <textarea
        className="editor"
        value={markdown}
        onChange={event => setMarkdown(event.target.value)}
        placeholder="# 知识点文章"
      />
      <div className="row">
        <Field label="状态">
          <StatusSelect value={status} onChange={setStatus} />
        </Field>
        <button onClick={() => void save()} disabled={busy || markdown.trim() === '' || markdown.length > 20000}>
          保存文章
        </button>
        <span className="muted">{markdown.length} / 20000</span>
      </div>
    </section>
  )
}
