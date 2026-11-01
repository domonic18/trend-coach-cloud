import { QueryClientProvider } from '@tanstack/react-query'
import { App as AntApp, ConfigProvider, theme as antdTheme } from 'antd'
import zhCN from 'antd/locale/zh_CN'
import { useState } from 'react'
import { RouterProvider } from 'react-router-dom'
import { AuthProvider } from './auth/AuthProvider'
import { createQueryClient } from './lib/queryClient'
import { router } from './router'
import { ThemeProvider, useTheme } from './theme'

function themeConfig(mode: 'dark' | 'light') {
  const dark = mode === 'dark'
  return {
    algorithm: dark ? antdTheme.darkAlgorithm : antdTheme.defaultAlgorithm,
    token: {
      colorPrimary: '#5e6ad2',
      colorBgBase: dark ? '#0c0e12' : '#f4f6fa',
      colorBgContainer: dark ? '#111318' : '#ffffff',
      colorBgElevated: dark ? '#171a22' : '#ffffff',
      colorBorder: dark ? '#2a2e39' : '#e2e8f0',
      colorBorderSecondary: dark ? '#20242e' : '#edf1f7',
      borderRadius: 8,
    },
    components: {
      Layout: {
        siderBg: dark ? '#0f1117' : '#ffffff',
        headerBg: dark ? '#0f1117' : '#ffffff',
        bodyBg: dark ? '#0c0e12' : '#f4f6fa',
      },
      Menu: {
        darkItemBg: 'transparent',
        darkSubMenuItemBg: 'transparent',
        itemMarginInline: 8,
        itemHeight: 40,
      },
      Table: {
        headerBg: dark ? '#151821' : '#f8fafc',
        headerColor: dark ? '#cbd5e1' : '#475569',
      },
      Card: {
        colorBgContainer: dark ? '#111318' : '#ffffff',
      },
    },
  }
}

function Providers() {
  const { message } = AntApp.useApp()
  const [queryClient] = useState(() => createQueryClient(text => {
    void message.error(text)
  }))

  return (
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <RouterProvider router={router} />
      </AuthProvider>
    </QueryClientProvider>
  )
}

function ThemedApp() {
  const { mode } = useTheme()
  return (
    <ConfigProvider locale={zhCN} theme={themeConfig(mode)}>
      <AntApp>
        <Providers />
      </AntApp>
    </ConfigProvider>
  )
}

export function App() {
  return (
    <ThemeProvider>
      <ThemedApp />
    </ThemeProvider>
  )
}
