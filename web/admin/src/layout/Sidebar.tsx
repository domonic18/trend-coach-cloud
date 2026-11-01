import {
  AppstoreOutlined,
  DashboardOutlined,
  FileTextOutlined,
  HistoryOutlined,
  LineChartOutlined,
  LogoutOutlined,
  MenuFoldOutlined,
  MenuUnfoldOutlined,
  ReadOutlined,
  RobotOutlined,
  TeamOutlined,
  VideoCameraOutlined,
} from '@ant-design/icons'
import { Avatar, Button, Menu, Tag, Tooltip, Typography } from 'antd'
import type { MenuProps } from 'antd'
import { useLocation, useNavigate } from 'react-router-dom'
import { useAuth } from '../auth/AuthProvider'
import { useTheme } from '../theme'

type MenuItem = Required<MenuProps>['items'][number]

const ROLE_LABELS: Record<string, string> = {
  admin: '管理员',
  operator: '运营',
  student: '学员',
}

function selectedKey(pathname: string): string {
  if (pathname === '/' || pathname === '') return '/'
  if (pathname.startsWith('/courses')) return '/courses'
  if (pathname.startsWith('/segments')) return '/segments'
  if (pathname.startsWith('/pipeline')) return '/pipeline'
  if (pathname.startsWith('/ai/usage')) return '/ai/usage'
  if (pathname.startsWith('/ai/runs')) return '/ai/runs'
  if (pathname.startsWith('/system/models')) return '/system/models'
  if (pathname.startsWith('/system/accounts')) return '/system/accounts'
  return '/'
}

export function Sidebar({
  collapsed = false,
  onNavigate,
  onToggleCollapse,
}: {
  collapsed?: boolean
  onNavigate?: () => void
  onToggleCollapse?: () => void
}) {
  const navigate = useNavigate()
  const location = useLocation()
  const { user, signOut } = useAuth()
  const { mode } = useTheme()
  const isAdmin = user?.role === 'admin'
  const isOps = isAdmin || user?.role === 'operator'

  const items: MenuItem[] = [
    { key: '/', icon: <DashboardOutlined />, label: '概览' },
    {
      type: 'group',
      label: collapsed ? undefined : '内容运营',
      children: [
        { key: '/courses', icon: <ReadOutlined />, label: '课程内容' },
        { key: '/segments', icon: <FileTextOutlined />, label: '片段管理' },
        { key: '/pipeline', icon: <VideoCameraOutlined />, label: '视频建课' },
      ],
    },
    ...(isOps
      ? [{
        type: 'group',
        label: collapsed ? undefined : 'AI 运营',
        children: [
          { key: '/ai/usage', icon: <LineChartOutlined />, label: 'AI 用量' },
          { key: '/ai/runs', icon: <HistoryOutlined />, label: 'AI 运行' },
        ],
      } satisfies MenuItem]
      : []),
    ...(isAdmin
      ? [{
        type: 'group',
        label: collapsed ? undefined : '系统',
        children: [
          { key: '/system/models', icon: <RobotOutlined />, label: '模型配置' },
          { key: '/system/accounts', icon: <TeamOutlined />, label: '账号管理' },
        ],
      } satisfies MenuItem]
      : []),
  ]

  return (
    <div className="sidebar">
      <button
        type="button"
        className="brand"
        onClick={() => {
          navigate('/')
          onNavigate?.()
        }}
      >
        <span className="brand-mark"><AppstoreOutlined /></span>
        {collapsed ? null : (
          <span className="brand-text">
            <strong>趋势交易</strong>
            <span>内容控制台</span>
          </span>
        )}
      </button>

      <Menu
        mode="inline"
        theme={mode}
        selectedKeys={[selectedKey(location.pathname)]}
        items={items}
        inlineCollapsed={collapsed}
        onClick={({ key }) => {
          navigate(key)
          onNavigate?.()
        }}
        className="sidebar-menu"
      />

      <div className="sidebar-footer">
        <Tooltip title={collapsed ? `${user?.displayName ?? user?.username ?? ''}（${ROLE_LABELS[user?.role ?? ''] ?? ''}）` : undefined} placement="right">
          <div className="sidebar-user">
            <Avatar size={32}>{(user?.displayName ?? user?.username ?? '?').slice(0, 1)}</Avatar>
            {collapsed ? null : (
              <div className="sidebar-user-text">
                <Typography.Text ellipsis>{user?.displayName ?? user?.username}</Typography.Text>
                <Tag bordered={false}>{ROLE_LABELS[user?.role ?? ''] ?? user?.role}</Tag>
              </div>
            )}
            {collapsed ? null : (
              <Tooltip title="退出登录">
                <Button
                  type="text"
                  size="small"
                  icon={<LogoutOutlined />}
                  onClick={() => void signOut()}
                />
              </Tooltip>
            )}
          </div>
        </Tooltip>
        {onToggleCollapse === undefined ? null : (
          <Tooltip title={collapsed ? '展开菜单' : undefined} placement="right">
            <Button
              type="text"
              block
              className="sidebar-collapse"
              icon={collapsed ? <MenuUnfoldOutlined /> : <MenuFoldOutlined />}
              onClick={onToggleCollapse}
            >
              {collapsed ? null : '收起菜单'}
            </Button>
          </Tooltip>
        )}
      </div>
    </div>
  )
}
