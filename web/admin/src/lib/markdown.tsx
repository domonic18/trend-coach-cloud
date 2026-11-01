import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

export function MarkdownPreview({ value }: { value: string }) {
  if (value.trim() === '') {
    return <div className="markdown-empty">左侧输入 Markdown，右侧实时预览。</div>
  }

  return (
    <div className="markdown-preview">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        disallowedElements={['script', 'iframe', 'object', 'embed', 'style', 'form', 'input']}
        unwrapDisallowed
        components={{
          a: ({ node: _node, ...props }) => (
            <a {...props} target="_blank" rel="noreferrer noopener" />
          ),
        }}
      >
        {value}
      </ReactMarkdown>
    </div>
  )
}
