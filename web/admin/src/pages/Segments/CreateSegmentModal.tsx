import { useQuery } from '@tanstack/react-query'
import { Form, Input, InputNumber, Modal, Select, Space } from 'antd'
import { getCourseTree, listCourses } from '../../api'
import { qk } from '../../lib/queryKeys'
import type { ContentStatus } from '../../types'

export interface CreateSegmentValues {
  segmentId: string
  courseId: string
  chapterId: string
  knowledgePointId: string
  title: string
  startSec: number
  endSec: number
  text: string
  status: ContentStatus
}

export function CreateSegmentModal({
  open,
  submitting,
  onCancel,
  onSubmit,
}: {
  open: boolean
  submitting: boolean
  onCancel: () => void
  onSubmit: (values: CreateSegmentValues) => void
}) {
  const [form] = Form.useForm<CreateSegmentValues>()
  const courseId = Form.useWatch<string | undefined>('courseId', form)
  const chapterId = Form.useWatch<string | undefined>('chapterId', form)

  const courses = useQuery({ queryKey: qk.courses, queryFn: listCourses, enabled: open })
  const tree = useQuery({
    queryKey: qk.course(courseId ?? ''),
    queryFn: () => getCourseTree(courseId ?? ''),
    enabled: open && courseId !== undefined,
  })

  const chapters = tree.data?.chapters ?? []
  const points = chapters.find(chapter => chapter.chapterId === chapterId)?.knowledgePoints ?? []

  return (
    <Modal
      open={open}
      title="新建片段"
      okText="创建"
      cancelText="取消"
      width={680}
      confirmLoading={submitting}
      onCancel={onCancel}
      onOk={() => {
        void form.validateFields().then(values => onSubmit(values))
      }}
      destroyOnHidden
    >
      <Form<CreateSegmentValues>
        form={form}
        layout="vertical"
        preserve={false}
        initialValues={{ status: 'draft', startSec: 0, endSec: 10 }}
      >
        <Form.Item
          name="segmentId"
          label="片段 ID"
          rules={[
            { required: true, message: '请输入片段 ID' },
            { pattern: /^seg-[A-Za-z0-9._-]{1,76}$/, message: '格式为 seg- 开头，仅支持字母、数字、点、下划线与连字符' },
          ]}
        >
          <Input placeholder="例如 seg-tc101-m1-kp1-1" />
        </Form.Item>

        <Space size={12} wrap>
          <Form.Item name="courseId" label="课程" rules={[{ required: true, message: '请选择课程' }]}>
            <Select
              showSearch
              optionFilterProp="label"
              style={{ width: 260 }}
              placeholder="选择课程"
              loading={courses.isLoading}
              onChange={() => form.setFieldsValue({ chapterId: undefined, knowledgePointId: undefined })}
              options={(courses.data ?? []).map(course => ({
                value: course.courseId,
                label: `${course.title}（${course.courseId}）`,
              }))}
            />
          </Form.Item>
          <Form.Item name="chapterId" label="章节" rules={[{ required: true, message: '请选择章节' }]}>
            <Select
              style={{ width: 220 }}
              placeholder="选择章节"
              disabled={courseId === undefined}
              loading={tree.isLoading}
              onChange={() => form.setFieldsValue({ knowledgePointId: undefined })}
              options={chapters.map(chapter => ({
                value: chapter.chapterId,
                label: chapter.title,
              }))}
            />
          </Form.Item>
          <Form.Item
            name="knowledgePointId"
            label="知识点"
            rules={[{ required: true, message: '请选择知识点' }]}
          >
            <Select
              style={{ width: 220 }}
              placeholder="选择知识点"
              disabled={chapterId === undefined}
              options={points.map(point => ({
                value: point.knowledgePointId,
                label: point.title,
              }))}
            />
          </Form.Item>
        </Space>

        <Form.Item name="title" label="标题" rules={[{ required: true, message: '请输入标题' }]}>
          <Input />
        </Form.Item>

        <Space size={12} wrap>
          <Form.Item name="startSec" label="起始秒" rules={[{ required: true, message: '请输入起始时间' }]}>
            <InputNumber min={0} precision={1} style={{ width: 160 }} />
          </Form.Item>
          <Form.Item
            name="endSec"
            label="结束秒"
            rules={[
              { required: true, message: '请输入结束时间' },
              ({ getFieldValue }) => ({
                validator: async (_rule, value: number) => {
                  if (value > getFieldValue('startSec')) return
                  throw new Error('结束时间必须大于起始时间')
                },
              }),
            ]}
          >
            <InputNumber min={0} precision={1} style={{ width: 160 }} />
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
        </Space>

        <Form.Item name="text" label="正文" rules={[{ required: true, message: '请输入片段正文' }]}>
          <Input.TextArea rows={6} maxLength={4000} showCount />
        </Form.Item>
      </Form>
    </Modal>
  )
}
