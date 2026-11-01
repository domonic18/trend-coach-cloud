import { PageHero } from '../components/PageHero'
import { PageMarkdown } from '../components/PageMarkdown'
import { content } from '../content'
import { usePageMeta } from '../usePageMeta'

const LEGAL = {
  privacy: { path: '/legal/privacy', kicker: '隐私说明', title: '隐私与数据处理' },
  terms: { path: '/legal/terms', kicker: '用户协议', title: '服务条款' },
} as const

export function LegalPage({ kind }: { kind: keyof typeof LEGAL }) {
  const meta = LEGAL[kind]
  usePageMeta(meta.path)
  return (
    <>
      <PageHero kicker={meta.kicker} title={meta.title} description="请在使用服务前完整阅读。" />
      <section className="content-section">
        <PageMarkdown value={content(kind)} />
      </section>
    </>
  )
}
