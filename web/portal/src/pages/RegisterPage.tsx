import { App as AntApp, Button, Card, Form, Input, Typography } from 'antd'
import { useState } from 'react'
import { Link, Navigate, useNavigate } from 'react-router-dom'
import { register } from '../api'
import { useAuth } from '../auth/AuthProvider'
import { PageHero } from '../components/PageHero'
import { authErrorMessage } from '../lib/auth-errors'
import { usePageMeta } from '../usePageMeta'

interface RegisterValues {
  username: string
  displayName?: string
  password: string
  confirm: string
}

export function RegisterPage() {
  usePageMeta('/register')
  const { message } = AntApp.useApp()
  const { user, loading, signIn } = useAuth()
  const navigate = useNavigate()
  const [busy, setBusy] = useState(false)

  if (!loading && user !== null) return <Navigate to="/account" replace />

  const onFinish = async (values: RegisterValues): Promise<void> => {
    setBusy(true)
    try {
      const session = await register({
        username: values.username.trim(),
        password: values.password,
        ...(values.displayName === undefined || values.displayName.trim() === ''
          ? {}
          : { displayName: values.displayName.trim() }),
      })
      signIn(session.user)
      message.success('注册成功，已自动登录')
      navigate('/account', { replace: true })
    } catch (error) {
      message.error(authErrorMessage(error))
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <PageHero
        kicker="注册"
        title="创建学习账号"
        description="账号只用于设备授权与学习进度。插件里的模型密钥仍然由你自己保管，云端不接触。"
      />
      <section className="content-section content-section-narrow">
        <Card className="auth-card">
          <Form<RegisterValues> layout="vertical" onFinish={onFinish} requiredMark={false}>
            <Form.Item
              label="用户名"
              name="username"
              extra="3–32 位，小写字母开头，可包含数字、点、下划线与短横线"
              rules={[
                { required: true, message: '请输入用户名' },
                { pattern: /^[a-z][a-z0-9._-]{2,31}$/, message: '用户名格式不正确' },
              ]}
            >
              <Input autoComplete="username" placeholder="例如 trend_student" />
            </Form.Item>
            <Form.Item label="昵称（可选）" name="displayName">
              <Input maxLength={200} placeholder="展示在个人中心里的名字" />
            </Form.Item>
            <Form.Item
              label="密码"
              name="password"
              extra="至少 10 个字符"
              rules={[
                { required: true, message: '请输入密码' },
                { min: 10, message: '密码至少 10 个字符' },
                { max: 128, message: '密码最多 128 个字符' },
              ]}
            >
              <Input.Password autoComplete="new-password" placeholder="设置密码" />
            </Form.Item>
            <Form.Item
              label="确认密码"
              name="confirm"
              dependencies={['password']}
              rules={[
                { required: true, message: '请再次输入密码' },
                ({ getFieldValue }) => ({
                  validator(_rule, value: string) {
                    return value === getFieldValue('password')
                      ? Promise.resolve()
                      : Promise.reject(new Error('两次输入的密码不一致'))
                  },
                }),
              ]}
            >
              <Input.Password autoComplete="new-password" placeholder="再次输入密码" />
            </Form.Item>
            <Button type="primary" htmlType="submit" block size="large" loading={busy}>
              注册并登录
            </Button>
          </Form>
          <Typography.Paragraph className="auth-hint">
            已有账号？<Link to="/login">直接登录</Link>
          </Typography.Paragraph>
        </Card>
      </section>
    </>
  )
}
