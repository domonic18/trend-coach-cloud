import {
  LockOutlined,
  LogoutOutlined,
  MenuOutlined,
  MoonOutlined,
  SunOutlined,
  UserOutlined,
} from '@ant-design/icons'
import { App, Avatar, Breadcrumb, Button, Dropdown, Form, Input, Modal, Segmented, Space, Tooltip } from 'antd'
import type { MenuProps } from 'antd'
import { useState } from 'react'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import { changePassword } from '../api'
import { useAuth } from '../auth/AuthProvider'
import { useTheme } from '../theme'

const PAGE_TITLES: Record<string, string> = {
  '/': '概览',
  '/courses': '课程内容',
  '/segments': '片段管理',
  '/pipeline': '视频建课',
  '/system/models': '模型配置',
  '/system/accounts': '账号管理',
}

function pageTitle(pathname: string): string {
  if (pathname.startsWith('/courses')) return '课程内容'
  return PAGE_TITLES[pathname] ?? '控制台'
}

export function AdminHeader({ onMenuClick }: { onMenuClick?: () => void }) {
  const location = useLocation()
  const navigate = useNavigate()
  const { user, signOut } = useAuth()
  const { mode, setMode } = useTheme()
  const { message, modal } = App.useApp()
  const [passwordOpen, setPasswordOpen] = useState(false)

  const menuItems: MenuProps['items'] = [
    {
      key: 'profile',
      type: 'group',
      label: (
        <div className="header-profile">
          <Avatar size="small" icon={<UserOutlined />} />
          <div>
            <div>{user?.displayName ?? user?.username}</div>
            <div className="header-profile-sub">{user?.username}</div>
          </div>
        </div>
      ),
    },
    { type: 'divider' },
    { key: 'password', icon: <LockOutlined />, label: '修改密码', onClick: () => setPasswordOpen(true) },
    {
      key: 'logout',
      icon: <LogoutOutlined />,
      label: '退出登录',
      danger: true,
      onClick: () => {
        modal.confirm({
          title: '退出登录？',
          content: '当前后台会话将立即失效。',
          okText: '退出',
          cancelText: '取消',
          onOk: async () => {
            await signOut()
            navigate('/login', { replace: true })
          },
        })
      },
    },
  ]

  return (
    <header className="admin-header">
      <div className="admin-header-left">
        <Button
          type="text"
          icon={<MenuOutlined />}
          className="mobile-menu-button"
          onClick={onMenuClick}
          aria-label="打开导航"
        />
        <Breadcrumb
          items={[
            { title: <Link to="/">控制台</Link> },
            { title: pageTitle(location.pathname) },
          ]}
        />
      </div>

      <Space size={8}>
        <Tooltip title="切换主题">
          <Segmented
            size="small"
            value={mode}
            onChange={value => setMode(value as 'dark' | 'light')}
            options={[
              { value: 'dark', icon: <MoonOutlined /> },
              { value: 'light', icon: <SunOutlined /> },
            ]}
          />
        </Tooltip>
        <Dropdown menu={{ items: menuItems }} placement="bottomRight" trigger={['click']}>
          <Button type="text" className="header-user">
            <Avatar size="small" icon={<UserOutlined />} />
            <span className="header-user-name">{user?.displayName ?? user?.username}</span>
          </Button>
        </Dropdown>
      </Space>

      <PasswordModal
        open={passwordOpen}
        onClose={() => setPasswordOpen(false)}
        onSaved={() => {
          setPasswordOpen(false)
          void message.success('密码已更新，其他会话已失效')
        }}
      />
    </header>
  )
}

function PasswordModal({
  open,
  onClose,
  onSaved,
}: {
  open: boolean
  onClose: () => void
  onSaved: () => void
}) {
  const [form] = Form.useForm<{ currentPassword: string; newPassword: string }>()
  const [busy, setBusy] = useState(false)
  const { message } = App.useApp()

  return (
    <Modal
      title="修改密码"
      open={open}
      onCancel={onClose}
      okText="保存"
      cancelText="取消"
      confirmLoading={busy}
      onOk={() => {
        void form.validateFields().then(async values => {
          setBusy(true)
          try {
            await changePassword(values.currentPassword, values.newPassword)
            form.resetFields()
            onSaved()
          } catch (cause) {
            void message.error(cause instanceof Error ? cause.message : '修改失败')
          } finally {
            setBusy(false)
          }
        })
      }}
      destroyOnHidden
    >
      <Form form={form} layout="vertical" autoComplete="off">
        <Form.Item
          name="currentPassword"
          label="当前密码"
          rules={[{ required: true, message: '请输入当前密码' }]}
        >
          <Input.Password autoComplete="current-password" />
        </Form.Item>
        <Form.Item
          name="newPassword"
          label="新密码"
          rules={[
            { required: true, message: '请输入新密码' },
            { min: 10, max: 128, message: '密码长度需为 10–128 位' },
          ]}
        >
          <Input.Password autoComplete="new-password" />
        </Form.Item>
      </Form>
    </Modal>
  )
}
