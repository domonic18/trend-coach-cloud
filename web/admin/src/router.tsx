import { Spin } from 'antd'
import { lazy, Suspense, type ReactElement } from 'react'
import { createBrowserRouter, Navigate, useLocation } from 'react-router-dom'
import { useAuth } from './auth/AuthProvider'
import { AdminLayout } from './layout/AdminLayout'

const OverviewPage = lazy(() => import('./pages/Overview/OverviewPage').then(m => ({ default: m.OverviewPage })))
const ContentPage = lazy(() => import('./pages/Content/ContentPage').then(m => ({ default: m.ContentPage })))
const SegmentsPage = lazy(() => import('./pages/Segments/SegmentsPage').then(m => ({ default: m.SegmentsPage })))
const PipelinePage = lazy(() => import('./pages/Pipeline/PipelinePage').then(m => ({ default: m.PipelinePage })))
const ModelsPage = lazy(() => import('./pages/Models/ModelsPage').then(m => ({ default: m.ModelsPage })))
const AccountsPage = lazy(() => import('./pages/Accounts/AccountsPage').then(m => ({ default: m.AccountsPage })))
const AiUsagePage = lazy(() => import('./pages/AI/UsagePage').then(m => ({ default: m.UsagePage })))
const AiRunsPage = lazy(() => import('./pages/AI/RunsPage').then(m => ({ default: m.RunsPage })))
const LoginPage = lazy(() => import('./pages/Login/LoginPage').then(m => ({ default: m.LoginPage })))

function FullScreenLoading() {
  return (
    <div className="full-loading">
      <Spin size="large" />
    </div>
  )
}

function RequireAuth({ children }: { children: ReactElement }) {
  const { user, loading } = useAuth()
  const location = useLocation()
  if (loading) return <FullScreenLoading />
  if (user === null) {
    return <Navigate to="/login" replace state={{ returnTo: location.pathname + location.search }} />
  }
  return children
}

function RequireOps({ children }: { children: ReactElement }) {
  const { user, loading } = useAuth()
  const location = useLocation()
  if (loading) return <FullScreenLoading />
  if (user === null) {
    return <Navigate to="/login" replace state={{ returnTo: location.pathname + location.search }} />
  }
  if (user.role !== 'admin' && user.role !== 'operator') {
    return (
      <div className="page-forbidden">
        <h2>无权访问</h2>
        <p>该页面仅运营与管理员可见。</p>
      </div>
    )
  }
  return children
}

function RequireAdmin({ children }: { children: ReactElement }) {
  const { user, loading } = useAuth()
  const location = useLocation()
  if (loading) return <FullScreenLoading />
  if (user === null) {
    return <Navigate to="/login" replace state={{ returnTo: location.pathname + location.search }} />
  }
  if (user.role !== 'admin') {
    return (
      <div className="page-forbidden">
        <h2>无权访问</h2>
        <p>该页面仅管理员可见。</p>
      </div>
    )
  }
  return children
}

export const router = createBrowserRouter([
  {
    path: '/',
    element: (
      <RequireAuth>
        <AdminLayout />
      </RequireAuth>
    ),
    children: [
      { index: true, element: <OverviewPage /> },
      { path: 'courses', element: <ContentPage /> },
      { path: 'courses/:courseId', element: <ContentPage /> },
      { path: 'segments', element: <SegmentsPage /> },
      { path: 'pipeline', element: <PipelinePage /> },
      {
        path: 'ai/usage',
        element: <RequireOps><AiUsagePage /></RequireOps>,
      },
      {
        path: 'ai/runs',
        element: <RequireOps><AiRunsPage /></RequireOps>,
      },
      {
        path: 'system/models',
        element: <RequireAdmin><ModelsPage /></RequireAdmin>,
      },
      {
        path: 'system/accounts',
        element: <RequireAdmin><AccountsPage /></RequireAdmin>,
      },
    ],
  },
  {
    path: '/login',
    element: (
      <Suspense fallback={<FullScreenLoading />}>
        <LoginPage />
      </Suspense>
    ),
  },
  { path: '*', element: <Navigate to="/" replace /> },
], { basename: '/admin' })
