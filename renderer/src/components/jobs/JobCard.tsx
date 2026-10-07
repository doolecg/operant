import { Lock, MoreHorizontal } from 'lucide-react'
import type { JobRecord, JobState } from '@shared/types'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { STATES, leaseText, operatorLabel } from './jobUi'

export interface JobActions {
  open: (job: JobRecord) => void
  approve: (job: JobRecord) => void
  reject: (job: JobRecord) => void
  approveStart: (job: JobRecord) => void
  escalate: (job: JobRecord) => void
  remove: (job: JobRecord) => void
  move: (job: JobRecord, state: JobState) => void
  reassign: (job: JobRecord, assigneeId: number | null) => void
}

export function JobCard({ job, actions }: { job: JobRecord; actions: JobActions }) {
  const meta = [
    job.assigneeId != null ? `claimed by ${operatorLabel(job.assigneeId)}` : null,
    job.createdBy != null ? `from ${operatorLabel(job.createdBy)}` : null,
    leaseText(job),
    job.estimateMinutes != null ? `${job.estimateMinutes} min` : null,
  ].filter(Boolean)
  return (
    <div className="bg-card group rounded-md border px-2.5 py-1.5">
      <div className="flex items-start gap-2">
        <button type="button" onClick={() => actions.open(job)} className="min-w-0 flex-1 text-left" aria-label={`Edit job ${job.title}`}>
          <div className={job.state === 'done' ? 'text-muted-foreground truncate text-xs line-through' : 'truncate text-xs'}>{job.title}</div>
          {meta.length > 0 && <div className="text-muted-foreground truncate font-mono text-[10px]">{meta.join(' · ')}</div>}
        </button>
        {job.blocked && (
          <Badge variant="outline" className="shrink-0 gap-1 px-1.5 py-0 text-[10px]" title="Waiting for another job">
            <Lock /> blocked
          </Badge>
        )}
        {job.priority !== 0 && (
          <Badge variant="secondary" className="shrink-0 px-1.5 py-0 text-[10px]" title="Priority">
            P{job.priority}
          </Badge>
        )}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon" className="size-6 shrink-0 opacity-60 group-hover:opacity-100" aria-label={`Actions for ${job.title}`}>
              <MoreHorizontal className="size-3.5" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onSelect={() => actions.open(job)}>Edit</DropdownMenuItem>
            {job.state !== 'done' && <DropdownMenuItem onSelect={() => actions.escalate(job)}>Escalate to you</DropdownMenuItem>}
            <DropdownMenuSeparator />
            <DropdownMenuLabel className="text-xs">Move to</DropdownMenuLabel>
            {STATES.filter((s) => s.state !== job.state).map((s) => (
              <DropdownMenuItem key={s.state} onSelect={() => actions.move(job, s.state)}>
                {s.label}
              </DropdownMenuItem>
            ))}
            <DropdownMenuSeparator />
            <DropdownMenuLabel className="text-xs">Assign to</DropdownMenuLabel>
            <DropdownMenuItem onSelect={() => actions.reassign(job, null)} disabled={job.assigneeId == null}>
              Unassigned
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive" onSelect={() => actions.remove(job)}>
              Delete
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      {job.escalation && job.state !== 'done' && <div className="mt-1 text-[11px] text-amber-400">Needs you: {job.escalation}</div>}
      {job.state === 'review' && (
        <div className="mt-1.5 flex gap-1.5">
          <Button size="sm" className="h-6 px-2 text-[11px]" onClick={() => actions.approve(job)} aria-label={`Approve ${job.title}`}>
            Approve
          </Button>
          <Button size="sm" variant="outline" className="h-6 px-2 text-[11px]" onClick={() => actions.reject(job)} aria-label={`Reject ${job.title}`}>
            Reject
          </Button>
        </div>
      )}
      {job.state === 'held' && (
        <div className="mt-1.5 flex gap-1.5">
          <Button size="sm" className="h-6 px-2 text-[11px]" onClick={() => actions.approveStart(job)} aria-label={`Approve to start ${job.title}`}>
            Approve to start
          </Button>
        </div>
      )}
    </div>
  )
}
