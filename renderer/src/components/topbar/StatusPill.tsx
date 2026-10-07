import { agentCounts } from '@shared/media'
import { healthBadges } from '@/components/dashboard/HealthBadges'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useProjectHealth, useRuns } from '@/lib/queries'
import { cn } from '@/lib/utils'
import { pill } from './pill'

const DOTS = [
  { key: 'running', color: 'bg-emerald-400', label: 'running' },
  { key: 'idle', color: 'bg-zinc-400', label: 'idle' },
  { key: 'done', color: 'bg-sky-400', label: 'done' },
] as const
const TONE = { ok: 'bg-emerald-400', warn: 'bg-amber-400', bad: 'bg-red-500' } as const

// The one status pill: running, idle and done jobs of the open project, Memory (CodeGraph and Hindsight health in one
// dot) and, only when something waits for the user, a "needs you" chip. `labels` off leaves just dots and numbers.
export function StatusPill({ crewId, jobs, labels }: { crewId: number | null; jobs: boolean; labels: boolean }) {
  const runs = useRuns(crewId)
  const health = useProjectHealth(crewId).data
  const c = agentCounts(runs.data ?? [], new Date().setHours(0, 0, 0, 0))
  const parts = health ? healthBadges(health) : []
  const tone = parts.length === 0 ? null : parts.every((b) => b.tone === 'ok') ? 'ok' : parts.every((b) => b.tone === 'bad') ? 'bad' : 'warn'
  const jobsText = `${c.running} running, ${c.idle} idle, ${c.done} done today, ${c.waiting} waiting for you`
  const memoryText = parts.map((b) => b.label).join(', ')
  return (
    <div role="group" aria-label="Status" className={cn(pill, 'gap-2.5')}>
      {jobs && (
        <Tooltip>
          <TooltipTrigger asChild>
            <span role="status" aria-label={`Jobs: ${jobsText}`} className="flex items-center gap-2.5">
              {DOTS.map((d) => (
                <span key={d.key} className="flex items-center gap-1">
                  <span aria-hidden className={`${d.color} size-1.5 rounded-full`} />
                  {labels && <span className="text-muted-foreground text-[10px]">{d.label}</span>}
                  <span className="font-mono tabular-nums">{c[d.key]}</span>
                </span>
              ))}
            </span>
          </TooltipTrigger>
          <TooltipContent>{jobsText}</TooltipContent>
        </Tooltip>
      )}
      {tone && (
        <Tooltip>
          <TooltipTrigger asChild>
            <span tabIndex={0} aria-label={`Memory: ${memoryText}`} className="flex items-center gap-1 outline-none">
              <span aria-hidden className={`${TONE[tone]} size-1.5 rounded-full`} />
              {labels ? <span className="text-[10px]">Memory</span> : <span className="sr-only">Memory</span>}
            </span>
          </TooltipTrigger>
          <TooltipContent className="max-w-xs">
            <ul className="space-y-0.5">
              {parts.map((b) => (
                <li key={b.id}>{b.label}</li>
              ))}
            </ul>
          </TooltipContent>
        </Tooltip>
      )}
      {c.waiting > 0 && <span className="rounded-full bg-amber-400/15 px-1.5 text-[10px] font-medium text-amber-400">needs you {c.waiting}</span>}
    </div>
  )
}
