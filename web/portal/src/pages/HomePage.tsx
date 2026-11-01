import { ArrowRightOutlined } from '@ant-design/icons'
import { useQuery } from '@tanstack/react-query'
import { Button } from 'antd'
import { Link } from 'react-router-dom'
import { getStats } from '../api'
import { usePageMeta } from '../usePageMeta'

const PILLARS = [
  {
    title: '顺势而为',
    text: '不预测顶底，先确认趋势方向与结构，再讨论进场。趋势不明时，空仓也是仓位。',
  },
  {
    title: '结构入场',
    text: '用回撤、突破与量价配合寻找风险可控的介入点，把止损放在结构失效处。',
  },
  {
    title: '风险先行',
    text: '先定单笔风险与总仓位上限，再谈收益。连续亏损时主动降低暴露，而不是加倍下注。',
  },
]

const CAPABILITIES = [
  {
    title: '知识检索',
    text: '用自然语言描述你的疑问，检索课程视频片段与知识点文章，答案附带出处。',
  },
  {
    title: '片段定位',
    text: '点击引用即可跳转到对应视频秒数，省略在长课程里反复拖动进度条。',
  },
  {
    title: '课程体系',
    text: '按课程、章节、知识点组织的学习路径，随时查看已学进度与待补内容。',
  },
  {
    title: '伴学问答',
    text: '基于课程内容的问答，明确边界：只做课程知识检索，不提供买卖建议。',
  },
]

const PATH = [
  { step: '01', title: '建立框架', text: '先看体系页，理解趋势、结构与风险三件事的关系。' },
  { step: '02', title: '按课学习', text: '从基础课开始，按章节推进，不懂的知识点先记下来。' },
  { step: '03', title: '带着问题检索', text: '把疑问交给伴学问答，顺着引用回到视频原片段。' },
  { step: '04', title: '复盘与输出', text: '用自己的话复述知识点，形成可执行的交易检查清单。' },
]

function StatCard({ label, value }: { label: string; value: number | undefined }) {
  return (
    <div className="stat-card">
      <strong>{value === undefined ? '—' : value.toLocaleString('zh-CN')}</strong>
      <span>{label}</span>
    </div>
  )
}

export function HomePage() {
  usePageMeta('/')
  const stats = useQuery({ queryKey: ['portal', 'stats'], queryFn: getStats })

  return (
    <>
      <section className="home-hero">
        <div className="home-hero-inner">
          <span className="page-kicker">趋势交易 · 课程伴学</span>
          <h1>
            把课程、知识点与 AI 问答
            <br />
            装进你的本地 dsh 客户端
          </h1>
          <p className="home-hero-lead">
            围绕趋势交易体系组织课程内容。检索、定位与伴学问答都在你熟悉的 dsh 里完成，
            模型密钥与推理留在本地，云端只提供课程知识与账号服务。
          </p>
          <div className="home-hero-actions">
            <Link to="/guide">
              <Button type="primary" size="large">
                开始安装 <ArrowRightOutlined />
              </Button>
            </Link>
            <Link to="/system">
              <Button size="large">先了解体系</Button>
            </Link>
          </div>
          <div className="home-stats">
            <StatCard label="课程" value={stats.data?.courses} />
            <StatCard label="知识点" value={stats.data?.knowledgePoints} />
            <StatCard label="视频片段" value={stats.data?.segments} />
            <StatCard label="知识点文章" value={stats.data?.articles} />
          </div>
          <p className="home-disclaimer">
            本站内容仅用于教学与知识检索，不构成投资建议，也不提供具体买卖信号。
          </p>
        </div>
      </section>

      <section className="home-section">
        <div className="section-heading">
          <span className="page-kicker">体系概览</span>
          <h2>先有框架，再谈招式</h2>
          <p>课程围绕三件事展开：判断趋势、等待结构、控制风险。三者缺一不可。</p>
        </div>
        <div className="pillar-grid">
          {PILLARS.map(pillar => (
            <article key={pillar.title} className="pillar-card">
              <h3>{pillar.title}</h3>
              <p>{pillar.text}</p>
            </article>
          ))}
        </div>
        <div className="section-more">
          <Link to="/system">查看完整体系说明 <ArrowRightOutlined /></Link>
        </div>
      </section>

      <section className="home-section home-section-muted">
        <div className="section-heading">
          <span className="page-kicker">站点功能</span>
          <h2>检索、定位、学习、提问</h2>
          <p>把分散在长视频里的知识，变成可以随时查、可以回溯出处的学习材料。</p>
        </div>
        <div className="capability-grid">
          {CAPABILITIES.map(item => (
            <article key={item.title} className="capability-card">
              <h3>{item.title}</h3>
              <p>{item.text}</p>
            </article>
          ))}
        </div>
        <div className="section-more">
          <Link to="/features">了解功能边界 <ArrowRightOutlined /></Link>
        </div>
      </section>

      <section className="home-section">
        <div className="section-heading">
          <span className="page-kicker">学习路径</span>
          <h2>四步建立自己的交易检查清单</h2>
        </div>
        <ol className="path-list">
          {PATH.map(item => (
            <li key={item.step} className="path-item">
              <span className="path-step">{item.step}</span>
              <div>
                <h3>{item.title}</h3>
                <p>{item.text}</p>
              </div>
            </li>
          ))}
        </ol>
      </section>

      <section className="home-cta">
        <div className="home-cta-inner">
          <div>
            <h2>准备好开始了吗？</h2>
            <p>安装 dsh 与插件只需几分钟，账号用于同步设备授权与学习进度。</p>
          </div>
          <div className="home-cta-actions">
            <Link to="/register">
              <Button type="primary" size="large">创建账号</Button>
            </Link>
            <Link to="/downloads">
              <Button size="large">下载插件</Button>
            </Link>
          </div>
        </div>
      </section>
    </>
  )
}
