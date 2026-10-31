import { useEffect, useState, type FormEvent } from 'react'
import { createUser, listUsers, patchUser, resetUser } from './api'
import type { User, UserRole, UserStatus } from './types'
import { Field, formatTime, Notice, toNumber } from './ui'

interface AccountFilters {
  query: string
  role: '' | UserRole
  status: '' | UserStatus
  limit: string
}

const EMPTY_FILTERS: AccountFilters = { query: '', role: '', status: '', limit: '50' }

export function AccountsPanel({ onUnauthorized }: { onUnauthorized: () => void }) {
  const [filters, setFilters] = useState<AccountFilters>(EMPTY_FILTERS)
  const [users, setUsers] = useState<User[]>([])
  const [total, setTotal] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)

  const fail = (cause: unknown): void => {
    if (cause instanceof Error && 'status' in cause && (cause as { status: number }).status === 401) {
      onUnauthorized()
      return
    }
    setError(cause instanceof Error ? cause.message : '操作失败')
    setMessage(null)
  }

  const load = async (next: AccountFilters): Promise<void> => {
    const limit = toNumber(next.limit)
    try {
      const page = await listUsers({
        ...(next.query === '' ? {} : { query: next.query.trim() }),
        ...(next.role === '' ? {} : { role: next.role }),
        ...(next.status === '' ? {} : { status: next.status }),
        ...(limit === undefined ? {} : { limit }),
      })
      setUsers(page.users)
      setTotal(page.total)
    } catch (cause) {
      fail(cause)
    }
  }

  useEffect(() => {
    void load(EMPTY_FILTERS)
  }, [])

  const refresh = async (text: string): Promise<void> => {
    setMessage(text)
    setError(null)
    await load(filters)
  }

  return (
    <div className="stack">
      <Notice error={error} message={message} />

      <section className="card">
        <h2>账号</h2>
        <form
          className="row"
          autoComplete="off"
          onSubmit={event => {
            event.preventDefault()
            void load(filters)
          }}
        >
          <Field label="搜索">
            <input autoComplete="off" value={filters.query} onChange={event => setFilters({ ...filters, query: event.target.value })} />
          </Field>
          <Field label="角色">
            <select
              value={filters.role}
              onChange={event => setFilters({ ...filters, role: event.target.value as AccountFilters['role'] })}
            >
              <option value="">全部</option>
              <option value="student">student</option>
              <option value="operator">operator</option>
              <option value="admin">admin</option>
            </select>
          </Field>
          <Field label="状态">
            <select
              value={filters.status}
              onChange={event => setFilters({ ...filters, status: event.target.value as AccountFilters['status'] })}
            >
              <option value="">全部</option>
              <option value="active">active</option>
              <option value="disabled">disabled</option>
            </select>
          </Field>
          <Field label="条数">
            <input
              className="narrow"
              autoComplete="off"
              value={filters.limit}
              onChange={event => setFilters({ ...filters, limit: event.target.value })}
            />
          </Field>
          <button type="submit">查询</button>
        </form>
        <p className="muted">共 {total} 个账号</p>
        <table>
          <thead>
            <tr>
              <th>账号</th>
              <th>角色</th>
              <th>状态</th>
              <th>设备</th>
              <th>最近活跃</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {users.map(user => (
              <UserRow
                key={`${user.userId}:${user.displayName}:${user.role}:${user.status}`}
                user={user}
                onChanged={refresh}
                onError={fail}
              />
            ))}
          </tbody>
        </table>
      </section>

      <CreateUserCard onCreated={refresh} onError={fail} />
    </div>
  )
}

function UserRow({
  user,
  onChanged,
  onError,
}: {
  user: User
  onChanged: (message: string) => Promise<void>
  onError: (cause: unknown) => void
}) {
  const [expanded, setExpanded] = useState(false)
  const [password, setPassword] = useState('')
  const [invite, setInvite] = useState<string | null>(null)

  const patch = async (input: { role?: UserRole; status?: UserStatus }): Promise<void> => {
    try {
      await patchUser(user.userId, input)
      await onChanged('账号已更新')
    } catch (cause) {
      onError(cause)
    }
  }

  const reset = async (withPassword: boolean): Promise<void> => {
    try {
      const result = await resetUser(user.userId, withPassword ? password : undefined)
      setPassword('')
      setInvite(result.inviteCode ?? null)
      await onChanged(withPassword ? '密码已重置，旧邀请码失效' : '已生成一次性邀请码')
    } catch (cause) {
      onError(cause)
    }
  }

  return (
    <>
      <tr>
        <td>
          <strong>{user.username ?? '（无用户名）'}</strong>
          <div className="muted">{user.displayName ?? '—'}</div>
        </td>
        <td>
          <select value={user.role} onChange={event => void patch({ role: event.target.value as UserRole })}>
            <option value="student">student</option>
            <option value="operator">operator</option>
            <option value="admin">admin</option>
          </select>
        </td>
        <td>
          <select
            value={user.status}
            onChange={event => void patch({ status: event.target.value as UserStatus })}
          >
            <option value="active">active</option>
            <option value="disabled">disabled</option>
          </select>
        </td>
        <td>{user.deviceCount}</td>
        <td className="muted">{formatTime(user.lastActiveAt)}</td>
        <td>
          <button className="ghost" onClick={() => setExpanded(!expanded)}>
            {expanded ? '收起' : '凭据'}
          </button>
        </td>
      </tr>
      {!expanded ? null : (
        <tr>
          <td colSpan={6}>
            <div className="row">
              <Field label="新密码（10–128）">
                <input type="password" autoComplete="new-password" value={password} onChange={event => setPassword(event.target.value)} />
              </Field>
              <button disabled={password.length < 10} onClick={() => void reset(true)}>重置密码</button>
              <button className="ghost" onClick={() => void reset(false)}>生成邀请码</button>
              {invite === null ? null : (
                <span className="invite">
                  {invite}
                  <button className="ghost" onClick={() => void navigator.clipboard?.writeText(invite)}>复制</button>
                </span>
              )}
            </div>
            <p className="hint">邀请码只显示一次，默认 7 天有效、单次使用；重置后该账号后台会话立即失效。</p>
          </td>
        </tr>
      )}
    </>
  )
}

function CreateUserCard({
  onCreated,
  onError,
}: {
  onCreated: (message: string) => Promise<void>
  onError: (cause: unknown) => void
}) {
  const [form, setForm] = useState({
    username: '',
    displayName: '',
    role: 'student' as UserRole,
    password: '',
  })
  const [invite, setInvite] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault()
    setBusy(true)
    try {
      const created = await createUser({
        username: form.username.trim(),
        displayName: form.displayName.trim(),
        role: form.role,
        ...(form.password === '' ? {} : { password: form.password }),
      })
      setInvite(created.inviteCode ?? null)
      setForm({ ...form, username: '', displayName: '', password: '' })
      await onCreated(created.inviteCode === undefined ? '账号已创建' : `账号已创建，一次性邀请码：${created.inviteCode}`)
    } catch (cause) {
      onError(cause)
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="card">
      <h2>新建账号</h2>
      <form className="row" autoComplete="off" onSubmit={event => void submit(event)}>
        <Field label="用户名（3–32，小写）">
          <input
            autoComplete="off"
            value={form.username}
            onChange={event => setForm({ ...form, username: event.target.value })}
          />
        </Field>
        <Field label="显示名">
          <input
            autoComplete="off"
            value={form.displayName}
            onChange={event => setForm({ ...form, displayName: event.target.value })}
          />
        </Field>
        <Field label="角色">
          <select
            value={form.role}
            onChange={event => setForm({ ...form, role: event.target.value as UserRole })}
          >
            <option value="student">student</option>
            <option value="operator">operator</option>
            <option value="admin">admin</option>
          </select>
        </Field>
        <Field label="初始密码（可空）">
          <input
            type="password" autoComplete="new-password"
            value={form.password}
            onChange={event => setForm({ ...form, password: event.target.value })}
          />
        </Field>
        <button
          type="submit"
          disabled={busy || form.username.trim() === '' || form.displayName.trim() === '' || (form.password !== '' && form.password.length < 10)}
        >
          创建账号
        </button>
      </form>
      {invite === null ? null : (
        <p className="invite">
          邀请码：{invite}
          <button className="ghost" onClick={() => void navigator.clipboard?.writeText(invite)}>复制</button>
        </p>
      )}
      <p className="hint">留空密码时生成一次性邀请码，由学员在授权页自行设置密码。</p>
    </section>
  )
}
