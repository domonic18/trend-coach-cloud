import { Button } from 'antd'
import { Link } from 'react-router-dom'
import { PageHero } from '../components/PageHero'
import { PageMarkdown } from '../components/PageMarkdown'
import { content } from '../content'
import { usePageMeta } from '../usePageMeta'

export function FaqPage() {
  usePageMeta('/faq')
  return (
    <>
      <PageHero
        kicker="常见问题"
        title="安装、授权与使用"
        description="先看这里能否解决；仍无法处理时，记录出错步骤与提示文字再联系管理员。"
      >
        <Link to="/guide"><Button type="primary">回到安装向导</Button></Link>
      </PageHero>
      <section className="content-section">
        <PageMarkdown value={content('faq')} />
      </section>
    </>
  )
}
