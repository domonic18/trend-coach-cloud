import { PlusOutlined, SearchOutlined } from '@ant-design/icons'
import { Button, Card, Empty, Input, List, Select, Space, Tag, Typography } from 'antd'
import { useMemo, useState } from 'react'
import { StatusTag } from '../../components/StatusTag'
import type { ContentStatus, CourseSummary } from '../../types'

export function CourseList({
  courses,
  loading,
  selectedId,
  onSelect,
  onCreate,
}: {
  courses: CourseSummary[]
  loading: boolean
  selectedId: string | undefined
  onSelect: (courseId: string) => void
  onCreate: () => void
}) {
  const [keyword, setKeyword] = useState('')
  const [status, setStatus] = useState<'' | ContentStatus>('')

  const filtered = useMemo(() => {
    const needle = keyword.trim().toLowerCase()
    return courses.filter(course => {
      if (status !== '' && course.status !== status) return false
      if (needle === '') return true
      return course.courseId.toLowerCase().includes(needle) || course.title.toLowerCase().includes(needle)
    })
  }, [courses, keyword, status])

  return (
    <Card
      className="course-list-card"
      title="课程"
      extra={<Button type="primary" size="small" icon={<PlusOutlined />} onClick={onCreate}>新建</Button>}
      loading={loading}
    >
      <Space direction="vertical" size={12} className="course-list-filters">
        <Input
          allowClear
          prefix={<SearchOutlined />}
          placeholder="搜索课程 ID 或标题"
          value={keyword}
          onChange={event => setKeyword(event.target.value)}
        />
        <Select
          allowClear
          placeholder="全部状态"
          value={status === '' ? undefined : status}
          onChange={value => setStatus((value ?? '') as '' | ContentStatus)}
          options={[
            { value: 'draft', label: '草稿' },
            { value: 'published', label: '已发布' },
            { value: 'archived', label: '已归档' },
          ]}
        />
      </Space>

      <List
        className="course-list"
        dataSource={filtered}
        locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无课程" /> }}
        renderItem={course => (
          <List.Item
            className={course.courseId === selectedId ? 'course-list-item is-selected' : 'course-list-item'}
            onClick={() => onSelect(course.courseId)}
          >
            <div className="course-list-item-body">
              <div className="course-list-item-title">
                <Typography.Text strong ellipsis>{course.title}</Typography.Text>
                <StatusTag value={course.status} />
              </div>
              <div className="course-list-item-meta">
                <Tag bordered={false}>{course.courseId}</Tag>
                <span>{course.chapterCount} 章 · {course.knowledgePointCount} 知识点</span>
                <span>{course.segmentCount} 片段</span>
              </div>
            </div>
          </List.Item>
        )}
      />
    </Card>
  )
}
