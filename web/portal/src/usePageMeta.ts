import { useEffect } from 'react'
import { metaFor, SITE_NAME } from './meta'

function setMeta(selector: string, attributes: Record<string, string>): void {
  let element = document.head.querySelector<HTMLMetaElement>(selector)
  if (element === null) {
    element = document.createElement('meta')
    for (const [key, value] of Object.entries(attributes)) element.setAttribute(key, value)
    document.head.appendChild(element)
    return
  }
  const name = attributes.name ?? attributes.property
  if (name !== undefined) element.setAttribute(attributes.name === undefined ? 'property' : 'name', name)
  element.setAttribute('content', attributes.content ?? '')
}

/** 客户端导航时同步标题与描述；首屏由预渲染脚本注入。 */
export function usePageMeta(pathname: string): void {
  useEffect(() => {
    const meta = metaFor(pathname)
    const title = meta?.title ?? `页面不存在｜${SITE_NAME}`
    const description = meta?.description ?? '未找到该页面。'
    document.title = title
    setMeta('meta[name="description"]', { name: 'description', content: description })
    setMeta('meta[property="og:title"]', { property: 'og:title', content: title })
    setMeta('meta[property="og:description"]', { property: 'og:description', content: description })
    setMeta(
      'meta[name="robots"]',
      meta?.noindex === true
        ? { name: 'robots', content: 'noindex,nofollow' }
        : { name: 'robots', content: 'index,follow' },
    )
  }, [pathname])
}
