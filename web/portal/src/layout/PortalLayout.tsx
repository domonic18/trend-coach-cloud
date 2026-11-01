import { DownOutlined, MenuOutlined } from '@ant-design/icons'
import { Button, Dropdown, Space, type MenuProps } from 'antd'
import { useState } from 'react'
import { NavLink, Outlet, useNavigate } from 'react-router-dom'
import { useAuth } from '../auth/AuthProvider'

const NAV = [
  { to: '/system', label: '交易体系' },
  { to: '/features', label: '站点功能' },
  { to: '/guide', label: '使用向导' },
  { to: '/downloads', label: '版本下载' },
  { to: '/faq', label: '常见问题' },
]

function PortalHeader() {
  const { user, loading, signOut } = useAuth()
  const navigate = useNavigate()
  const [mobileOpen, setMobileOpen] = useState(false)

  const menuItems: MenuProps['items'] = [
    { key: 'account', label: '个人中心' },
    { type: 'divider' },
    { key: 'logout', label: '退出登录', danger: true },
  ]

  const onMenuClick: MenuProps['onClick'] = ({ key }) => {
    if (key === 'account') navigate('/account')
    if (key === 'logout') {
      void signOut().then(() => navigate('/'))
    }
  }

  return (
    <header className="portal-header">
      <div className="portal-header-inner">
        <NavLink to="/" className="portal-brand" onClick={() => setMobileOpen(false)}>
          <span className="portal-brand-mark">趋</span>
          <span className="portal-brand-text">
            <strong>趋势交易课程伴学</strong>
            <small>本地客户端 · 云端知识库</small>
          </span>
        </NavLink>

        <nav className={mobileOpen ? 'portal-nav is-open' : 'portal-nav'}>
          {NAV.map(item => (
            <NavLink
              key={item.to}
              to={item.to}
              className={({ isActive }) => (isActive ? 'portal-nav-link is-active' : 'portal-nav-link')}
              onClick={() => setMobileOpen(false)}
            >
              {item.label}
            </NavLink>
          ))}
        </nav>

        <div className="portal-header-actions">
          {loading ? (
            <span className="portal-auth-placeholder">登录 / 注册</span>
          ) : user === null ? (
            <Space size={8}>
              <Button type="text" onClick={() => navigate('/login')}>登录</Button>
              <Button type="primary" onClick={() => navigate('/register')}>注册</Button>
            </Space>
          ) : (
            <Dropdown menu={{ items: menuItems, onClick: onMenuClick }} placement="bottomRight">
              <Button type="text" className="portal-user-button">
                <span className="portal-user-avatar">
                  {(user.displayName ?? user.username).slice(0, 1).toUpperCase()}
                </span>
                <span className="portal-user-name">{user.displayName ?? user.username}</span>
                <DownOutlined />
              </Button>
            </Dropdown>
          )}
          <Button
            type="text"
            className="portal-menu-toggle"
            icon={<MenuOutlined />}
            aria-label="打开导航"
            onClick={() => setMobileOpen(value => !value)}
          />
        </div>
      </div>
    </header>
  )
}

function PortalFooter() {
  return (
    <footer className="portal-footer">
      <div className="portal-footer-inner">
        <div className="portal-footer-brand">
          <strong>趋势交易课程伴学</strong>
          <p>课程知识服务在云端，推理与密钥留在你的本地 dsh 客户端。</p>
        </div>
        <div className="portal-footer-links">
          <div>
            <span>了解</span>
            <NavLink to="/system">交易体系</NavLink>
            <NavLink to="/features">站点功能</NavLink>
            <NavLink to="/faq">常见问题</NavLink>
          </div>
          <div>
            <span>开始</span>
            <NavLink to="/guide">安装向导</NavLink>
            <NavLink to="/downloads">版本下载</NavLink>
            <NavLink to="/register">创建账号</NavLink>
          </div>
          <div>
            <span>条款</span>
            <NavLink to="/legal/terms">用户协议</NavLink>
            <NavLink to="/legal/privacy">隐私说明</NavLink>
          </div>
        </div>
      </div>
      <div className="portal-footer-bottom">
        <span>© 趋势交易课程伴学</span>
        <span>本站内容仅用于教学，不构成任何投资建议。市场有风险，决策需独立判断。</span>
      </div>
    </footer>
  )
}

export function PortalLayout() {
  return (
    <div className="portal-shell">
      <PortalHeader />
      <main className="portal-main">
        <Outlet />
      </main>
      <PortalFooter />
    </div>
  )
}
