import { KeyOutlined, PlusOutlined, ReloadOutlined, SearchOutlined } from '@ant-design/icons'
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
  Table,
  Tag,
  Typography,
} from 'antd'
import type { ColumnsType } from 'antd/es/table'
import { useState } from 'react'
import { createUser, listUsers, patchUser, resetUser } from '../../api'
import { PageHeader } from '../../components/PageHeader'
import { formatDateTime } from '../../lib/format'
import { qk } from '../../lib/queryKeys'
import type { UserFilters } from '../../lib/queryKeys'
import type { User, UserRole, UserStatus } from '../../types'

const ROLE_OPTIONS: { value: UserRole; label: string }[] = [
  { value: 'student', label: '学员' },
  { value: 'operator', label: '运营' },
  { value: 'admin', label: '管理员' },
]

interface CreateUserValues {
  username: string
  displayName: string
  role: UserRole
  password?: string
}

export function AccountsPage() {
  const queryClient = useQueryClient()
  const { message, modal } = App.useApp()
  const [keywordInput, setKeywordInput] = useState('')
  const [query, setQuery] = useState('')
  const [role, setRole] = useState<'' | UserRole>('')
  const [status, setStatus] = useState<'' | UserStatus>('')
  const [offset, setOffset] = useState(0)
  const [limit, setLimit] = useState(20)
  const [creating, setCreating] = useState(false)
  const [resetting, setResetting] = useState<User | null>(null)

  const filters: UserFilters = { query, role, status, offset, limit }
  const users = useQuery({
    queryKey: qk.users(filters),
    queryFn: () => listUsers({
      query: query === '' ? undefined : query,
      role: role === '' ? undefined : role,
      status: status === '' ? undefined : status,
      offset,
      limit,
    }),
  })

  const refresh = (): Promise<unknown> => queryClient.invalidateQueries({ queryKey: ['accounts'] })

  const showInvite = (code: string, expiresAt: number | undefined): void => {
    modal.success({
      title: '邀请码已生成',
      content: (
        <Space direction="vertical" size={8}>
          <Typography.Paragraph copyable={{ text: code }} style={{ margin: 0 }}>{code}</Typography.Paragraph>
          <Typography.Text type="secondary">
            一次性使用{expiresAt === undefined ? '' : `，有效期至 ${formatDateTime(expiresAt)}`}。请通过安全渠道发给对方。
          </Typography.Text>
        </Space>
      ),
    })
  }

  const create = useMutation({
    mutationFn: (values: CreateUserValues) => createUser({
      username: values.username,
      displayName: values.displayName,
      role: values.role,
      ...(values.password === undefined || values.password === '' ? {} : { password: values.password }),
    }),
    onSuccess: async result => {
      await refresh()
      setCreating(false)
      if (result.inviteCode === undefined) void message.success('账号已创建')
      else showInvite(result.inviteCode, result.inviteExpiresAt)
    },
  })

  const patch = useMutation({
    mutationFn: ({ userId, input }: { userId: string; input: { role?: UserRole; status?: UserStatus } }) =>
      patchUser(userId, input),
    onSuccess: async () => {
      await refresh()
      void message.success('账号已更新')
    },
  })

  const reset = useMutation({
    mutationFn: ({ userId, password }: { userId: string; password?: string }) =>
      resetUser(userId, password),
    onSuccess: async result => {
      await refresh()
      setResetting(null)
      if (result.inviteCode === undefined) void message.success('密码已重置')
      else showInvite(result.inviteCode, result.inviteExpiresAt)
    },
  })

  const resetFilters = (): void => {
    setKeywordInput('')
    setQuery('')
    setRole('')
    setStatus('')
    setOffset(0)
  }

  const columns: ColumnsType<User> = [
    {
      title: '账号',
      key: 'user',
      render: (_value, user) => (
        <div className="segment-cell">
          <Typography.Text strong>{user.displayName ?? user.username ?? user.userId}</Typography.Text>
          <Typography.Text type="secondary">{user.username ?? user.userId}</Typography.Text>
        </div>
      ),
    },
    {
      title: '角色',
      dataIndex: 'role',
      width: 140,
      render: (value: UserRole, user) => (
        <Select<UserRole>
          size="small"
          value={value}
          style={{ width: 110 }}
          loading={patch.isPending && patch.variables?.userId === user.userId}
          onChange={next => {
            if (next === value) return
            patch.mutate({ userId: user.userId, input: { role: next } })
          }}
          options={ROLE_OPTIONS}
        />
      ),
    },
    {
      title: '状态',
      dataIndex: 'status',
      width: 120,
      render: (value: UserStatus, user) => (
        <Select<UserStatus>
          size="small"
          value={value}
          style={{ width: 96 }}
          loading={patch.isPending && patch.variables?.userId === user.userId}
          onChange={next => {
            if (next === value) return
            patch.mutate({ userId: user.userId, input: { status: next } })
          }}
          options={[
            { value: 'active', label: '正常' },
            { value: 'disabled', label: '停用' },
          ]}
        />
      ),
    },
    {
      title: '设备',
      dataIndex: 'deviceCount',
      width: 80,
      render: (value: number) => value === 0 ? <Tag>无</Tag> : <Tag color="blue">{value}</Tag>,
    },
    {
      title: '创建时间',
      dataIndex: 'createdAt',
      width: 160,
      render: (value: number) => formatDateTime(value),
    },
    {
      title: '最近活跃',
      dataIndex: 'lastActiveAt',
      width: 160,
      render: (value: number | null) => formatDateTime(value),
    },
    {
      title: '操作',
      key: 'actions',
      width: 130,
      render: (_value, user) => (
        <Button size="small" icon={<KeyOutlined />} onClick={() => setResetting(user)}>
          重置凭据
        </Button>
      ),
    },
  ]

  return (
    <>
      <PageHeader
        title="账号管理"
        subtitle="管理后台与学员账号；重置密码会撤销该账号的全部会话。"
        extra={<Button type="primary" icon={<PlusOutlined />} onClick={() => setCreating(true)}>新建账号</Button>}
      />

      <Card className="filter-card">
        <Space size={12} wrap>
          <Input.Search
            allowClear
            prefix={<SearchOutlined />}
            placeholder="搜索用户名或显示名"
            style={{ width: 260 }}
            value={keywordInput}
            onChange={event => setKeywordInput(event.target.value)}
            onSearch={value => {
              setQuery(value.trim())
              setOffset(0)
            }}
          />
          <Select
            allowClear
            placeholder="全部角色"
            style={{ width: 130 }}
            value={role === '' ? undefined : role}
            onChange={value => {
              setRole((value ?? '') as '' | UserRole)
              setOffset(0)
            }}
            options={ROLE_OPTIONS}
          />
          <Select
            allowClear
            placeholder="全部状态"
            style={{ width: 130 }}
            value={status === '' ? undefined : status}
            onChange={value => {
              setStatus((value ?? '') as '' | UserStatus)
              setOffset(0)
            }}
            options={[
              { value: 'active', label: '正常' },
              { value: 'disabled', label: '已停用' },
            ]}
          />
          <Button icon={<ReloadOutlined />} onClick={resetFilters}>重置</Button>
        </Space>
      </Card>

      <Card>
        <Table<User>
          rowKey="userId"
          loading={users.isLoading}
          columns={columns}
          dataSource={users.data?.users ?? []}
          scroll={{ x: 1000 }}
          pagination={{
            current: Math.floor(offset / limit) + 1,
            pageSize: limit,
            total: users.data?.total ?? 0,
            showSizeChanger: true,
            showTotal: total => `共 ${total} 个账号`,
            onChange: (page, size) => {
              setOffset((page - 1) * size)
              setLimit(size)
            },
          }}
          locale={{ emptyText: '没有符合条件的账号' }}
        />
      </Card>

      <CreateUserModal
        open={creating}
        submitting={create.isPending}
        onCancel={() => setCreating(false)}
        onSubmit={values => create.mutate(values)}
      />

      <ResetUserModal
        user={resetting}
        submitting={reset.isPending}
        onCancel={() => setResetting(null)}
        onSubmit={password => {
          if (resetting === null) return
          reset.mutate({ userId: resetting.userId, password })
        }}
      />
    </>
  )
}

function CreateUserModal({
  open,
  submitting,
  onCancel,
  onSubmit,
}: {
  open: boolean
  submitting: boolean
  onCancel: () => void
  onSubmit: (values: CreateUserValues) => void
}) {
  const [form] = Form.useForm<CreateUserValues>()
  return (
    <Modal
      open={open}
      title="新建账号"
      okText="创建"
      cancelText="取消"
      confirmLoading={submitting}
      onCancel={onCancel}
      onOk={() => {
        void form.validateFields().then(values => onSubmit(values))
      }}
      destroyOnHidden
    >
      <Form<CreateUserValues>
        form={form}
        layout="vertical"
        preserve={false}
        initialValues={{ role: 'operator' }}
      >
        <Form.Item
          name="username"
          label="用户名"
          rules={[
            { required: true, message: '请输入用户名' },
            { pattern: /^[a-z][a-z0-9._-]{2,31}$/, message: '以小写字母开头，3–32 位小写字母、数字、点、下划线与连字符' },
          ]}
        >
          <Input autoComplete="off" />
        </Form.Item>
        <Form.Item name="displayName" label="显示名" rules={[{ required: true, message: '请输入显示名' }]}>
          <Input />
        </Form.Item>
        <Form.Item name="role" label="角色">
          <Select options={ROLE_OPTIONS} />
        </Form.Item>
        <Form.Item
          name="password"
          label="初始密码"
          extra="留空则生成一次性邀请码，由对方自行设置密码。"
          rules={[{
            validator: async (_rule, value?: string) => {
              if (value === undefined || value === '') return
              if (value.length < 10 || value.length > 128) throw new Error('密码长度需为 10–128 位')
            },
          }]}
        >
          <Input.Password autoComplete="new-password" />
        </Form.Item>
      </Form>
    </Modal>
  )
}

function ResetUserModal({
  user,
  submitting,
  onCancel,
  onSubmit,
}: {
  user: User | null
  submitting: boolean
  onCancel: () => void
  onSubmit: (password: string | undefined) => void
}) {
  const [form] = Form.useForm<{ password?: string }>()
  return (
    <Modal
      open={user !== null}
      title={`重置凭据 · ${user?.displayName ?? user?.username ?? ''}`}
      okText="重置"
      cancelText="取消"
      confirmLoading={submitting}
      onCancel={onCancel}
      onOk={() => {
        void form.validateFields().then(values => {
          const password = values.password?.trim() ?? ''
          onSubmit(password === '' ? undefined : password)
        })
      }}
      destroyOnHidden
    >
      <Form<{ password?: string }> form={form} layout="vertical" preserve={false}>
        <Form.Item
          name="password"
          label="新密码"
          extra="留空则生成一次性邀请码；重置会使该账号现有会话立即失效。"
          rules={[{
            validator: async (_rule, value?: string) => {
              if (value === undefined || value === '') return
              if (value.length < 10 || value.length > 128) throw new Error('密码长度需为 10–128 位')
            },
          }]}
        >
          <Input.Password autoComplete="new-password" />
        </Form.Item>
      </Form>
    </Modal>
  )
}
