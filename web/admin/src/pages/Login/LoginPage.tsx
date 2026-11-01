import { LockOutlined, UserOutlined } from '@ant-design/icons'
import { Alert, Button, Card, Form, Input, Typography } from 'antd'
import { useState } from 'react'
import { Navigate, useLocation, useNavigate } from 'react-router-dom'
import { login } from '../../api'
import { useAuth } from '../../auth/AuthProvider'

interface LoginForm {
  username: string
  password: string
}

export function LoginPage() {
  const { user, loading, signIn } = useAuth()
  const location = useLocation()
  const navigate = useNavigate()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  if (!loading && user !== null) return <Navigate to="/" replace />

  const returnTo = (location.state as { returnTo?: string } | null)?.returnTo ?? '/'

  const submit = async (values: LoginForm): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      signIn(await login(values.username.trim(), values.password))
      navigate(returnTo, { replace: true })
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '登录失败')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="login-page">
      <div className="login-aside">
        <div className="login-brand">
          <span className="login-brand-mark">趋</span>
          <div>
            <Typography.Title level={2}>趋势交易课程内容控制台</Typography.Title>
            <Typography.Paragraph>
              运营课程体系、审核生成内容、管理视频建课管线与模型渠道。
            </Typography.Paragraph>
          </div>
        </div>
        <ul className="login-points">
          <li>视频上传、转码、转写与结构化生成一体化</li>
          <li>生成内容先审后发，发布前自动重建检索索引</li>
          <li>模型密钥加密存储，仅管理员可维护</li>
        </ul>
      </div>

      <Card className="login-card" variant="borderless">
        <Typography.Title level={4} className="login-card-title">登录</Typography.Title>
        <Typography.Text type="secondary">仅限运营与管理员账号。</Typography.Text>
        {error === null ? null : <Alert type="error" showIcon message={error} className="login-alert" />}
        <Form<LoginForm>
          layout="vertical"
          requiredMark={false}
          onFinish={values => void submit(values)}
          autoComplete="off"
        >
          <Form.Item
            name="username"
            label="用户名"
            rules={[{ required: true, message: '请输入用户名' }]}
          >
            <Input prefix={<UserOutlined />} autoComplete="username" size="large" />
          </Form.Item>
          <Form.Item
            name="password"
            label="密码"
            rules={[{ required: true, message: '请输入密码' }]}
          >
            <Input.Password prefix={<LockOutlined />} autoComplete="current-password" size="large" />
          </Form.Item>
          <Button type="primary" htmlType="submit" block size="large" loading={busy}>
            登录
          </Button>
        </Form>
        <Typography.Text type="secondary" className="login-hint">
          会话令牌只保存在本页 sessionStorage，关闭页面即清除。
        </Typography.Text>
      </Card>
    </div>
  )
}
