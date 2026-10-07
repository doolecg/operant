import { useMemo, useState, type FormEvent } from 'react'
import { Plus } from 'lucide-react'
import type { JobRecord } from '@shared/types'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { ScrollArea } from '@/components/ui/scroll-area'
import { DeleteJobDialog } from '@/components/jobs/DeleteJobDialog'
import { JobCard, type JobActions } from '@/components/jobs/JobCard'
import { JobSheet } from '@/components/jobs/JobSheet'
import { ReasonDialog } from '@/components/jobs/ReasonDialog'
import { STATES, errorText } from '@/components/jobs/jobUi'
import {
  useApproveJob,
  useApproveStartJob,
  useCreateJob,
  useEscalateJob,
  useJobs,
  useMoveJob,
  useRejectJob,
} from '@/lib/queries'

// Tab badge: jobs that are not done.
export function useJobsBadge(crewId: number | null): number | undefined {
  const jobs = useJobs(crewId)
  return jobs.data?.filter((j) => j.state !== 'done').length
}

type Reasoning = { kind: 'reject' | 'escalate'; jobId: number }

export function JobsPanel({ crewId }: { crewId: number }) {
  const jobsQuery = useJobs(crewId)
  const jobs = useMemo(() => jobsQuery.data ?? [], [jobsQuery.data])
  const [title, setTitle] = useState('')
  const [sheetId, setSheetId] = useState<number | null>(null)
  const [deleteId, setDeleteId] = useState<number | null>(null)
  const [reasoning, setReasoning] = useState<Reasoning | null>(null)
  const create = useCreateJob()
  const approve = useApproveJob()
  const reject = useRejectJob()
  const approveStart = useApproveStartJob()
  const escalate = useEscalateJob()
  const move = useMoveJob()

  const byId = (id: number | null): JobRecord | null => (id == null ? null : (jobs.find((j) => j.id === id) ?? null))
  const held = jobs.filter((j) => j.state === 'held')
  const actionError = approve.error ?? approveStart.error ?? move.error

  const actions: JobActions = {
    open: (j) => setSheetId(j.id),
    approve: (j) => approve.mutate([j.id]),
    reject: (j) => setReasoning({ kind: 'reject', jobId: j.id }),
    approveStart: (j) => approveStart.mutate([j.id]),
    escalate: (j) => setReasoning({ kind: 'escalate', jobId: j.id }),
    remove: (j) => setDeleteId(j.id),
    move: (j, state) => move.mutate([j.id, { state }]),
    reassign: (j, assigneeId) => move.mutate([j.id, { assigneeId }]),
  }

  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (!title.trim() || crewId == null) return
    create.mutate([{ crewId, title: title.trim() }], { onSuccess: () => setTitle('') })
  }

  const reasonMutation = reasoning?.kind === 'reject' ? reject : escalate
  const closeReason = () => {
    reject.reset()
    escalate.reset()
    setReasoning(null)
  }

  return (
    <ScrollArea className="h-full">
      <div className="space-y-4 p-3">
        <form onSubmit={submit} className="flex gap-2">
          <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Add a job…" aria-label="New job title" className="h-8" />
          <Button size="icon" className="size-8 shrink-0" type="submit" aria-label="Add job">
            <Plus />
          </Button>
        </form>
        {create.error != null && <p className="text-destructive text-xs">{errorText(create.error)}</p>}
        {actionError != null && (
          <p role="alert" className="text-destructive text-xs">
            {errorText(actionError)}
          </p>
        )}

        {held.length > 0 && (
          <div role="status" className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs">
            {held.length === 1 ? '1 job is held and needs you.' : `${held.length} jobs are held and need you.`} Approve a long job to start it, or edit
            or delete it.
          </div>
        )}

        {STATES.map(({ state, label }) => {
          const list = jobs.filter((j) => j.state === state)
          if (list.length === 0 && (state === 'done' || state === 'held')) return null
          return (
            <section key={state} aria-label={label}>
              <div className="text-muted-foreground mb-1.5 flex items-center gap-2 text-[11px] font-medium tracking-wider uppercase">
                {label} <span className="tabular-nums">{list.length}</span>
              </div>
              <div className="space-y-1">
                {list.map((j) => (
                  <JobCard key={j.id} job={j} actions={actions} />
                ))}
                {list.length === 0 && <div className="text-muted-foreground/60 px-2 text-xs">—</div>}
              </div>
            </section>
          )
        })}
      </div>

      <JobSheet job={byId(sheetId)} jobs={jobs} onClose={() => setSheetId(null)} />
      <DeleteJobDialog job={byId(deleteId)} jobs={jobs} onClose={() => setDeleteId(null)} />
      <ReasonDialog
        open={reasoning != null}
        title={reasoning?.kind === 'reject' ? 'Reject job' : 'Escalate job'}
        description={
          reasoning?.kind === 'reject'
            ? 'The job goes back to doing with this reason as its note, and the assignee is told.'
            : 'The job moves to you for review; the Master Terminal is told.'
        }
        submitLabel={reasoning?.kind === 'reject' ? 'Reject' : 'Escalate'}
        pending={reasonMutation.isPending}
        error={reasonMutation.error}
        onClose={closeReason}
        onSubmit={(reason) => {
          if (!reasoning) return
          reasonMutation.mutate([reasoning.jobId, reason], { onSuccess: closeReason })
        }}
      />
    </ScrollArea>
  )
}
