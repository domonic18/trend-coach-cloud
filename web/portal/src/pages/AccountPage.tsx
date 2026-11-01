import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  App as AntApp,
  Button,
  Card,
  Descriptions,
  Form,
  Input,
  Popconfirm,
  Table,
  Tag,
  Typography,
} from 'antd'
import type { ColumnsType } from 'antd/es/table'
import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { changePassword, getProfile, listDevices, revokeDevice, updateDisplayName } from '../api'
import { useAuth } from '../auth/AuthProvider'
import { PageHero } from '../components/PageHero'
import { formatDateTime, errorMessage } from '../lib/format'
import type { PortalDevice } from '../types'
import { usePageMeta } from '../usePageMeta'

const ROLE_LABEL: Record<string, string> = {
  student: '学员',
  operator: '运营',
  admin: '管理员',
}

export function AccountPage() {
  usePageMeta('/account')
  const { message } = AntApp.useApp()
  const { user, signIn, signOut } = useAuth()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const [busy, setBusy] = useState(false)

  const profile = useQuery({ queryKey: ['portal', 'profile'], queryFn: getProfile })
  const devices = useQuery({ queryKey: ['portal', 'devices'], queryFn: listDevices })

  const saveProfile = useMutation({
    mutationFn: updateDisplayName,
    onSuccess: updated => {
      message.success('昵称已更新')
      if (user !== null) {
        signIn({
          userId: user.userId,
          username: user.username,
          displayName: updated.displayName,
          role: user.role,
        })
      }
      void queryClient.invalidateQueries({ queryKey: ['portal', 'profile'] })
    },
    onError: error => message.error(errorMessage(error)),
  })

  const change = useMutation({
    mutationFn: (input: { currentPassword: string; newPassword: string }) =>
      changePassword(input.currentPassword, input.newPassword),
    onSuccess: async () => {
      message.success('密码已修改，请使用新密码重新登录')
      await signOut().catch(() => undefined)
      navigate('/login?changed=1', { replace: true })
    },
    onError: error => message.error(errorMessage(error)),
  })

  const revoke = useMutation({
    mutationFn: revokeDevice,
    onSuccess: () => {
      message.success('设备已解绑')
      void queryClient.invalidateQueries({ queryKey: ['portal', 'devices'] })
      void queryClient.invalidateQueries({ queryKey: ['portal', 'profile'] })
    },
    onError: error => message.error(errorMessage(error)),
  })

  const columns: ColumnsType<PortalDevice> = [
    {
      title: '设备 ID',
      dataIndex: 'deviceId',
      render: (value: string) => <Typography.Text code>{value}</Typography.Text>,
    },
    {
      title: '状态',
      dataIndex: 'status',
      render: (value: PortalDevice['status']) =>
        value === 'active' ? <Tag color="green">已授权</Tag> : <Tag>已解绑</Tag>,
      width: 100,
    },
    {
      title: '首次授权',
      dataIndex: 'firstAuthorizedAt',
      render: (value: number) => formatDateTime(value),
      responsive: ['md'],
    },
    {
      title: '最近活跃',
      dataIndex: 'lastSeenAt',
      render: (value: number) => formatDateTime(value),
      responsive: ['md'],
    },
    {
      title: '操作',
      key: 'action',
      width: 100,
      render: (_, record) => record.status === 'active'
        ? (
          <Popconfirm
            title="解绑该设备？"
            description="解绑后需要重新完成设备码授权才能继续使用。"
            okText="确认解绑"
            cancelText="取消"
            onConfirm={() => revoke.mutate(record.deviceId)}
          >
            <Button type="link" danger>解绑</Button>
          </Popconfirm>
        )
        : <Typography.Text type="secondary">—</Typography.Text>,
    },
  ]

  const onLogout = async (): Promise<void> => {
    setBusy(true)
    try {
      await signOut()
      message.success('已退出登录')
      navigate('/')
    } catch {
      message.error('退出失败，请稍后重试')
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <PageHero
        kicker="个人中心"
        title={profile.data === undefined ? '我的账号' : (profile.data.displayName ?? profile.data.username)}
        description="管理昵称与密码，查看已授权的 dsh 设备。密码修改后所有会话都会失效，需要重新登录。"
      />

      <section className="content-section">
        <div className="account-grid">
          <Card title="基本资料" loading={profile.isPending}>
            {profile.data !== undefined && (
              <>
                <Descriptions column={1} size="small">
                  <Descriptions.Item label="用户名">{profile.data.username}</Descriptions.Item>
                  <Descriptions.Item label="账号角色">
                    {ROLE_LABEL[profile.data.role] ?? profile.data.role}
                  </Descriptions.Item>
                  <Descriptions.Item label="注册时间">
                    {formatDateTime(profile.data.createdAt)}
                  </Descriptions.Item>
                  <Descriptions.Item label="已授权设备">
                    {profile.data.deviceCount} 台
                  </Descriptions.Item>
                </Descriptions>
                <Form
                  layout="vertical"
                  key={profile.data.displayName ?? 'empty'}
                  initialValues={{ displayName: profile.data.displayName ?? '' }}
                  onFinish={values => saveProfile.mutate(values.displayName.trim())}
                  className="account-form"
                >
                  <Form.Item
                    label="昵称"
                    name="displayName"
                    rules={[{ required: true, message: '请输入昵称' }]}
                  >
                    <Input maxLength={200} placeholder="展示在个人中心里的名字" />
                  </Form.Item>
                  <Button type="primary" htmlType="submit" loading={saveProfile.isPending}>
                    保存昵称
                  </Button>
                </Form>
              </>
            )}
          </Card>

          <Card title="修改密码">
            <Form
              layout="vertical"
              onFinish={values => change.mutate({
                currentPassword: values.currentPassword,
                newPassword: values.newPassword,
              })}
              className="account-form"
            >
              <Form.Item
                label="当前密码"
                name="currentPassword"
                rules={[{ required: true, message: '请输入当前密码' }]}
              >
                <Input.Password autoComplete="current-password" />
              </Form.Item>
              <Form.Item
                label="新密码"
                name="newPassword"
                extra="至少 10 个字符"
                rules={[
                  { required: true, message: '请输入新密码' },
                  { min: 10, message: '密码至少 10 个字符' },
                  { max: 128, message: '密码最多 128 个字符' },
                ]}
              >
                <Input.Password autoComplete="new-password" />
              </Form.Item>
              <Form.Item
                label="确认新密码"
                name="confirm"
                dependencies={['newPassword']}
                rules={[
                  { required: true, message: '请再次输入新密码' },
                  ({ getFieldValue }) => ({
                    validator(_rule, value: string) {
                      return value === getFieldValue('newPassword')
                        ? Promise.resolve()
                        : Promise.reject(new Error('两次输入的密码不一致'))
                    },
                  }),
                ]}
              >
                <Input.Password autoComplete="new-password" />
              </Form.Item>
              <Button type="primary" htmlType="submit" loading={change.isPending}>
                修改密码
              </Button>
            </Form>
          </Card>

          <Card
            title="我的设备"
            className="account-devices"
            extra={(
              <Typography.Text type="secondary">
                解绑后该设备需要重新授权
              </Typography.Text>
            )}
          >
            <Table<PortalDevice>
              rowKey="deviceId"
              size="middle"
              columns={columns}
              dataSource={devices.data ?? []}
              loading={devices.isPending}
              pagination={false}
              locale={{ emptyText: '还没有授权过设备' }}
              scroll={{ x: 640 }}
            />
            <div className="account-actions">
              <Button onClick={() => void onLogout()} loading={busy}>退出登录</Button>
            </div>
          </Card>
        </div>
      </section>
    </>
  )
}
