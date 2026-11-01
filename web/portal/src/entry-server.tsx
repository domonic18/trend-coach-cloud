import { createCache, extractStyle, StyleProvider } from '@ant-design/cssinjs'
import { renderToString } from 'react-dom/server'
import { StaticRouter } from 'react-router-dom'
import { createPortalQueryClient, PortalProviders } from './App'
import { PortalRoutes } from './router'

export { ROUTES, SITE_NAME } from './meta'
export type { RouteMeta } from './meta'

export interface RenderResult {
  html: string
  styles: string
}

/** 预渲染只接受公共路由；渲染期禁止时间、随机数与浏览器 API。 */
export function render(path: string): RenderResult {
  const cache = createCache()
  const html = renderToString(
    <StyleProvider cache={cache}>
      <PortalProviders queryClient={createPortalQueryClient()}>
        <StaticRouter location={path}>
          <PortalRoutes />
        </StaticRouter>
      </PortalProviders>
    </StyleProvider>,
  )
  return { html, styles: extractStyle(cache, true) }
}
