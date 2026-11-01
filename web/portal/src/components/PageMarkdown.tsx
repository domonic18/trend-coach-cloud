import ReactMarkdown from 'react-markdown'
import { Link } from 'react-router-dom'
import remarkGfm from 'remark-gfm'

/** 内容来自仓库 Markdown：禁 raw HTML，站内链接走路由，站外链接新开标签。 */
export function PageMarkdown({ value }: { value: string }) {
  return (
    <div className="prose">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        disallowedElements={['script', 'iframe', 'object', 'embed', 'style', 'form', 'input']}
        unwrapDisallowed
        components={{
          a: ({ href, children }) => (
            typeof href === 'string' && href.startsWith('/')
              ? <Link to={href}>{children}</Link>
              : <a href={href} target="_blank" rel="noreferrer noopener">{children}</a>
          ),
        }}
      >
        {value}
      </ReactMarkdown>
    </div>
  )
}
