import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'vite'

const root = fileURLToPath(new URL('..', import.meta.url))
const portalRoot = join(root, 'web', 'portal')
const configFile = join(portalRoot, 'vite.config.ts')
const outDir = join(root, 'dist', 'portal')
const ssrDir = join(root, 'dist', 'portal-ssr')
const entry = join(portalRoot, 'src', 'entry-server.tsx')
const origin = (process.env.PUBLIC_BASE_URL ?? 'http://127.0.0.1:3939').replace(/\/+$/, '')

function escapeHtml(value) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/** 预渲染内容必须确定性：渲染期不读时间、随机数与浏览器 API。 */
function inject(template, { html, styles, meta, siteName }) {
  const url = `${origin}${meta.path}`
  const head = [
    `<link rel="canonical" href="${escapeHtml(url)}" />`,
    '<meta property="og:type" content="website" />',
    `<meta property="og:site_name" content="${escapeHtml(siteName)}" />`,
    `<meta property="og:title" content="${escapeHtml(meta.title)}" />`,
    `<meta property="og:description" content="${escapeHtml(meta.description)}" />`,
    `<meta property="og:url" content="${escapeHtml(url)}" />`,
    '<meta name="twitter:card" content="summary" />',
    `<meta name="robots" content="${meta.noindex === true ? 'noindex,nofollow' : 'index,follow'}" />`,
  ].join('\n    ')

  if (!/<title>[\s\S]*?<\/title>/.test(template)) throw new Error('portal template missing <title>')
  let out = template
    .replace(/<title>[\s\S]*?<\/title>/, `<title>${escapeHtml(meta.title)}</title>`)
    .replace(
      /<meta name="description" content="[^"]*"\s*\/?>/,
      `<meta name="description" content="${escapeHtml(meta.description)}" />`,
    )
    .replace('</head>', `    ${head}\n    <style data-antd-ssr>${styles}</style>\n  </head>`)

  if (!out.includes('<div id="root"></div>')) throw new Error('portal template missing empty root')
  return out.replace('<div id="root"></div>', `<div id="root">${html}</div>`)
}

function sitemap(metaList) {
  const urls = metaList
    .filter(meta => meta.noindex !== true)
    .map(meta => `  <url><loc>${escapeHtml(`${origin}${meta.path}`)}</loc></url>`)
    .join('\n')
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`
}

function robots() {
  return [
    'User-agent: *',
    'Allow: /',
    'Disallow: /admin/',
    'Disallow: /v1/',
    'Disallow: /account',
    'Disallow: /login',
    'Disallow: /register',
    `Sitemap: ${origin}/sitemap.xml`,
    '',
  ].join('\n')
}

await rm(ssrDir, { recursive: true, force: true })

console.log('[portal] building client bundle')
await build({ configFile, root: portalRoot, mode: 'production', logLevel: 'warn' })

const template = await readFile(join(outDir, 'index.html'), 'utf8')
// 未预渲染路径回落到空壳，由客户端路由渲染 404。
await writeFile(join(outDir, 'shell.html'), template)

console.log('[portal] building server bundle')
await build({
  configFile,
  root: portalRoot,
  mode: 'production',
  logLevel: 'warn',
  ssr: { noExternal: true },
  build: { ssr: entry, outDir: ssrDir, emptyOutDir: true },
})

try {
  const { render, ROUTES, SITE_NAME } = await import(pathToFileURL(join(ssrDir, 'entry-server.js')).href)
  const files = { _shell: 'shell.html' }

  for (const meta of ROUTES) {
    if (!meta.prerender) continue
    const { html, styles } = render(meta.path)
    const relative = meta.path === '/' ? 'index.html' : `${meta.path.replace(/^\/+/, '')}/index.html`
    const target = join(outDir, relative)
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, inject(template, { html, styles, meta, siteName: SITE_NAME }))
    files[meta.path] = relative
    console.log(`[portal] prerendered ${meta.path}`)
  }

  await writeFile(join(outDir, 'routes.json'), `${JSON.stringify(files, null, 2)}\n`)
  await writeFile(join(outDir, 'sitemap.xml'), sitemap(ROUTES))
  await writeFile(join(outDir, 'robots.txt'), robots())
  console.log(`[portal] wrote ${Object.keys(files).length - 1} pages, sitemap and robots (origin ${origin})`)
} finally {
  await rm(ssrDir, { recursive: true, force: true })
}
