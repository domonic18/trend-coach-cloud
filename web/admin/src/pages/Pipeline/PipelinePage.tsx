import { PlusOutlined, ReloadOutlined, RocketOutlined } from '@ant-design/icons'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  App,
  Button,
  Card,
  Form,
  Input,
  Modal,
  Select,
  Space,
  Steps,
  Tooltip,
  Typography,
} from 'antd'
import { useEffect, useRef, useState } from 'react'
import {
  createMediaAsset,
  listCourses,
  listMediaAssets,
  listPipelineJobs,
  publishCourse,
} from '../../api'
import { PageHeader } from '../../components/PageHeader'
import { qk } from '../../lib/queryKeys'
import type { MediaAsset } from '../../types'
import { AssetTable } from './AssetTable'
import { GenerationDrawer } from './GenerationDrawer'
import { JobTable } from './JobTable'
import { TranscriptDrawer } from './TranscriptDrawer'

const ACTIVE = new Set(['queued', 'running'])

export function PipelinePage() {
  const queryClient = useQueryClient()
  const { message, modal } = App.useApp()
  const [courseId, setCourseId] = useState('')
  const [language, setLanguage] = useState<'zh' | 'en' | 'auto'>('zh')
  const [creating, setCreating] = useState(false)
  const [transcriptAsset, setTranscriptAsset] = useState<MediaAsset | null>(null)
  const [generationId, setGenerationId] = useState<string | null>(null)
  const [form] = Form.useForm<{ title: string }>()

  const courses = useQuery({ queryKey: qk.courses, queryFn: listCourses })

  useEffect(() => {
    if (courseId !== '' || courses.data === undefined) return
    const list = courses.data
    const next = list.find(course => course.status === 'draft') ?? list[0]
    if (next !== undefined) setCourseId(next.courseId)
  }, [courseId, courses.data])

  const jobs = useQuery({
    queryKey: qk.jobs({ courseId, limit: 100 }),
    queryFn: () => listPipelineJobs({ courseId, limit: 100 }),
    enabled: courseId !== '',
    refetchInterval: query =>
      (query.state.data?.jobs ?? []).some(job => ACTIVE.has(job.status)) ? 2500 : false,
  })

  const assets = useQuery({
    queryKey: qk.assets(courseId === '' ? null : courseId),
    queryFn: () => listMediaAssets({ courseId, limit: 100 }),
    enabled: courseId !== '',
    refetchInterval: (jobs.data?.jobs ?? []).some(job => ACTIVE.has(job.status)) ? 3000 : false,
  })

  const create = useMutation({
    mutationFn: (values: { title: string }) => createMediaAsset({ courseId, title: values.title.trim() }),
    onSuccess: async asset => {
      await queryClient.invalidateQueries({ queryKey: ['pipeline'] })
      setCreating(false)
      form.resetFields()
      void message.success(`素材已创建：${asset.assetId}`)
    },
  })

  const publish = useMutation({
    mutationFn: () => publishCourse(courseId),
    onSuccess: async result => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: qk.courses }),
        queryClient.invalidateQueries({ queryKey: ['pipeline'] }),
      ])
      modal.success({
        title: '发布完成',
        content: `已发布章节 ${result.counts.chapters} 章、教材 ${result.counts.chapterArticles} 篇、`
          + `图示 ${result.counts.figures} 张、片段 ${result.counts.segments} 个；${
            result.indexed ? `索引已更新（${result.embedded} 条）` : '未配置向量模型，仅词法检索'
          }。`,
      })
    },
  })

  const selectedCourse = courses.data?.find(course => course.courseId === courseId)
  const assetList = assets.data?.assets ?? []
  const jobList = jobs.data?.jobs ?? []
  const activeJobs = jobList.some(job => ACTIVE.has(job.status))
  const wasActive = useRef(false)

  useEffect(() => {
    if (wasActive.current && !activeJobs && courseId !== '') {
      void queryClient.invalidateQueries({ queryKey: ['pipeline'] })
    }
    wasActive.current = activeJobs
  }, [activeJobs, courseId, queryClient])
  const hasUploaded = assetList.some(asset =>
    asset.status === 'uploaded' || asset.status === 'processing' || asset.status === 'ready')
  const hasReady = assetList.some(asset => asset.status === 'ready')
  const published = selectedCourse?.status === 'published'
  const current = courseId === ''
    ? 0
    : !hasUploaded ? 1
      : !hasReady ? 2
        : published ? 5 : 3

  const refresh = (): void => {
    void queryClient.invalidateQueries({ queryKey: ['pipeline'] })
    void queryClient.invalidateQueries({ queryKey: qk.courses })
  }

  const confirmPublish = (): void => {
    if (selectedCourse === undefined) return
    modal.confirm({
      title: `发布课程 ${selectedCourse.courseId}？`,
      content: '发布后草稿内容对学员可见，并自动重建检索索引。',
      okText: '发布',
      cancelText: '取消',
      onOk: () => publish.mutateAsync().then(() => undefined),
    })
  }

  return (
    <>
      <PageHeader
        title="视频建课"
        subtitle="从源视频到课程草稿：上传、转写、结构化生成、人工审核与发布。"
        extra={
          <>
            <Button icon={<ReloadOutlined />} onClick={refresh}>刷新</Button>
            <Tooltip title={selectedCourse?.status === 'draft' ? '' : '仅草稿课程可发布'}>
              <Button
                type="primary"
                icon={<RocketOutlined />}
                disabled={selectedCourse?.status !== 'draft'}
                loading={publish.isPending}
                onClick={confirmPublish}
              >
                发布课程
              </Button>
            </Tooltip>
          </>
        }
      />

      <Card className="pipeline-steps">
        <Steps
          size="small"
          current={current}
          responsive
          items={[
            { title: '选择课程', description: '草稿课程' },
            { title: '上传素材', description: '源视频' },
            { title: '处理转写', description: '转码与时间轴' },
            { title: '生成预览', description: '审查结构' },
            { title: '应用发布', description: '索引并上线' },
          ]}
        />
        <Space wrap size={12} className="pipeline-toolbar">
          <Select
            showSearch
            optionFilterProp="label"
            placeholder="选择课程"
            style={{ width: 320 }}
            loading={courses.isLoading}
            value={courseId === '' ? undefined : courseId}
            onChange={value => setCourseId(value ?? '')}
            options={(courses.data ?? []).map(course => ({
              value: course.courseId,
              label: `${course.title}（${course.courseId}）· ${course.status === 'draft' ? '草稿' : course.status === 'published' ? '已发布' : '已归档'}`,
            }))}
          />
          <Select<'zh' | 'en' | 'auto'>
            value={language}
            style={{ width: 120 }}
            onChange={setLanguage}
            options={[
              { value: 'zh', label: '中文' },
              { value: 'en', label: '英文' },
              { value: 'auto', label: '自动' },
            ]}
          />
          <Button
            icon={<PlusOutlined />}
            disabled={selectedCourse?.status !== 'draft'}
            onClick={() => setCreating(true)}
          >
            新建素材
          </Button>
          {selectedCourse !== undefined && selectedCourse.status !== 'draft' ? (
            <Typography.Text type="secondary">
              只有草稿课程可以新建素材；已发布课程请先在课程内容页调整状态。
            </Typography.Text>
          ) : null}
        </Space>
      </Card>

      <Card title="素材" className="pipeline-card">
        <AssetTable
          assets={assetList}
          loading={assets.isLoading}
          language={language}
          onTranscript={setTranscriptAsset}
        />
      </Card>

      <Card title="建课任务" className="pipeline-card">
        <JobTable jobs={jobList} loading={jobs.isLoading} onPreview={setGenerationId} />
      </Card>

      <Modal
        open={creating}
        title="新建素材"
        okText="创建"
        cancelText="取消"
        confirmLoading={create.isPending}
        onCancel={() => {
          setCreating(false)
          form.resetFields()
        }}
        onOk={() => {
          void form.validateFields().then(values => create.mutate(values))
        }}
        destroyOnHidden
      >
        <Form<{ title: string }> form={form} layout="vertical" preserve={false}>
          <Form.Item
            name="title"
            label="素材标题"
            rules={[{ required: true, message: '请输入素材标题' }]}
          >
            <Input placeholder="第 1 讲：趋势反转" />
          </Form.Item>
          <Typography.Text type="secondary">
            创建后上传视频（MP4 / MOV 等），再点击「处理」生成转写与时间轴。
          </Typography.Text>
        </Form>
      </Modal>

      <TranscriptDrawer
        asset={transcriptAsset}
        open={transcriptAsset !== null}
        onClose={() => setTranscriptAsset(null)}
      />

      <GenerationDrawer
        generationId={generationId}
        open={generationId !== null}
        onClose={() => setGenerationId(null)}
      />
    </>
  )
}
