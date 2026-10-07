import { useQuery } from '@tanstack/react-query'
import { call, keys, registerLive, useMutate } from './core'

export const useRuns = (crewId: number | null) =>
  useQuery({ queryKey: keys.runs(crewId ?? -1), queryFn: () => call('runs:list', crewId!), enabled: crewId != null })

export const useRun = (runId: number | null) =>
  useQuery({ queryKey: keys.run(runId ?? -1), queryFn: () => call('runs:get', runId!), enabled: runId != null })

export const useRunAgents = (runId: number | null) =>
  useQuery({ queryKey: keys.runAgents(runId ?? -1), queryFn: () => call('runs:agents', runId!), enabled: runId != null })

export const useRunEvents = (runId: number | null, enabled = true) =>
  useQuery({ queryKey: ['runEvents', runId ?? -1] as const, queryFn: () => call('runs:events', runId!), enabled: enabled && runId != null })

export const useMasterState = (crewId: number | null) =>
  useQuery({
    queryKey: ['masterState', crewId ?? -1] as const,
    queryFn: () => call('master:state', crewId!),
    enabled: crewId != null,
    refetchInterval: 3000,
  })

export const useTeams = () => useQuery({ queryKey: keys.teams, queryFn: () => call('teams:list') })

export const useProjectHealth = (crewId: number | null) =>
  useQuery({ queryKey: keys.health(crewId ?? -1), queryFn: () => call('health:project', crewId!), enabled: crewId != null })

const runKeys = [['runs'], ['run'], ['runAgents'], ['runAgentLog'], ['runEvents'], ['masterState']] as const

export const useCreateRun = () => useMutate('runs:create', runKeys)
export const useStopRun = () => useMutate('runs:stop', runKeys)
export const useUpdateRun = () => useMutate('runs:update', runKeys)
export const useDeleteRun = () => useMutate('runs:delete', runKeys)
export const useApproveRun = () => useMutate('runs:approve', runKeys)
export const useSendBackRun = () => useMutate('runs:sendBack', runKeys)
export const useAnswerRun = () => useMutate('runs:answer', runKeys)
export const useCloseoutRun = () => useMutate('runs:closeout', runKeys)
export const useResumeMaster = () => useMutate('runs:resumeMaster', runKeys)

// The agent's transcript tail, re-read every 2 seconds while its job still works.
export const useRunAgentLog = (runId: number, agentId: number, live: boolean) =>
  useQuery({
    queryKey: ['runAgentLog', runId, agentId] as const,
    queryFn: () => call('runs:agentLog', runId, agentId),
    refetchInterval: live ? 2000 : false,
  })

// A pushed status change refreshes the cards, the open panel and its agent list; nothing polls.
registerLive((b, qc) => [
  b.on('run', ({ crewId, runId }) => {
    void qc.invalidateQueries({ queryKey: keys.runs(crewId) })
    void qc.invalidateQueries({ queryKey: keys.run(runId) })
    void qc.invalidateQueries({ queryKey: keys.runAgents(runId) })
    void qc.invalidateQueries({ queryKey: ['runEvents', runId] })
  }),
  b.on('run:agents', ({ runId }) => {
    void qc.invalidateQueries({ queryKey: keys.runAgents(runId) })
  }),
])
