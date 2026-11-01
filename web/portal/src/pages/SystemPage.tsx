import { Button } from 'antd'
import { Link } from 'react-router-dom'
import { PageHero } from '../components/PageHero'
import { PageMarkdown } from '../components/PageMarkdown'
import { content } from '../content'
import { usePageMeta } from '../usePageMeta'

export function SystemPage() {
  usePageMeta('/system')
  return (
    <>
      <PageHero
        kicker="交易体系"
        title="趋势交易体系"
        description="趋势交易不是预测未来，而是在可识别的结构里承担有限风险。先理解理念，再学习招式。"
      >
        <Link to="/guide"><Button type="primary">安装后开始学习</Button></Link>
        <Link to="/features"><Button>看看工具有哪些</Button></Link>
      </PageHero>
      <section className="content-section">
        <PageMarkdown value={content('system')} />
      </section>
    </>
  )
}
