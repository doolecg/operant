import type { RunStatus } from '@shared/types'
import { cn } from '@/lib/utils'
import { RUN_STATUS_LABEL, RUN_STATUS_TONE } from './runUi'

export function RunStatusBadge({ status, className }: { status: RunStatus; className?: string }) {
  return (
    <span className={cn('text-muted-foreground inline-flex items-center gap-1.5 text-[11px]', className)}>
      <span aria-hidden className="relative inline-flex size-2">
        {status === 'working' && <span className="absolute inset-0 animate-ping rounded-full bg-emerald-400/60" />}
        <span className={cn('relative inline-flex size-2 rounded-full', RUN_STATUS_TONE[status])} />
      </span>
      {RUN_STATUS_LABEL[status]}
    </span>
  )
}
