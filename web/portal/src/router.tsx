import { Spin } from 'antd'
import type { ReactElement } from 'react'
import { Navigate, Route, Routes, useLocation } from 'react-router-dom'
import { useAuth } from './auth/AuthProvider'
import { PortalLayout } from './layout/PortalLayout'
import { AccountPage } from './pages/AccountPage'
import { DownloadsPage } from './pages/DownloadsPage'
import { FaqPage } from './pages/FaqPage'
import { FeaturesPage } from './pages/FeaturesPage'
import { GuidePage } from './pages/GuidePage'
import { HomePage } from './pages/HomePage'
import { LegalPage } from './pages/LegalPage'
import { LoginPage } from './pages/LoginPage'
import { NotFoundPage } from './pages/NotFoundPage'
import { RegisterPage } from './pages/RegisterPage'
import { SystemPage } from './pages/SystemPage'

export function PageLoading({ text = '加载中…' }: { text?: string }) {
  return (
    <div className="portal-loading">
      <Spin size="large" />
      <span>{text}</span>
    </div>
  )
}

function RequirePortalAuth({ children }: { children: ReactElement }) {
  const { user, loading } = useAuth()
  const location = useLocation()
  if (loading) return <PageLoading text="正在检查登录状态…" />
  if (user === null) {
    const returnTo = `${location.pathname}${location.search}`
    return <Navigate to={`/login?returnTo=${encodeURIComponent(returnTo)}`} replace />
  }
  return children
}

export function PortalRoutes() {
  return (
    <Routes>
      <Route element={<PortalLayout />}>
        <Route index element={<HomePage />} />
        <Route path="system" element={<SystemPage />} />
        <Route path="features" element={<FeaturesPage />} />
        <Route path="guide" element={<GuidePage />} />
        <Route path="downloads" element={<DownloadsPage />} />
        <Route path="faq" element={<FaqPage />} />
        <Route path="login" element={<LoginPage />} />
        <Route path="register" element={<RegisterPage />} />
        <Route
          path="account"
          element={(
            <RequirePortalAuth>
              <AccountPage />
            </RequirePortalAuth>
          )}
        />
        <Route path="legal/privacy" element={<LegalPage kind="privacy" />} />
        <Route path="legal/terms" element={<LegalPage kind="terms" />} />
        <Route path="*" element={<NotFoundPage />} />
      </Route>
    </Routes>
  )
}
