import type { OperatorStatus } from '@shared/types'
import { cn } from '@/lib/utils'

const tone: Record<OperatorStatus, string> = {
  running: 'bg-emerald-400',
  starting: 'bg-amber-400',
  idle: 'bg-sky-400',
  error: 'bg-red-500',
  stopped: 'bg-zinc-600',
}

export function StatusDot({ status, className }: { status: OperatorStatus; className?: string }) {
  return (
    <span className={cn('relative inline-flex size-2.5 shrink-0', className)}>
      {status === 'running' && <span className="absolute inset-0 animate-ping rounded-full bg-emerald-400/60" />}
      <span className={cn('relative inline-flex size-2.5 rounded-full', tone[status])} />
    </span>
  )
}
