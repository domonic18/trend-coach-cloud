import { CheckOutlined, CopyOutlined } from '@ant-design/icons'
import { Button } from 'antd'
import { useEffect, useRef, useState } from 'react'

export function CodeBlock({ code, label }: { code: string; label?: string }) {
  const [copied, setCopied] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  useEffect(() => () => {
    if (timer.current !== undefined) clearTimeout(timer.current)
  }, [])

  const copy = (): void => {
    if (typeof navigator === 'undefined' || navigator.clipboard === undefined) return
    void navigator.clipboard.writeText(code).then(() => {
      setCopied(true)
      if (timer.current !== undefined) clearTimeout(timer.current)
      timer.current = setTimeout(() => setCopied(false), 1800)
    }).catch(() => undefined)
  }

  return (
    <div className="code-block">
      <div className="code-block-bar">
        <span>{label ?? '终端'}</span>
        <Button
          type="text"
          size="small"
          icon={copied ? <CheckOutlined /> : <CopyOutlined />}
          onClick={copy}
        >
          {copied ? '已复制' : '复制'}
        </Button>
      </div>
      <pre><code>{code}</code></pre>
    </div>
  )
}
