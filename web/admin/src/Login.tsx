import { useState, type FormEvent } from 'react'
import { login } from './api'
import type { SessionUser } from './types'
import { Field } from './ui'

export function Login({ onLogin }: { onLogin: (user: SessionUser) => void }) {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault()
    setBusy(true)
    setError(null)
    try {
      onLogin(await login(username.trim(), password))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '登录失败')
    } finally {
      setBusy(false)
    }
  }

  return (
    <main className="login">
      <form className="card" onSubmit={event => void submit(event)}>
        <h1>内容控制台</h1>
        <p className="muted">仅限运营与管理员账号登录。</p>
        <Field label="用户名">
          <input value={username} onChange={event => setUsername(event.target.value)} autoComplete="username" />
        </Field>
        <Field label="密码">
          <input
            type="password"
            value={password}
            onChange={event => setPassword(event.target.value)}
            autoComplete="current-password"
          />
        </Field>
        {error === null ? null : <p className="notice notice-error">{error}</p>}
        <button type="submit" disabled={busy || username === '' || password === ''}>
          {busy ? '登录中…' : '登录'}
        </button>
        <p className="hint">会话令牌仅保存在本页 sessionStorage，关闭页面即清除。</p>
      </form>
    </main>
  )
}
