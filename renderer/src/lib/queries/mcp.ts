import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { McpOverview, McpServerInput, OptionalMcpId, OptionalMcpTarget } from '@shared/types'
import { call } from './core'

const listKey = (crewId: number | null) => ['mcp', 'list', crewId] as const

// The servers for a project's folder (null = user level only); the first read also runs the status checks.
export const useMcpServers = (crewId: number | null) =>
  useQuery({ queryKey: listKey(crewId), queryFn: () => call('mcp:list', crewId), staleTime: 30_000 })

function useMcpMutation<A extends unknown[]>(crewId: number | null, fn: (...args: A) => Promise<McpOverview>) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (args: A) => fn(...args),
    onSuccess: (overview) => {
      qc.setQueryData(listKey(crewId), overview)
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

// Optional integrations (Git MCP, Playwright MCP): their status and the Add and Remove actions.
export const useOptionalMcp = (crewId: number | null) =>
  useQuery({ queryKey: ['mcp', 'optional', crewId], queryFn: () => call('mcp:optional', crewId), staleTime: 30_000 })

// Runs the optional integrations' checks again (the runtime probe is cached for a few minutes).
export function useRecheckOptionalMcp(crewId: number | null) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: () => call('mcp:optional', crewId, true),
    onSuccess: (entries) => {
      qc.setQueryData(['mcp', 'optional', crewId], entries)
    },
  })
}

export function useAddOptionalMcp(crewId: number | null) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (args: { id: OptionalMcpId; targets: OptionalMcpTarget[] }) => call('mcp:optionalAdd', crewId, args.id, args.targets),
    onSuccess: (overview) => {
      qc.setQueryData(listKey(crewId), overview)
      void qc.invalidateQueries({ queryKey: ['mcp', 'optional'] })
    },
  })
}

export function useRemoveOptionalMcp(crewId: number | null) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: OptionalMcpId) => call('mcp:optionalRemove', crewId, id),
    onSuccess: (overview) => {
      qc.setQueryData(listKey(crewId), overview)
      void qc.invalidateQueries({ queryKey: ['mcp', 'optional'] })
    },
  })
}
