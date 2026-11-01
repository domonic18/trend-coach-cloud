import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { applyTheme, readInitialTheme } from './theme'
import './styles.css'

applyTheme(readInitialTheme())

const root = document.getElementById('root')
if (root === null) throw new Error('root element missing')

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
