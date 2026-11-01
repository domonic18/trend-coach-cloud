import { Button } from 'antd'
import { Link } from 'react-router-dom'
import { PageHero } from '../components/PageHero'
import { usePageMeta } from '../usePageMeta'

export function NotFoundPage() {
  usePageMeta('/404')
  return (
    <>
      <PageHero
        kicker="404"
        title="没有找到这个页面"
        description="链接可能已经失效，或者地址拼写有误。"
      >
        <Link to="/"><Button type="primary">返回首页</Button></Link>
        <Link to="/guide"><Button>查看使用向导</Button></Link>
      </PageHero>
    </>
  )
}
