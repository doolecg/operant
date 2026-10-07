import type { RunStatus, RunWaiting } from '@shared/types'
import { cn } from '@/lib/utils'
import { RUN_STATUS_TONE, runLabel } from './runUi'

// A coloured dot with the state's label. Needs-you and review get a ring and a bolder label so they stand out.
export function RunStatusBadge({ status, waiting = '', className }: { status: RunStatus; waiting?: RunWaiting | ''; className?: string }) {
  const attention = status === 'needs-you' || status === 'review'
  return (
    <span
      className={cn(
        'text-muted-foreground inline-flex items-center gap-1.5 text-xs',
        attention && 'text-foreground rounded-full px-2 py-0.5 font-medium ring-2',
        status === 'needs-you' && 'ring-amber-400/70',
        status === 'review' && 'ring-violet-400/70',
        className,
      )}
    >
      <span aria-hidden className="relative inline-flex size-2">
        {(status === 'working' || attention) && (
          <span className={cn('absolute inset-0 animate-ping rounded-full', status === 'working' ? 'bg-emerald-400/60' : status === 'review' ? 'bg-violet-400/60' : 'bg-amber-400/60')} />
        )}
        <span className={cn('relative inline-flex size-2 rounded-full', RUN_STATUS_TONE[status])} />
      </span>
      {runLabel(status, waiting)}
    </span>
  )
}
