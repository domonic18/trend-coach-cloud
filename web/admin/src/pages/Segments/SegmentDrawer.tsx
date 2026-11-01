import { useMutation, useQueryClient } from '@tanstack/react-query'
import { App, Button, Drawer, Form, Input, InputNumber, Select, Space, Tag, Typography } from 'antd'
import { patchSegment } from '../../api'
import type { ContentStatus, Segment } from '../../types'

interface SegmentForm {
  title: string
  startSec: number
  endSec: number
  status: ContentStatus
  text: string
}

export function SegmentDrawer({
  segment,
  open,
  onClose,
}: {
  segment: Segment | null
  open: boolean
  onClose: () => void
}) {
  const queryClient = useQueryClient()
  const { message } = App.useApp()
  const [form] = Form.useForm<SegmentForm>()

  const save = useMutation({
    mutationFn: (values: SegmentForm) => patchSegment(segment?.segmentId ?? '', values),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['segments'] })
      void message.success('片段已保存')
      onClose()
    },
  })

  return (
    <Drawer
      open={open}
      onClose={onClose}
      width="min(720px, 94vw)"
      title="编辑片段"
      destroyOnHidden
      extra={
        <Space>
          {segment === null ? null : <Tag bordered={false}>{segment.segmentId}</Tag>}
          <Typography.Text type="secondary">
            {segment?.hasEmbedding === true ? '已向量化' : '未向量化'}
          </Typography.Text>
        </Space>
      }
    >
      <Form<SegmentForm>
        form={form}
        layout="vertical"
        preserve={false}
        initialValues={
          segment === null
            ? undefined
            : {
                title: segment.title,
                startSec: segment.startSec,
                endSec: segment.endSec,
                status: segment.status,
                text: segment.text,
              }
        }
        onFinish={values => save.mutate(values)}
      >
        <Form.Item name="title" label="标题" rules={[{ required: true, message: '请输入标题' }]}>
          <Input />
        </Form.Item>
        <Space size={12} wrap>
          <Form.Item
            name="startSec"
            label="起始秒"
            rules={[{ required: true, message: '请输入起始时间' }]}
          >
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
        <Form.Item
          name="text"
          label="正文"
          rules={[{ required: true, message: '请输入片段正文' }]}
        >
          <Input.TextArea rows={10} maxLength={4000} showCount />
        </Form.Item>
        <Space>
          <Typography.Text type="secondary">
            位置：{segment?.courseId} / {segment?.knowledgePointId}
          </Typography.Text>
        </Space>
        <div className="drawer-footer">
          <Space>
            <Button onClick={onClose}>取消</Button>
            <Button type="primary" htmlType="submit" loading={save.isPending}>保存</Button>
          </Space>
        </div>
      </Form>
    </Drawer>
  )
}
