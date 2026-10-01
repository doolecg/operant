import { useQuery } from '@tanstack/react-query'
import { call, keys, registerLive, useMutate } from './core'

export const useJobs = (crewId: number | null, open?: boolean) =>
  useQuery({ queryKey: keys.jobs(crewId ?? -1, open), queryFn: () => call('jobs:list', crewId!, open), enabled: crewId != null })

export const useJob = (jobId: number | null) =>
  useQuery({ queryKey: keys.job(jobId ?? -1), queryFn: () => call('jobs:get', jobId!), enabled: jobId != null })

const jobKeys = [['jobs'], ['job'], keys.summary, ['graph']] as const

export const useCreateJob = () => useMutate('jobs:create', jobKeys)
export const useUpdateJob = () => useMutate('jobs:update', jobKeys)
export const useDeleteJob = () => useMutate('jobs:delete', jobKeys)
export const useApproveJob = () => useMutate('jobs:approve', jobKeys)
export const useRejectJob = () => useMutate('jobs:reject', jobKeys)
export const useApproveStartJob = () => useMutate('jobs:approveStart', jobKeys)
export const useEscalateJob = () => useMutate('jobs:escalate', jobKeys)
export const useMoveJob = () => useMutate('jobs:move', jobKeys)

registerLive((b, qc) => [
  b.on('job', ({ crewId, jobId }) => {
    void qc.invalidateQueries({ queryKey: keys.jobs(crewId) })
    void qc.invalidateQueries({ queryKey: keys.job(jobId) })
    void qc.invalidateQueries({ queryKey: keys.summary })
  }),
  b.on('event', (e) => {
    if (e.crewId != null) void qc.invalidateQueries({ queryKey: keys.jobs(e.crewId) })
  }),
])
