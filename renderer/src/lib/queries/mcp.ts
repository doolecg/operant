import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { McpOverview, McpServerInput } from '@shared/types'
import { call } from './core'

const listKey = (crewId: number | null) => ['mcp', 'list', crewId] as const

// The servers for a project's folder (null = user level only); the first read also runs the status checks.
export const useMcpServers = (crewId: number | null) =>
  useQuery({ queryKey: listKey(crewId), queryFn: () => call('mcp:list', crewId), staleTime: 30_000 })

// Servers a team seat needs that are down, for the header badge. Re-checked about once a minute.
export const useMcpHealth = () =>
  useQuery({ queryKey: ['mcp', 'health'], queryFn: () => call('mcp:health'), refetchInterval: 60_000, retry: false })

function useMcpMutation<A extends unknown[]>(crewId: number | null, fn: (...args: A) => Promise<McpOverview>) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (args: A) => fn(...args),
    onSuccess: (overview) => {
      qc.setQueryData(listKey(crewId), overview)
      void qc.invalidateQueries({ queryKey: ['mcp', 'health'] })
    },
  })
}

export const useRefreshMcp = (crewId: number | null) => useMcpMutation(crewId, () => call('mcp:list', crewId, true))
export const useAddMcp = (crewId: number | null) => useMcpMutation(crewId, (input: McpServerInput) => call('mcp:add', crewId, input))
export const useUpdateMcp = (crewId: number | null) =>
  useMcpMutation(crewId, (id: string, input: McpServerInput) => call('mcp:update', crewId, id, input))
export const useSetMcpEnabled = (crewId: number | null) =>
  useMcpMutation(crewId, (id: string, enabled: boolean) => call('mcp:setEnabled', crewId, id, enabled))
export const useRemoveMcp = (crewId: number | null) => useMcpMutation(crewId, (id: string) => call('mcp:remove', crewId, id))
