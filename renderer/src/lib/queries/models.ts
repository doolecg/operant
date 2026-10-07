import { useCallback, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { call } from './core'

const key = (agent: 'claude' | 'opencode') => ['models', agent] as const

export const useModels = (agent: 'claude' | 'opencode') =>
  useQuery({ queryKey: key(agent), queryFn: () => call('models:list', agent), staleTime: 5 * 60 * 1000 })

// Asks the core to rebuild the catalogue (skipping its cache) and puts the answer in every selector's data.
export function useRefreshModels(agent: 'claude' | 'opencode') {
  const client = useQueryClient()
  const [refreshing, setRefreshing] = useState(false)
  const refresh = useCallback(async () => {
    setRefreshing(true)
    try {
      client.setQueryData(key(agent), await call('models:list', agent, true))
    } catch {
      await client.invalidateQueries({ queryKey: key(agent) })
    } finally {
      setRefreshing(false)
    }
  }, [agent, client])
  return { refresh, refreshing }
}
