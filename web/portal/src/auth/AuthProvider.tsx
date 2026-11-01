import { useQueryClient } from '@tanstack/react-query'
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { currentUser, hasToken, logout as apiLogout, onUnauthorized } from '../api'
import type { PortalUser } from '../types'

interface AuthContextValue {
  user: PortalUser | null
  loading: boolean
  signIn: (user: PortalUser) => void
  signOut: () => Promise<void>
}

const AuthContext = createContext<AuthContextValue | null>(null)

export function AuthProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient()
  const [user, setUser] = useState<PortalUser | null>(null)
  // 首屏与预渲染保持一致（先渲染占位），拿到会话后再切换，避免水合错位。
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!hasToken()) {
      setLoading(false)
      return
    }

    let active = true
    void currentUser()
      .then(value => {
        if (active) setUser(value)
      })
      .catch(() => {
        if (active) setUser(null)
      })
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => {
      active = false
    }
  }, [])

  useEffect(() => onUnauthorized(() => {
    setUser(null)
    queryClient.clear()
  }), [queryClient])

  const value = useMemo<AuthContextValue>(() => ({
    user,
    loading,
    signIn: value => {
      setUser(value)
      setLoading(false)
    },
    signOut: async () => {
      try {
        await apiLogout()
      } finally {
        setUser(null)
        queryClient.clear()
      }
    },
  }), [user, loading, queryClient])

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth(): AuthContextValue {
  const value = useContext(AuthContext)
  if (value === null) throw new Error('useAuth must be used inside AuthProvider')
  return value
}
