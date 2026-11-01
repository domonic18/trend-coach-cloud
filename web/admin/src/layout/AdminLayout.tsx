import { Drawer, Grid, Layout } from 'antd'
import { Suspense, useState } from 'react'
import { Outlet } from 'react-router-dom'
import { AdminHeader } from './Header'
import { Sidebar } from './Sidebar'

const { Sider, Content } = Layout

export function AdminLayout() {
  const screens = Grid.useBreakpoint()
  const isMobile = !screens.lg
  const [collapsed, setCollapsed] = useState(false)
  const [drawerOpen, setDrawerOpen] = useState(false)

  return (
    <Layout className="admin-shell">
      {isMobile ? (
        <Drawer
          placement="left"
          width={248}
          open={drawerOpen}
          onClose={() => setDrawerOpen(false)}
          closable={false}
          styles={{ body: { padding: 0 } }}
        >
          <Sidebar onNavigate={() => setDrawerOpen(false)} />
        </Drawer>
      ) : (
        <Sider
          width={248}
          collapsedWidth={76}
          collapsed={collapsed}
          trigger={null}
          className="admin-sider"
          theme="light"
        >
          <Sidebar collapsed={collapsed} onToggleCollapse={() => setCollapsed(value => !value)} />
        </Sider>
      )}

      <Layout>
        <AdminHeader onMenuClick={() => setDrawerOpen(true)} />
        <Content className="admin-content">
          <Suspense fallback={<div className="page-loading">加载中…</div>}>
            <Outlet />
          </Suspense>
        </Content>
      </Layout>
    </Layout>
  )
}
