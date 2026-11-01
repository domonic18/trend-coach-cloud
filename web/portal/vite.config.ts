import { fileURLToPath } from 'node:url'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

const apiTarget = process.env.PORTAL_DEV_API ?? 'http://127.0.0.1:3939'

export default defineConfig(({ isSsrBuild }) => ({
  root: fileURLToPath(new URL('.', import.meta.url)),
  base: '/',
  plugins: [react()],
  build: {
    outDir: fileURLToPath(new URL('../../dist/portal', import.meta.url)),
    emptyOutDir: true,
    chunkSizeWarningLimit: 1200,
    ...(isSsrBuild
      ? {}
      : {
        rollupOptions: {
          output: {
            manualChunks: {
              react: ['react', 'react-dom', 'react-router-dom'],
              query: ['@tanstack/react-query'],
              antd: ['antd'],
              markdown: ['react-markdown', 'remark-gfm'],
            },
          },
        },
      }),
  },
  // 预渲染时把依赖一起打包，避免 Node 对 CJS 包的具名导出探测失败。
  ...(isSsrBuild ? { ssr: { noExternal: true } } : {}),
  server: {
    port: 5174,
    proxy: {
      '/v1': { target: apiTarget, changeOrigin: true },
    },
  },
}))
