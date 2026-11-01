import { Space, Typography } from 'antd'
import type { ReactNode } from 'react'

export function PageHeader({
  title,
  subtitle,
  extra,
}: {
  title: string
  subtitle?: ReactNode
  extra?: ReactNode
}) {
  return (
    <div className="page-header">
      <div className="page-header-text">
        <Typography.Title level={4} className="page-header-title">{title}</Typography.Title>
        {subtitle === undefined ? null : (
          <Typography.Text type="secondary" className="page-header-subtitle">{subtitle}</Typography.Text>
        )}
      </div>
      {extra === undefined ? null : <Space wrap>{extra}</Space>}
    </div>
  )
}
