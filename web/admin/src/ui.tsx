import type { ReactNode } from 'react'
import type { ContentStatus } from './types'

export function StatusBadge({ status }: { status: ContentStatus }) {
  return <span className={`badge badge-${status}`}>{status}</span>
}

export function StatusSelect({
  value,
  onChange,
  allowArchive = true,
}: {
  value: ContentStatus
  onChange: (value: ContentStatus) => void
  allowArchive?: boolean
}) {
  return (
    <select value={value} onChange={event => onChange(event.target.value as ContentStatus)}>
      <option value="draft">draft</option>
      <option value="published">published</option>
      {allowArchive ? <option value="archived">archived</option> : null}
    </select>
  )
}

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
    </label>
  )
}

export function Notice({ error, message }: { error: string | null; message: string | null }) {
  if (error !== null) return <p className="notice notice-error">{error}</p>
  if (message !== null) return <p className="notice notice-ok">{message}</p>
  return null
}

export function formatTime(value: number | null): string {
  if (value === null) return '—'
  return new Date(value).toLocaleString()
}

export function toNumber(raw: string): number | undefined {
  const value = Number(raw)
  return Number.isInteger(value) ? value : undefined
}
