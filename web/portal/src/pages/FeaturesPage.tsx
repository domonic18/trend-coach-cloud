import { Button } from 'antd'
import { Link } from 'react-router-dom'
import { PageHero } from '../components/PageHero'
import { PageMarkdown } from '../components/PageMarkdown'
import { content } from '../content'
import { usePageMeta } from '../usePageMeta'

export function FeaturesPage() {
  usePageMeta('/features')
  return (
    <>
      <PageHero
        kicker="站点功能"
        title="检索、定位、学习、提问"
        description="把长课程里的知识拆成可检索的片段，让每一次提问都能回到原始出处。"
      >
        <Link to="/guide"><Button type="primary">开始安装</Button></Link>
        <Link to="/faq"><Button>常见问题</Button></Link>
      </PageHero>
      <section className="content-section">
        <PageMarkdown value={content('features')} />
      </section>
    </>
  )
}
