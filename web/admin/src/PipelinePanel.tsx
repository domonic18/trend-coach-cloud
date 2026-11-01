import { useEffect, useState, type FormEvent } from 'react'
import {
  applyGeneration,
  cancelPipelineJob,
  createMediaAsset,
  discardGeneration,
  enqueueGeneration,
  enqueueIngest,
  getGeneration,
  getPipelineJob,
  getTranscript,
  listCourses,
  listMediaAssets,
  listPipelineJobs,
  publishCourse,
  retryPipelineJob,
  uploadMediaSource,
} from './api'
import type {
  CourseSummary,
  GenerationPreview,
  MediaAsset,
  PipelineJob,
  TranscriptPage,
} from './types'
import { Field, Notice } from './ui'

const ACTIVE_JOB: ReadonlySet<PipelineJob['status']> = new Set(['queued', 'running'])

function formatSeconds(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`
}

function formatBytes(value: number | null): string {
  if (value === null) return '—'
  const mib = value / (1024 * 1024)
  return mib >= 1 ? `${mib.toFixed(1)} MiB` : `${(value / 1024).toFixed(1)} KiB`
}

export function PipelinePanel({
  onUnauthorized,
  onOpenContent,
}: {
  onUnauthorized: () => void
  onOpenContent: () => void
}) {
  const [courses, setCourses] = useState<CourseSummary[]>([])
  const [courseId, setCourseId] = useState<string | null>(null)
  const [assets, setAssets] = useState<MediaAsset[]>([])
  const [jobs, setJobs] = useState<PipelineJob[]>([])
  const [title, setTitle] = useState('')
  const [language, setLanguage] = useState<'zh' | 'en' | 'auto'>('zh')
  const [files, setFiles] = useState<Record<string, File>>({})
  const [progress, setProgress] = useState<Record<string, number>>({})
  const [transcript, setTranscript] = useState<TranscriptPage | null>(null)
  const [preview, setPreview] = useState<GenerationPreview | null>(null)
  const [busy, setBusy] = useState(false)
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

  const refreshCourses = async (): Promise<void> => {
    const list = await listCourses()
    setCourses(list)
    setCourseId(current => {
      if (current !== null && list.some(course => course.courseId === current)) return current
      return list.find(course => course.status === 'draft')?.courseId ?? list[0]?.courseId ?? null
    })
  }

  const refreshAssets = async (id: string): Promise<void> => {
    const page = await listMediaAssets({ courseId: id, limit: 100 })
    setAssets(page.assets)
    const pipelineJobs = await listPipelineJobs({ courseId: id, limit: 100 })
    setJobs(pipelineJobs.jobs)
  }

  useEffect(() => {
    void refreshCourses().catch(fail)
  }, [])

  useEffect(() => {
    if (courseId === null) {
      setAssets([])
      setJobs([])
      return
    }
    setTranscript(null)
    setPreview(null)
    void refreshAssets(courseId).catch(fail)
  }, [courseId])

  useEffect(() => {
    if (courseId === null || !jobs.some(job => ACTIVE_JOB.has(job.status))) return
    const id = courseId
    const timer = setInterval(() => {
      void refreshAssets(id).catch(fail)
    }, 2500)
    return () => clearInterval(timer)
  }, [courseId, jobs])

  const run = async (action: () => Promise<string | void>): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      const text = await action()
      setMessage(text === undefined ? '操作完成' : text)
      if (courseId !== null) await refreshAssets(courseId)
      await refreshCourses()
    } catch (cause) {
      fail(cause)
    } finally {
      setBusy(false)
    }
  }

  const createAsset = (event: FormEvent): void => {
    event.preventDefault()
    if (courseId === null || title.trim() === '') return
    void run(async () => {
      const asset = await createMediaAsset({ courseId, title: title.trim() })
      setTitle('')
      return `素材已创建：${asset.assetId}`
    })
  }

  const upload = (asset: MediaAsset): void => {
    const file = files[asset.assetId]
    if (file === undefined) return
    void run(async () => {
      setProgress(current => ({ ...current, [asset.assetId]: 0 }))
      try {
        const updated = await uploadMediaSource(asset.assetId, file, ratio => {
          setProgress(current => ({ ...current, [asset.assetId]: ratio }))
        })
        setFiles(current => {
          const next = { ...current }
          delete next[asset.assetId]
          return next
        })
        return `已上传 ${formatBytes(updated.sourceSizeBytes)}`
      } finally {
        setProgress(current => {
          const next = { ...current }
          delete next[asset.assetId]
          return next
        })
      }
    })
  }

  const selectedCourse = courses.find(course => course.courseId === courseId) ?? null
  const settled = preview !== null
    && (preview.generation.status === 'applied' || preview.generation.status === 'discarded')

  return (
    <div className="stack">
      <Notice error={error} message={message} />

      <section className="card">
        <div className="spread">
          <h2>视频建课</h2>
          <button className="ghost" disabled={busy} onClick={() => void refreshCourses().catch(fail)}>
            刷新课程
          </button>
        </div>
        <p className="hint">
          新建草稿课程后上传视频；处理完成再生成内容，人工预览、应用，最后发布并建立索引。
        </p>
        <div className="row">
          <Field label="课程">
            <select
              value={courseId ?? ''}
              onChange={event => setCourseId(event.target.value === '' ? null : event.target.value)}
            >
              <option value="">选择课程…</option>
              {courses.map(course => (
                <option key={course.courseId} value={course.courseId}>
                  {course.courseId} · {course.title} · {course.status}
                </option>
              ))}
            </select>
          </Field>
          <Field label="语言">
            <select value={language} onChange={event => setLanguage(event.target.value as typeof language)}>
              <option value="zh">中文</option>
              <option value="en">英文</option>
              <option value="auto">自动</option>
            </select>
          </Field>
          <button
            className="ghost"
            disabled={busy || selectedCourse === null || selectedCourse.status !== 'draft'}
            onClick={() => {
              if (selectedCourse === null) return
              if (!window.confirm(`发布课程 ${selectedCourse.courseId}？将同步重建索引。`)) return
              void run(async () => {
                const result = await publishCourse(selectedCourse.courseId)
                return `已发布：文章 ${result.articlesPublished}、片段 ${result.segmentsPublished}，`
                  + (result.indexed ? `索引 ${result.embedded} 条` : '未配置 embedding，仅词法检索')
              })
            }}
          >
            发布课程
          </button>
        </div>
        <form className="row" autoComplete="off" onSubmit={createAsset}>
          <Field label="素材标题">
            <input
              value={title}
              onChange={event => setTitle(event.target.value)}
              placeholder="第 1 讲：趋势反转"
            />
          </Field>
          <button
            type="submit"
            disabled={busy || courseId === null || selectedCourse?.status !== 'draft' || title.trim() === ''}
          >
            新建素材
          </button>
        </form>
        {selectedCourse !== null && selectedCourse.status !== 'draft' ? (
          <p className="hint">只有草稿课程可以新建素材；已发布课程请先在「课程内容」调整状态。</p>
        ) : null}
      </section>

      <section className="card">
        <div className="spread">
          <h2>素材</h2>
          <button
            className="ghost"
            disabled={busy || courseId === null}
            onClick={() => {
              if (courseId === null) return
              void run(async () => { await refreshAssets(courseId) })
            }}
          >
            刷新
          </button>
        </div>
        <table>
          <thead>
            <tr>
              <th>素材</th>
              <th>状态</th>
              <th>时长 / 大小</th>
              <th>上传</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {assets.map(asset => {
              const ratio = progress[asset.assetId]
              const canUpload = asset.status === 'awaiting_upload'
                || asset.status === 'uploaded'
                || asset.status === 'failed'
              const canIngest = asset.status === 'uploaded' || asset.status === 'failed' || asset.status === 'ready'
              return (
                <tr key={asset.assetId}>
                  <td>
                    <strong>{asset.title ?? asset.assetId}</strong>
                    <div className="muted"><code>{asset.assetId}</code></div>
                    {asset.errorCode === null ? null : (
                      <div className="muted">错误：{asset.errorCode}</div>
                    )}
                  </td>
                  <td>
                    <span className={`badge asset-${asset.status}`}>{asset.status}</span>
                    {ratio === undefined ? null : (
                      <div className="progress"><span style={{ width: `${Math.round(ratio * 100)}%` }} /></div>
                    )}
                  </td>
                  <td>
                    {asset.durationMs === null ? '—' : formatSeconds(asset.durationMs)}
                    <div className="muted">{formatBytes(asset.sourceSizeBytes)}</div>
                  </td>
                  <td>
                    <input
                      type="file"
                      accept="video/*"
                      disabled={!canUpload || busy}
                      onChange={event => {
                        const file = event.target.files?.[0]
                        if (file === undefined) return
                        setFiles(current => ({ ...current, [asset.assetId]: file }))
                      }}
                    />
                  </td>
                  <td className="actions">
                    <button
                      className="ghost"
                      disabled={busy || !canUpload || files[asset.assetId] === undefined}
                      onClick={() => upload(asset)}
                    >
                      上传
                    </button>
                    <button
                      className="ghost"
                      disabled={busy || !canIngest}
                      onClick={() => void run(async () => {
                        await enqueueIngest(asset.assetId, language)
                        return '已入队转码与转写'
                      })}
                    >
                      处理
                    </button>
                    <button
                      className="ghost"
                      disabled={busy || asset.status !== 'ready'}
                      onClick={() => void run(async () => {
                        const page = await getTranscript(asset.assetId, { limit: 200 })
                        setTranscript(page)
                      })}
                    >
                      转写
                    </button>
                    <button
                      className="ghost"
                      disabled={busy || asset.status !== 'ready'}
                      onClick={() => void run(async () => {
                        await enqueueGeneration(asset.assetId)
                        return '已入队内容生成'
                      })}
                    >
                      生成
                    </button>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
        {assets.length === 0 ? <p className="muted">该课程暂无素材。</p> : null}
      </section>

      <section className="card">
        <h2>任务</h2>
        <table>
          <thead>
            <tr>
              <th>任务</th>
              <th>状态</th>
              <th>进度</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {jobs.map(job => (
              <tr key={job.jobId}>
                <td>
                  <code>{job.jobId}</code>
                  <div className="muted">{job.kind} · 尝试 {job.attempts}/{job.maxAttempts}</div>
                  {job.errorCode === null ? null : <div className="muted">错误：{job.errorCode}</div>}
                </td>
                <td>
                  <span className={`badge job-${job.status}`}>{job.status}</span>
                  <div className="muted">{job.stage}</div>
                </td>
                <td>
                  <div className="progress"><span style={{ width: `${job.progress}%` }} /></div>
                  <div className="muted">{job.progress}%</div>
                </td>
                <td className="actions">
                  {job.kind === 'generate' && job.status === 'succeeded' ? (
                    <button
                      className="ghost"
                      disabled={busy}
                      onClick={() => void run(async () => {
                        const detail = await getPipelineJob(job.jobId)
                        const generationId = detail.result.generationId
                        if (generationId === null) throw new Error('任务没有生成结果')
                        const generation = await getGeneration(generationId)
                        setPreview(generation)
                        return '生成结果已加载'
                      })}
                    >
                      预览
                    </button>
                  ) : null}
                  <button
                    className="ghost"
                    disabled={busy || (job.status !== 'queued' && job.status !== 'running')}
                    onClick={() => void run(async () => {
                      await cancelPipelineJob(job.jobId)
                      return '已请求取消'
                    })}
                  >
                    取消
                  </button>
                  <button
                    className="ghost"
                    disabled={busy || (job.status !== 'failed' && job.status !== 'canceled')}
                    onClick={() => void run(async () => {
                      await retryPipelineJob(job.jobId)
                      return '已重新入队'
                    })}
                  >
                    重试
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {jobs.length === 0 ? <p className="muted">暂无任务。</p> : null}
      </section>

      {transcript === null ? null : (
        <section className="card">
          <div className="spread">
            <h2>转写（{transcript.transcript.status}，{transcript.total} 段）</h2>
            <button className="ghost" onClick={() => setTranscript(null)}>关闭</button>
          </div>
          <p className="hint">
            时长 {transcript.transcript.durationMs === null ? '—' : formatSeconds(transcript.transcript.durationMs)}
            ，分块 {transcript.transcript.chunkCount}，语言 {transcript.transcript.language}
            {transcript.total > transcript.limit ? `；仅显示前 ${transcript.limit} 段` : ''}
          </p>
          <table>
            <thead>
              <tr><th>时间</th><th>文本</th></tr>
            </thead>
            <tbody>
              {transcript.segments.map(segment => (
                <tr key={segment.idx}>
                  <td>{formatSeconds(segment.startMs)}–{formatSeconds(segment.endMs)}</td>
                  <td>{segment.text}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      {preview === null ? null : (
        <section className="card">
          <div className="spread">
            <h2>生成预览</h2>
            <button className="ghost" onClick={() => setPreview(null)}>关闭</button>
          </div>
          <p className="hint">
            <code>{preview.generation.generationId}</code> · {preview.generation.status}
            {' '}· 模型 {preview.generation.model} · 提示词 {preview.generation.promptVersion}
            {' '}· 章节 {preview.generation.chapters} · 知识点 {preview.generation.knowledgePoints}
            {' '}· 片段 {preview.generation.segments} · 待审 {preview.generation.needsReview}
          </p>
          <table>
            <thead>
              <tr><th>章节</th><th>知识点</th><th>置信度</th><th>状态</th></tr>
            </thead>
            <tbody>
              {preview.knowledgePoints.map(point => {
                const chapter = preview.chapters.find(item => item.key === point.chapterKey)
                return (
                  <tr key={point.key}>
                    <td>{chapter?.title ?? point.chapterKey}</td>
                    <td>{point.title}<div className="muted"><code>{point.key}</code></div></td>
                    <td>{point.confidence.toFixed(2)}</td>
                    <td>
                      {point.needsReview ? (
                        <span className="badge needs-review">
                          待审：{point.reviewReasons.join('、')}
                        </span>
                      ) : <span className="badge badge-published">正常</span>}
                      {point.hasArticle ? null : <div className="muted">无文章草稿</div>}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
          <table>
            <thead>
              <tr><th>片段</th><th>时间</th><th>知识点</th></tr>
            </thead>
            <tbody>
              {preview.segments.map(segment => (
                <tr key={segment.key}>
                  <td>{segment.title}</td>
                  <td>{formatSeconds(segment.startMs)}–{formatSeconds(segment.endMs)}</td>
                  <td><code>{segment.pointKey}</code></td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="row">
            <button
              disabled={busy || preview.generation.status !== 'draft'}
              onClick={() => void run(async () => {
                const result = await applyGeneration(preview.generation.generationId)
                setPreview(await getGeneration(preview.generation.generationId))
                return result.alreadyApplied
                  ? '该生成结果此前已应用'
                  : `已应用：章节 ${Object.keys(result.applied.chapters).length}、知识点 ${Object.keys(result.applied.knowledgePoints).length}、片段 ${Object.keys(result.applied.segments).length}`
              })}
            >
              应用到草稿课程
            </button>
            <button
              className="ghost"
              disabled={busy || preview.generation.status !== 'draft'}
              onClick={() => {
                if (!window.confirm('丢弃该生成草稿？')) return
                void run(async () => {
                  await discardGeneration(preview.generation.generationId)
                  setPreview(null)
                  return '生成草稿已丢弃'
                })
              }}
            >
              丢弃
            </button>
            {settled ? (
              <button className="ghost" onClick={onOpenContent}>前往课程内容</button>
            ) : null}
            <span className="muted">草稿内容不会直接对学员可见，需在课程内容页检查后发布。</span>
          </div>
        </section>
      )}
    </div>
  )
}
