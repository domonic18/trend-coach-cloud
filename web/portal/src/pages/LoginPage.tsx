import { App as AntApp, Button, Card, Form, Input, Typography } from 'antd'
import { useState } from 'react'
import { Link, Navigate, useNavigate, useSearchParams } from 'react-router-dom'
import { login } from '../api'
import { useAuth } from '../auth/AuthProvider'
import { PageHero } from '../components/PageHero'
import { authErrorMessage } from '../lib/auth-errors'
import { usePageMeta } from '../usePageMeta'

interface LoginValues {
  username: string
  password: string
}

function safeReturnTo(value: string | null): string {
  if (value === null || !value.startsWith('/') || value.startsWith('//')) return '/account'
  return value
}

export function LoginPage() {
  usePageMeta('/login')
  const { message } = AntApp.useApp()
  const { user, loading, signIn } = useAuth()
  const navigate = useNavigate()
  const [params] = useSearchParams()
  const [busy, setBusy] = useState(false)

  if (!loading && user !== null) return <Navigate to="/account" replace />

  const onFinish = async (values: LoginValues): Promise<void> => {
    setBusy(true)
    try {
      const session = await login(values.username.trim(), values.password)
      signIn(session.user)
      message.success('登录成功')
      navigate(safeReturnTo(params.get('returnTo')), { replace: true })
    } catch (error) {
      message.error(authErrorMessage(error))
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <PageHero
        kicker="登录"
        title="继续你的学习"
        description="登录后可管理昵称、密码与已授权设备。插件仍使用设备码授权，不会保存你的密码。"
      />
      <section className="content-section content-section-narrow">
        <Card className="auth-card">
          <Form<LoginValues> layout="vertical" onFinish={onFinish} requiredMark={false}>
            <Form.Item
              label="用户名"
              name="username"
              rules={[{ required: true, message: '请输入用户名' }]}
            >
              <Input autoComplete="username" placeholder="例如 trend_student" />
            </Form.Item>
            <Form.Item
              label="密码"
              name="password"
              rules={[{ required: true, message: '请输入密码' }]}
            >
              <Input.Password autoComplete="current-password" placeholder="输入密码" />
            </Form.Item>
            <Button type="primary" htmlType="submit" block size="large" loading={busy}>
              登录
            </Button>
          </Form>
          <Typography.Paragraph className="auth-hint">
            还没有账号？<Link to="/register">创建一个</Link>
          </Typography.Paragraph>
        </Card>
      </section>
    </>
  )
}
