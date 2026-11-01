import { DownloadOutlined } from '@ant-design/icons'
import { useQuery } from '@tanstack/react-query'
import { Alert, Button, Descriptions, Spin, Tag } from 'antd'
import { Link } from 'react-router-dom'
import { getReleases } from '../api'
import { CodeBlock } from '../components/CodeBlock'
import { PageHero } from '../components/PageHero'
import { formatBytes, formatDate } from '../lib/format'
import { usePageMeta } from '../usePageMeta'

export function DownloadsPage() {
  usePageMeta('/downloads')
  const releases = useQuery({ queryKey: ['portal', 'releases'], queryFn: getReleases })

  return (
    <>
      <PageHero
        kicker="版本下载"
        title="下载学习插件"
        description="下载后按安装向导操作。升级前请先阅读更新说明，确认 dsh 版本匹配。"
      >
        <Link to="/guide"><Button type="primary">查看安装步骤</Button></Link>
      </PageHero>

      <section className="content-section">
        {releases.isPending && (
          <div className="portal-loading">
            <Spin />
            <span>正在加载版本信息…</span>
          </div>
        )}

        {releases.isError && (
          <Alert
            type="error"
            showIcon
            message="版本信息加载失败"
            description="请稍后刷新页面重试；如持续失败，请联系管理员。"
          />
        )}

        {releases.data !== undefined && releases.data.plugin === null && (
          <Alert
            type="warning"
            showIcon
            message="暂无可用安装包"
            description="当前未发布插件版本。可以先完成账号注册与体系学习，发布后会在本页更新。"
          />
        )}

        {releases.data?.plugin !== null && releases.data?.plugin !== undefined && (
          <>
            <article className="download-card">
              <div className="download-card-head">
                <div>
                  <h2>{releases.data.plugin.name}</h2>
                  <div className="download-meta">
                    <Tag color="blue">v{releases.data.plugin.version}</Tag>
                    <span>发布于 {formatDate(releases.data.plugin.publishedAt)}</span>
                    <span>文件大小 {formatBytes(releases.data.plugin.sizeBytes)}</span>
                  </div>
                </div>
                <a href={`/downloads/${encodeURIComponent(releases.data.plugin.fileName)}`} download>
                  <Button type="primary" size="large" icon={<DownloadOutlined />}>
                    下载安装包
                  </Button>
                </a>
              </div>

              <Descriptions column={1} size="small" className="download-detail">
                <Descriptions.Item label="文件名">{releases.data.plugin.fileName}</Descriptions.Item>
                <Descriptions.Item label="校验值（SHA-256）">
                  {releases.data.plugin.sha256 === null
                    ? '未提供'
                    : <code className="download-sha">{releases.data.plugin.sha256}</code>}
                </Descriptions.Item>
              </Descriptions>

              {releases.data.plugin.notes.length > 0 && (
                <div className="download-notes">
                  <h3>更新说明</h3>
                  <ul>
                    {releases.data.plugin.notes.map(note => <li key={note}>{note}</li>)}
                  </ul>
                </div>
              )}
            </article>

            <div className="download-side-grid">
              <article className="info-card">
                <h3>环境要求</h3>
                <ul>
                  <li>dsh 版本：<code>{releases.data.dshVersion}</code>（精确匹配）</li>
                  <li>Web UI：<code>{releases.data.webAppPackage}</code></li>
                  <li>Node.js 22 或更高版本</li>
                </ul>
              </article>
              <article className="info-card">
                <h3>校验安装包</h3>
                <p>下载完成后可在终端校验文件完整性，再执行安装。</p>
                <CodeBlock
                  label="macOS / Linux"
                  code={`shasum -a 256 ${releases.data.plugin.fileName}`}
                />
              </article>
            </div>
          </>
        )}
      </section>
    </>
  )
}
