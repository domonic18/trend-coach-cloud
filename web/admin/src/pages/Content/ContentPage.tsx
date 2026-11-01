import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { App, Card, Empty, Form, Input, Modal, Select } from 'antd'
import { useState } from 'react'
import { useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { createCourse, listCourses } from '../../api'
import { PageHeader } from '../../components/PageHeader'
import { qk } from '../../lib/queryKeys'
import type { ContentStatus } from '../../types'
import { CourseList } from './CourseList'
import { CourseEditor } from './TreeEditor'

interface CreateCourseForm {
  courseId: string
  title: string
  status: ContentStatus
}

export function ContentPage() {
  const { courseId } = useParams<{ courseId: string }>()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const { message } = App.useApp()
  const [searchParams, setSearchParams] = useSearchParams()
  const [createOpen, setCreateOpen] = useState(searchParams.get('create') === '1')
  const [form] = Form.useForm<CreateCourseForm>()
  const courses = useQuery({ queryKey: qk.courses, queryFn: listCourses })

  const closeCreate = (): void => {
    setCreateOpen(false)
    if (searchParams.has('create')) {
      const next = new URLSearchParams(searchParams)
      next.delete('create')
      setSearchParams(next, { replace: true })
    }
  }

  const create = useMutation({
    mutationFn: (values: CreateCourseForm) => createCourse(values),
    onSuccess: async course => {
      await queryClient.invalidateQueries({ queryKey: qk.courses })
      closeCreate()
      form.resetFields()
      void message.success('课程已创建')
      navigate(`/courses/${course.courseId}`)
    },
  })

  return (
    <>
      <PageHeader title="课程内容" subtitle="维护课程结构、知识点文章与发布状态；发布时自动重建检索索引。" />

      <div className="content-layout">
        <CourseList
          courses={courses.data ?? []}
          loading={courses.isLoading}
          selectedId={courseId}
          onSelect={id => navigate(`/courses/${id}`)}
          onCreate={() => setCreateOpen(true)}
        />

        <div className="content-detail">
          {courseId === undefined ? (
            <Card><Empty description="从左侧选择课程，或新建一门课程。" /></Card>
          ) : (
            <CourseEditor key={courseId} courseId={courseId} />
          )}
        </div>
      </div>

      <Modal
        open={createOpen}
        title="新建课程"
        okText="创建"
        cancelText="取消"
        confirmLoading={create.isPending}
        onCancel={closeCreate}
        onOk={() => {
          void form.validateFields().then(values => create.mutate(values))
        }}
        destroyOnHidden
      >
        <Form<CreateCourseForm>
          form={form}
          layout="vertical"
          preserve={false}
          initialValues={{ status: 'draft' }}
        >
          <Form.Item
            name="courseId"
            label="课程 ID"
            rules={[
              { required: true, message: '请输入课程 ID' },
              { pattern: /^[A-Za-z0-9._-]{1,64}$/, message: '仅支持字母、数字、点、下划线与连字符，最长 64 位' },
            ]}
          >
            <Input placeholder="例如 TC-101" />
          </Form.Item>
          <Form.Item name="title" label="标题" rules={[{ required: true, message: '请输入课程标题' }]}>
            <Input />
          </Form.Item>
          <Form.Item name="status" label="初始状态">
            <Select
              options={[
                { value: 'draft', label: '草稿' },
                { value: 'published', label: '已发布' },
                { value: 'archived', label: '已归档' },
              ]}
            />
          </Form.Item>
        </Form>
      </Modal>
    </>
  )
}
