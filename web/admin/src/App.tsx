import { useEffect, useState, type FormEvent } from 'react'
import { AccountsPanel } from './AccountsPanel'
import { changePassword, clearToken, currentUser, hasToken, logout } from './api'
import { ContentPanel } from './ContentPanel'
import { Login } from './Login'
import { ModelConfigPanel } from './ModelConfigPanel'
import { PipelinePanel } from './PipelinePanel'
import { SegmentsPanel } from './SegmentsPanel'
import type { SessionUser } from './types'
import { Field, Notice } from './ui'

type Tab = 'content' | 'segments' | 'pipeline' | 'models' | 'accounts'

export function App() {
  const [user, setUser] = useState<SessionUser | null>(null)
  const [checking, setChecking] = useState(hasToken())
  const [tab, setTab] = useState<Tab>('content')
  const [showPassword, setShowPassword] = useState(false)

  useEffect(() => {
    if (!hasToken()) return
    let active = true
    void currentUser()
      .then(value => {
        if (active) setUser(value)
      })
      .catch(() => {
        clearToken()
        if (active) setUser(null)
      })
      .finally(() => {
        if (active) setChecking(false)
      })
    return () => {
      active = false
    }
  }, [])

  if (checking) return <main className="login"><p className="muted">正在验证会话…</p></main>
  if (user === null) {
    return <Login onLogin={setUser} />
  }

  const unauthorized = (): void => {
    clearToken()
    setUser(null)
  }

  return (
    <div className="app">
      <header className="topbar">
        <div>
          <strong>趋势交易课程内容控制台</strong>
          <span className="muted"> · {user.displayName ?? user.username}（{user.role}）</span>
        </div>
        <div className="row">
          <button className="ghost" onClick={() => setShowPassword(!showPassword)}>修改密码</button>
          <button
            className="ghost"
            onClick={() => {
              void logout().finally(() => setUser(null))
            }}
          >
            退出
          </button>
        </div>
      </header>

      <nav className="tabs">
        <button className={tab === 'content' ? 'active' : ''} onClick={() => setTab('content')}>课程内容</button>
        <button className={tab === 'segments' ? 'active' : ''} onClick={() => setTab('segments')}>片段</button>
        <button className={tab === 'pipeline' ? 'active' : ''} onClick={() => setTab('pipeline')}>视频建课</button>
        {user.role === 'admin' ? (
          <button className={tab === 'models' ? 'active' : ''} onClick={() => setTab('models')}>模型配置</button>
        ) : null}
        {user.role === 'admin' ? (
          <button className={tab === 'accounts' ? 'active' : ''} onClick={() => setTab('accounts')}>账号</button>
        ) : null}
      </nav>

      {showPassword ? <PasswordCard onClose={() => setShowPassword(false)} /> : null}

      <main className="content">
        {tab === 'content' ? <ContentPanel onUnauthorized={unauthorized} /> : null}
        {tab === 'segments' ? <SegmentsPanel onUnauthorized={unauthorized} /> : null}
        {tab === 'pipeline' ? (
          <PipelinePanel onUnauthorized={unauthorized} onOpenContent={() => setTab('content')} />
        ) : null}
        {tab === 'models' && user.role === 'admin' ? <ModelConfigPanel onUnauthorized={unauthorized} /> : null}
        {tab === 'accounts' && user.role === 'admin' ? <AccountsPanel onUnauthorized={unauthorized} /> : null}
      </main>
    </div>
  )
}

function PasswordCard({ onClose }: { onClose: () => void }) {
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault()
    setBusy(true)
    setError(null)
    setMessage(null)
    try {
      await changePassword(current, next)
      setCurrent('')
      setNext('')
      setMessage('密码已更新，其他会话已失效')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '修改失败')
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="card">
      <div className="spread">
        <h2>修改密码</h2>
        <button className="ghost" onClick={onClose}>关闭</button>
      </div>
      <Notice error={error} message={message} />
      <form className="row" onSubmit={event => void submit(event)}>
        <Field label="当前密码">
          <input
            type="password"
            autoComplete="current-password"
            value={current}
            onChange={event => setCurrent(event.target.value)}
          />
        </Field>
        <Field label="新密码（10–128）">
          <input
            type="password"
            autoComplete="new-password"
            value={next}
            onChange={event => setNext(event.target.value)}
          />
        </Field>
        <button type="submit" disabled={busy || current === '' || next.length < 10}>保存</button>
      </form>
    </section>
  )
}
