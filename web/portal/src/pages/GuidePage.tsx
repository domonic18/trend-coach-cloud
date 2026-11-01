import { Alert, Button } from 'antd'
import { Link } from 'react-router-dom'
import { CodeBlock } from '../components/CodeBlock'
import { PageHero } from '../components/PageHero'
import { PageMarkdown } from '../components/PageMarkdown'
import { content } from '../content'
import { DSH_VERSION, PLUGIN_FILE, WEB_APP_PACKAGE } from '../release'
import { usePageMeta } from '../usePageMeta'

const STEPS = [
  {
    title: '准备 Node.js 环境',
    text: '需要 Node.js 22 或更高版本。安装后打开终端确认版本，再继续下一步。',
    code: 'node -v',
  },
  {
    title: '安装 dsh 并创建配置',
    text: `使用固定版本 ${DSH_VERSION}。首次运行会创建 trend-coach profile；--no-open 表示先不自动打开浏览器。`,
    code: `npx --yes @deepseek-ai/dsh@${DSH_VERSION} --profile trend-coach --port 3939 --no-open`,
  },
  {
    title: '下载并安装学习插件',
    text: `在下载页获取 ${PLUGIN_FILE}，在文件所在目录执行安装命令。插件与 dsh 版本精确匹配，不要混用其他版本。`,
    code: `dsh plugin --profile trend-coach add -w ./${PLUGIN_FILE}`,
  },
  {
    title: '安装 Web UI（可选）',
    text: '如果希望在浏览器中使用课程体系与问答面板，再安装官方 Web UI。',
    code: `dsh plugin --profile trend-coach add ${WEB_APP_PACKAGE}`,
  },
  {
    title: '启动并完成设备授权',
    text: '启动后打开侧边栏的「趋势伴学」，点击设备登录。浏览器会打开授权页，用本站账号登录并批准设备码，随后客户端会自动生效。',
    code: 'dsh --profile trend-coach --port 3939',
  },
]

export function GuidePage() {
  usePageMeta('/guide')
  return (
    <>
      <PageHero
        kicker="使用向导"
        title="从零安装到可以提问"
        description="按顺序完成下面五步。每一步都给出可直接复制的命令，遇到问题先看文末排查清单。"
      >
        <Link to="/downloads"><Button type="primary">先下载插件</Button></Link>
        <Link to="/faq"><Button>常见问题</Button></Link>
      </PageHero>

      <section className="content-section">
        <Alert
          type="info"
          showIcon
          className="guide-alert"
          message="账号与插件版本"
          description="账号用于设备授权与学习进度；插件、dsh 与 Web UI 的版本需互相匹配，升级时先看下载页的更新说明。"
        />
        <ol className="guide-steps">
          {STEPS.map((step, index) => (
            <li key={step.title} className="guide-step">
              <div className="guide-step-head">
                <span className="guide-step-index">{String(index + 1).padStart(2, '0')}</span>
                <h2>{step.title}</h2>
              </div>
              <p>{step.text}</p>
              <CodeBlock code={step.code} />
            </li>
          ))}
        </ol>
      </section>

      <section className="content-section content-section-narrow">
        <h2 className="content-section-title">安装排错</h2>
        <PageMarkdown value={content('guide')} />
      </section>
    </>
  )
}
