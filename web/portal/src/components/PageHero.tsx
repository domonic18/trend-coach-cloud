import type { ReactNode } from 'react'

export function PageHero({
  kicker,
  title,
  description,
  children,
}: {
  kicker?: string
  title: string
  description: ReactNode
  children?: ReactNode
}) {
  return (
    <section className="page-hero">
      <div className="page-hero-inner">
        {kicker !== undefined && <span className="page-kicker">{kicker}</span>}
        <h1>{title}</h1>
        <div className="page-hero-description">{description}</div>
        {children !== undefined && <div className="page-hero-actions">{children}</div>}
      </div>
    </section>
  )
}
