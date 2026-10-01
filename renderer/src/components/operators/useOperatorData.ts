import type { CapProgress, Job, Operator, OperatorContext, OperatorUsage, Preset } from '@shared/types'
import { useCapStatus, useJobs, useOperatorContexts, usePresets, useSettings, useUnread, useUsageBreakdown } from '@/lib/queries'

export interface OperatorExtras {
  preset?: Preset
  job?: Job
  unread: number
  cap?: CapProgress
  usage?: OperatorUsage
  context?: OperatorContext
}

// What the card and the list row show besides the operator itself. Everything refreshes from push events.
export function useOperatorData(crewId: number) {
  const jobs = useJobs(crewId)
  const contexts = useOperatorContexts()
  const presets = usePresets()
  const unread = useUnread(crewId)
  const caps = useCapStatus()
  const usage = useUsageBreakdown(crewId, '24h')
  const settings = useSettings()

  const extras = (o: Operator): OperatorExtras => ({
    preset: presets.data?.find((p) => p.id === o.presetId),
    job: jobs.data?.find((j) => j.assigneeId === o.id && j.state === 'doing'),
    unread: unread.data?.operators[o.id] ?? 0,
    cap: caps.data?.operators[o.id],
    usage: usage.data?.operators.find((u) => u.operatorId === o.id),
    context: contexts.data?.[o.id],
  })

  return { extras, jobs: jobs.data ?? [], presets: presets.data ?? [], unreadMaster: unread.data?.master ?? 0, capWarnPct: settings.data?.tokens.capWarnPct ?? 80 }
}
