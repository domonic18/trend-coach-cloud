import { StrictMode } from 'react'
import { createRoot, hydrateRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import { createPortalQueryClient, PortalProviders } from './App'
import { PortalRoutes } from './router'
import './styles.css'

const root = document.getElementById('root')
if (root === null) throw new Error('root element missing')

const tree = (
  <StrictMode>
    <PortalProviders queryClient={createPortalQueryClient()}>
      <BrowserRouter>
        <PortalRoutes />
      </BrowserRouter>
    </PortalProviders>
  </StrictMode>
)

// 预渲染产物有内容时水合，开发环境与 SPA 兜底时直接挂载。
if (root.hasChildNodes()) {
  hydrateRoot(root, tree)
} else {
  createRoot(root).render(tree)
}
