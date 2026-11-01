import { DatabaseOutlined, EditOutlined, FileTextOutlined, PlusOutlined, RocketOutlined } from '@ant-design/icons'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  App,
  Button,
  Card,
  Collapse,
  Empty,
  Form,
  Input,
  InputNumber,
  List,
  Modal,
  Select,
  Space,
  Spin,
  Tag,
  Tooltip,
  Typography,
} from 'antd'
import { useEffect, useState } from 'react'
import {
  createChapter,
  createKnowledgePoint,
  getCourseTree,
  patchChapter,
  patchCourse,
  patchKnowledgePoint,
  publishCourse,
  reindex,
} from '../../api'
import { StatusTag } from '../../components/StatusTag'
import { qk } from '../../lib/queryKeys'
import type { Chapter, ContentStatus, CourseTree, KnowledgePoint } from '../../types'
import { ArticleDrawer } from './ArticleDrawer'

interface CourseInfoForm {
  title: string
  status: ContentStatus
}

interface NameForm {
  title: string
  position?: number
}

interface CreateForm extends NameForm {
  id: string
}

type EditableChapter = { mode: 'chapter'; chapter: Chapter }
type EditablePoint = { mode: 'point'; point: KnowledgePoint }

export function CourseEditor({ courseId }: { courseId: string }) {
  const queryClient = useQueryClient()
  const { message, modal } = App.useApp()
  const [form] = Form.useForm<CourseInfoForm>()
  const [articlePoint, setArticlePoint] = useState<KnowledgePoint | null>(null)
  const [chapterModal, setChapterModal] = useState(false)
  const [pointModal, setPointModal] = useState<{ chapterId: string } | null>(null)
  const [rename, setRename] = useState<EditableChapter | EditablePoint | null>(null)
  const [nameForm] = Form.useForm<NameForm>()

  const tree = useQuery({ queryKey: qk.course(courseId), queryFn: () => getCourseTree(courseId) })

  useEffect(() => {
    if (tree.data === undefined) return
    form.setFieldsValue({ title: tree.data.course.title, status: tree.data.course.status })
  }, [form, tree.data])

  const invalidate = async (): Promise<void> => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: qk.course(courseId) }),
      queryClient.invalidateQueries({ queryKey: qk.courses }),
    ])
  }

  const saveCourse = useMutation({
    mutationFn: (values: CourseInfoForm) => patchCourse(courseId, values),
    onSuccess: async () => {
      await invalidate()
      void message.success('课程信息已保存')
    },
  })

  const rebuild = useMutation({
    mutationFn: () => reindex(courseId),
    onSuccess: embedded => {
      void message.success(`索引已重建，共向量化 ${embedded} 个片段`)
    },
  })

  const publish = useMutation({
    mutationFn: () => publishCourse(courseId),
    onSuccess: async result => {
      await invalidate()
      modal.success({
        title: '发布完成',
        content: `已发布 ${result.articlesPublished} 篇文章、${result.segmentsPublished} 个片段；${
          result.indexed ? `索引已更新（${result.embedded} 条）` : '索引未更新'
        }。`,
      })
    },
  })

  const addChapter = useMutation({
    mutationFn: (values: CreateForm) => createChapter(courseId, {
      chapterId: values.id,
      title: values.title,
      ...(values.position === undefined ? {} : { position: values.position }),
    }),
    onSuccess: async () => {
      await invalidate()
      setChapterModal(false)
      void message.success('章节已创建')
    },
  })

  const addPoint = useMutation({
    mutationFn: ({ chapterId, values }: { chapterId: string; values: CreateForm }) => createKnowledgePoint(
      courseId,
      chapterId,
      {
        knowledgePointId: values.id,
        title: values.title,
        ...(values.position === undefined ? {} : { position: values.position }),
      },
    ),
    onSuccess: async () => {
      await invalidate()
      setPointModal(null)
      void message.success('知识点已创建')
    },
  })

  const renameItem = useMutation({
    mutationFn: async () => {
      const values = await nameForm.validateFields()
      if (rename === null) return
      if (rename.mode === 'chapter') {
        await patchChapter(courseId, rename.chapter.chapterId, {
          title: values.title,
          ...(values.position === undefined ? {} : { position: values.position }),
        })
        return
      }
      await patchKnowledgePoint(rename.point.knowledgePointId, {
        title: values.title,
        ...(values.position === undefined ? {} : { position: values.position }),
      })
    },
    onSuccess: async () => {
      await invalidate()
      setRename(null)
      void message.success('已更新')
    },
  })

  const confirmPublish = (): void => {
    modal.confirm({
      title: '发布课程？',
      content: '发布后所有草稿文章与片段将对外可见，并触发检索索引重建。',
      okText: '发布',
      cancelText: '取消',
      onOk: () => publish.mutateAsync().then(() => undefined),
    })
  }

  if (tree.isLoading) return <div className="page-loading"><Spin /></div>
  if (tree.isError || tree.data === undefined) {
    return <Card><Empty description="课程不存在或加载失败" /></Card>
  }

  const data: CourseTree = tree.data

  return (
    <div className="course-editor">
      <Card
        title="课程信息"
        extra={
          <Space wrap>
            <Tooltip title="重新生成该课程全部片段的向量索引">
              <Button icon={<DatabaseOutlined />} loading={rebuild.isPending} onClick={() => rebuild.mutate()}>
                重建向量
              </Button>
            </Tooltip>
            <Button
              type="primary"
              icon={<RocketOutlined />}
              loading={publish.isPending}
              onClick={confirmPublish}
            >
              发布课程
            </Button>
          </Space>
        }
      >
        <Form<CourseInfoForm> form={form} layout="inline" onFinish={values => saveCourse.mutate(values)}>
          <Form.Item name="title" label="标题" rules={[{ required: true, message: '请输入课程标题' }]}>
            <Input style={{ width: 320 }} />
          </Form.Item>
          <Form.Item name="status" label="状态">
            <Select
              style={{ width: 120 }}
              options={[
                { value: 'draft', label: '草稿' },
                { value: 'published', label: '已发布' },
                { value: 'archived', label: '已归档' },
              ]}
            />
          </Form.Item>
          <Form.Item>
            <Button htmlType="submit" loading={saveCourse.isPending}>保存</Button>
          </Form.Item>
        </Form>
      </Card>

      <Card
        title="课程结构"
        extra={<Button icon={<PlusOutlined />} onClick={() => setChapterModal(true)}>新增章节</Button>}
      >
        {data.chapters.length === 0 ? (
          <Empty description="还没有章节，先创建一个章节。" />
        ) : (
          <Collapse
            accordion={false}
            items={data.chapters.map((chapter, index) => ({
              key: chapter.chapterId,
              label: (
                <Space>
                  <Typography.Text strong>{chapter.title}</Typography.Text>
                  <Tag bordered={false}>{chapter.chapterId}</Tag>
                  <Typography.Text type="secondary">{chapter.knowledgePoints.length} 个知识点</Typography.Text>
                </Space>
              ),
              extra: (
                <Space onClick={event => event.stopPropagation()}>
                  <Button
                    type="text"
                    size="small"
                    icon={<EditOutlined />}
                    onClick={() => openRename({ mode: 'chapter', chapter })}
                  />
                  <Button
                    type="text"
                    size="small"
                    icon={<PlusOutlined />}
                    onClick={() => setPointModal({ chapterId: chapter.chapterId })}
                  >
                    知识点
                  </Button>
                </Space>
              ),
              children: chapter.knowledgePoints.length === 0 ? (
                <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="该章节暂无知识点" />
              ) : (
                <List
                  size="small"
                  dataSource={chapter.knowledgePoints}
                  renderItem={point => (
                    <List.Item
                      actions={[
                        <Button
                          key="article"
                          type="link"
                          size="small"
                          icon={<FileTextOutlined />}
                          onClick={() => setArticlePoint(point)}
                        >
                          文章
                        </Button>,
                        <Button
                          key="rename"
                          type="link"
                          size="small"
                          icon={<EditOutlined />}
                          onClick={() => openRename({ mode: 'point', point })}
                        />,
                      ]}
                    >
                      <List.Item.Meta
                        title={
                          <Space wrap>
                            <span>{point.title}</span>
                            {point.article === null ? (
                              <Tag bordered={false}>无文章</Tag>
                            ) : (
                              <>
                                <StatusTag value={point.article.status} />
                                <Typography.Text type="secondary">v{point.article.version}</Typography.Text>
                              </>
                            )}
                          </Space>
                        }
                        description={
                          <Space size={8}>
                            <Typography.Text type="secondary">{point.knowledgePointId}</Typography.Text>
                            <Typography.Text type="secondary">{point.segmentCount} 个片段</Typography.Text>
                          </Space>
                        }
                      />
                    </List.Item>
                  )}
                />
              ),
            }))}
            defaultActiveKey={data.chapters[0] === undefined ? [] : [data.chapters[0].chapterId]}
          />
        )}
      </Card>

      <ArticleDrawer
        courseId={courseId}
        point={articlePoint}
        open={articlePoint !== null}
        onClose={() => setArticlePoint(null)}
      />

      <CreateModal
        open={chapterModal}
        title="新增章节"
        idLabel="章节 ID"
        onCancel={() => setChapterModal(false)}
        submitting={addChapter.isPending}
        onSubmit={values => addChapter.mutate(values)}
      />

      <CreateModal
        open={pointModal !== null}
        title="新增知识点"
        idLabel="知识点 ID"
        onCancel={() => setPointModal(null)}
        submitting={addPoint.isPending}
        onSubmit={values => {
          if (pointModal === null) return
          addPoint.mutate({ chapterId: pointModal.chapterId, values })
        }}
      />

      <Modal
        open={rename !== null}
        title={rename?.mode === 'chapter' ? '编辑章节' : '编辑知识点'}
        okText="保存"
        cancelText="取消"
        confirmLoading={renameItem.isPending}
        onCancel={() => setRename(null)}
        onOk={() => renameItem.mutate()}
        destroyOnHidden
      >
        <Form<NameForm>
          form={nameForm}
          layout="vertical"
          preserve={false}
          initialValues={{
            title: rename?.mode === 'chapter' ? rename.chapter.title : rename?.point.title,
            position: rename?.mode === 'chapter' ? rename.chapter.position : rename?.point.position,
          }}
        >
          <Form.Item name="title" label="标题" rules={[{ required: true, message: '请输入标题' }]}>
            <Input />
          </Form.Item>
          <Form.Item name="position" label="排序位置">
            <InputNumber min={1} placeholder="可选，从 1 开始" style={{ width: '100%' }} />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  )

  function openRename(target: EditableChapter | EditablePoint): void {
    setRename(target)
  }
}

function CreateModal({
  open,
  title,
  idLabel,
  submitting,
  onCancel,
  onSubmit,
}: {
  open: boolean
  title: string
  idLabel: string
  submitting: boolean
  onCancel: () => void
  onSubmit: (values: CreateForm) => void
}) {
  const [form] = Form.useForm<CreateForm>()
  return (
    <Modal
      open={open}
      title={title}
      okText="创建"
      cancelText="取消"
      confirmLoading={submitting}
      onCancel={onCancel}
      onOk={() => {
        void form.validateFields().then(values => onSubmit(values))
      }}
      destroyOnHidden
    >
      <Form<CreateForm> form={form} layout="vertical" preserve={false}>
        <Form.Item
          name="id"
          label={idLabel}
          rules={[
            { required: true, message: '请输入 ID' },
            { pattern: /^[A-Za-z0-9._-]{1,64}$/, message: '仅支持字母、数字、点、下划线与连字符，最长 64 位' },
          ]}
        >
          <Input placeholder="例如 ch-01 或 kp-01" />
        </Form.Item>
        <Form.Item name="title" label="标题" rules={[{ required: true, message: '请输入标题' }]}>
          <Input />
        </Form.Item>
        <Form.Item name="position" label="排序位置">
          <InputNumber min={1} placeholder="可选，从 1 开始" style={{ width: '100%' }} />
        </Form.Item>
      </Form>
    </Modal>
  )
}
