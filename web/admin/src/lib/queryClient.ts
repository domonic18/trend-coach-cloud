import { MutationCache, QueryClient } from '@tanstack/react-query'
import { ApiError } from '../api'

export function createQueryClient(onMutationError: (message: string) => void): QueryClient {
  return new QueryClient({
    mutationCache: new MutationCache({
      onError: error => {
        if (error instanceof ApiError && error.status === 401) return
        onMutationError(error instanceof Error ? error.message : '操作失败')
      },
    }),
    defaultOptions: {
      queries: {
        staleTime: 15_000,
        refetchOnWindowFocus: false,
        retry: (count, error) => {
          if (error instanceof ApiError && error.status < 500) return false
          return count < 1
        },
      },
      mutations: { retry: false },
    },
  })
}
