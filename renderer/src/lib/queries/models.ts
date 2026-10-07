import { useQuery } from '@tanstack/react-query'
import { call } from './core'

export const useModels = (agent: 'claude' | 'opencode') =>
  useQuery({ queryKey: ['models', agent] as const, queryFn: () => call('models:list', agent), staleTime: 5 * 60 * 1000 })
