import { markdownToPlain } from '@shared/markdown'
import type { Run } from '@shared/types'
import { LastProgress, RunCardActions } from '@/components/jobs/RunGrid'
import { runLabel } from '@/components/jobs/runUi'
import { timeAgo } from '@/lib/format'
import { cn } from '@/lib/utils'

const EDGE: Record<Run['status'], string> = {
  queued: 'border-l-zinc-400',
  working: 'border-l-emerald-400',
  'needs-you': 'border-l-amber-400',
  review: 'border-l-violet-400',
  done: 'border-l-sky-400',
  failed: 'border-l-destructive',
}

// One job on the board: opens the task modal. Stop / edit / delete sit under it, as they did on the old job cards.
export function TaskCard({ run, onOpen, onDeleted }: { run: Run; onOpen: (run: Run) => void; onDeleted?: (runId: number) => void }) {
  const seats = run.seats.reduce((n, s) => n + s.count, 0)
  const showLabel = run.status === 'needs-you' || run.status === 'failed'
  return (
    <li data-run-card={run.id} data-status={run.status} className={cn('bg-card rounded-lg border border-l-4 shadow-xs', EDGE[run.status])}>
      <button
        type="button"
        onClick={() => onOpen(run)}
        aria-label={`Open JOB#${run.id}`}
        className="hover:bg-accent/40 focus-visible:ring-ring block w-full space-y-2 rounded-t-lg p-3 text-left outline-none transition-colors focus-visible:ring-2"
      >
        <div className="flex items-center justify-between gap-2">
          <span className="font-mono text-xs font-semibold">JOB#{run.id}</span>
          {showLabel && <span className="text-muted-foreground text-[11px] font-medium">{runLabel(run.status, run.waiting)}</span>}
        </div>
        <p className="line-clamp-3 text-sm leading-snug break-words">{markdownToPlain(run.task, 200)}</p>
        {run.status === 'needs-you' && run.waiting === 'question' && run.question && (
          <p className="line-clamp-2 text-xs font-medium break-words">{markdownToPlain(run.question, 160)}</p>
        )}
        {run.status === 'working' && <LastProgress run={run} />}
        {run.outcome && (run.status === 'done' || run.status === 'failed') && (
          <p className="text-muted-foreground line-clamp-2 text-xs break-words">{markdownToPlain(run.outcome, 160)}</p>
        )}
        <p className="text-muted-foreground font-mono text-[10px]">
          {run.masterCli} · {seats > 0 ? `${seats} seats` : 'solo'} · {timeAgo(run.createdAt)}
        </p>
      </button>
      <div className="px-3 pb-3">
        <RunCardActions run={run} onDeleted={onDeleted} />
      </div>
    </li>
  )
}
