import { useState, type FormEvent, type ReactNode } from 'react'
import type { JobRecord, JobReview, JobState, JobUpdate } from '@shared/types'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Markdown } from '@/components/ui/markdown'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { useUpdateJob } from '@/lib/queries'
import { STATES, clock, errorText, leaseText, operatorLabel, stateLabel } from './jobUi'

const NONE = '__none'
const REVIEWS: Array<{ value: JobReview; label: string }> = [
  { value: 'none', label: 'No review' },
  { value: 'pm', label: 'PM reviews' },
  { value: 'operator', label: 'An operator reviews' },
  { value: 'user', label: 'You review' },
]

const fieldClass =
  'border-input bg-background focus-visible:ring-ring/50 w-full resize-y rounded-md border px-3 py-2 text-sm outline-none focus-visible:ring-[3px]'

function Preview({ label, source }: { label: string; source: string }) {
  return (
    <div role="group" aria-label={label} className="bg-muted/30 mt-1.5 max-h-48 overflow-y-auto rounded-md border p-2" tabIndex={0}>
      <Markdown source={source} className="text-xs" />
    </div>
  )
}

function Field({ id, label, children }: { id: string; label: string; children: ReactNode }) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      {children}
    </div>
  )
}

interface Draft {
  title: string
  body: string
  priority: string
  assigneeId: number | null
  estimate: string
  review: JobReview
  reviewerId: number | null
  state: JobState
  note: string
  deps: number[]
}

const draftOf = (j: JobRecord): Draft => ({
  title: j.title,
  body: j.body,
  priority: String(j.priority),
  assigneeId: j.assigneeId,
  estimate: j.estimateMinutes == null ? '' : String(j.estimateMinutes),
  review: j.review,
  reviewerId: j.reviewerId,
  state: j.state,
  note: j.note,
  deps: [...j.deps],
})

export function JobSheet({
  job,
  jobs,
  onClose,
}: {
  job: JobRecord | null
  jobs: JobRecord[]
  onClose: () => void
}) {
  return (
    <Sheet open={job != null} onOpenChange={(o) => !o && onClose()}>
      <SheetContent className="w-full overflow-y-auto sm:max-w-lg">
        {job && <JobForm key={job.id} job={job} jobs={jobs} onClose={onClose} />}
      </SheetContent>
    </Sheet>
  )
}

// Edits a snapshot of the job taken when the sheet opens, so a push never overwrites what is being typed.
function JobForm({ job, jobs, onClose }: { job: JobRecord; jobs: JobRecord[]; onClose: () => void }) {
  const [d, setD] = useState<Draft>(() => draftOf(job))
  const update = useUpdateJob()
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setD((p) => ({ ...p, [k]: v }))
  const live = jobs.find((j) => j.id === job.id) ?? job
  const lease = leaseText(live)
  const creator = live.createdBy == null ? 'the user or the Master Terminal' : operatorLabel(live.createdBy)

  const priority = Number(d.priority)
  const estimate = d.estimate.trim() === '' ? null : Number(d.estimate)
  const valid =
    d.title.trim() !== '' &&
    d.priority.trim() !== '' &&
    Number.isInteger(priority) &&
    (estimate === null || (Number.isInteger(estimate) && estimate > 0)) &&
    (d.review !== 'operator' || d.reviewerId != null)

  const save = (e: FormEvent) => {
    e.preventDefault()
    if (!valid || update.isPending) return
    const patch: JobUpdate = {}
    if (d.title.trim() !== job.title) patch.title = d.title.trim()
    if (d.body !== job.body) patch.body = d.body
    if (priority !== job.priority) patch.priority = priority
    if (estimate !== job.estimateMinutes) patch.estimateMinutes = estimate
    if (d.review !== job.review) patch.review = d.review
    const reviewerId = d.review === 'operator' ? d.reviewerId : null
    if (reviewerId !== job.reviewerId) patch.reviewerId = reviewerId
    if (d.note !== job.note) patch.note = d.note
    if (d.state !== job.state) patch.state = d.state
    if (d.assigneeId !== job.assigneeId) patch.assigneeId = d.assigneeId
    if (d.deps.length !== job.deps.length || d.deps.some((x) => !job.deps.includes(x))) patch.deps = d.deps
    if (Object.keys(patch).length === 0) return onClose()
    update.mutate([job.id, patch], { onSuccess: onClose })
  }

  const candidates = jobs.filter((j) => j.id !== job.id && (j.state !== 'done' || d.deps.includes(j.id)))
  const toggleDep = (id: number, on: boolean) => set('deps', on ? [...d.deps, id] : d.deps.filter((x) => x !== id))

  return (
    <form onSubmit={save} className="flex min-h-0 flex-1 flex-col">
      <SheetHeader>
        <SheetTitle>Edit job #{job.id}</SheetTitle>
        <SheetDescription>
          Created by {creator}
          {live.assigneeId != null && ` · claimed by ${operatorLabel(live.assigneeId)}`}
          {lease && ` · ${lease}`}
          {live.startedAt != null && ` · started ${clock(live.startedAt)}`}
        </SheetDescription>
      </SheetHeader>
      <div className="flex-1 space-y-4 px-4">
        {live.escalation && (
          <p className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs">Needs you: {live.escalation}</p>
        )}
        {live.blocked && <p className="text-muted-foreground text-xs">Blocked: a job this one depends on is not done.</p>}
        <Field id="job-title" label="Title">
          <Input id="job-title" value={d.title} onChange={(e) => set('title', e.target.value)} maxLength={200} />
        </Field>
        <Field id="job-body" label="Body">
          <textarea id="job-body" value={d.body} onChange={(e) => set('body', e.target.value)} rows={5} className={fieldClass} />
          {d.body.trim() && <Preview label="Rendered body" source={d.body} />}
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field id="job-priority" label="Priority">
            <Input id="job-priority" type="number" min={-1000} max={1000} value={d.priority} onChange={(e) => set('priority', e.target.value)} />
          </Field>
          <Field id="job-estimate" label="Estimate (minutes)">
            <Input id="job-estimate" type="number" min={1} value={d.estimate} onChange={(e) => set('estimate', e.target.value)} placeholder="none" />
          </Field>
          <Field id="job-state" label="State">
            <Select value={d.state} onValueChange={(v) => set('state', v as JobState)}>
              <SelectTrigger id="job-state" className="w-full" aria-label="State">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {STATES.map((s) => (
                  <SelectItem key={s.state} value={s.state}>
                    {s.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field id="job-assignee" label="Assignee">
            <Select value={d.assigneeId == null ? NONE : String(d.assigneeId)} onValueChange={(v) => set('assigneeId', v === NONE ? null : Number(v))}>
              <SelectTrigger id="job-assignee" className="w-full" aria-label="Assignee">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NONE}>Unassigned</SelectItem>
                {job.assigneeId != null && <SelectItem value={String(job.assigneeId)}>{operatorLabel(job.assigneeId)}</SelectItem>}
              </SelectContent>
            </Select>
          </Field>
          <Field id="job-review" label="Review mode">
            <Select value={d.review} onValueChange={(v) => set('review', v as JobReview)}>
              <SelectTrigger id="job-review" className="w-full" aria-label="Review mode">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {REVIEWS.map((r) => (
                  <SelectItem key={r.value} value={r.value}>
                    {r.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          {d.review === 'operator' && (
            <Field id="job-reviewer" label="Reviewer">
              <Select value={d.reviewerId == null ? NONE : String(d.reviewerId)} onValueChange={(v) => set('reviewerId', v === NONE ? null : Number(v))}>
                <SelectTrigger id="job-reviewer" className="w-full" aria-label="Reviewer">
                  <SelectValue placeholder="Pick an operator" />
                </SelectTrigger>
                <SelectContent>
                  {job.reviewerId != null && <SelectItem value={String(job.reviewerId)}>{operatorLabel(job.reviewerId)}</SelectItem>}
                </SelectContent>
              </Select>
            </Field>
          )}
        </div>
        <fieldset className="space-y-1.5">
          <legend className="mb-1.5 text-sm font-medium">Waits for</legend>
          {candidates.length === 0 && <p className="text-muted-foreground text-xs">No other jobs.</p>}
          {candidates.length > 0 && (
            <div className="max-h-40 space-y-1 overflow-y-auto rounded-md border p-2">
              {candidates.map((j) => (
                <label key={j.id} className="flex items-center gap-2 text-xs">
                  <input
                    type="checkbox"
                    checked={d.deps.includes(j.id)}
                    onChange={(e) => toggleDep(j.id, e.target.checked)}
                    aria-label={`Waits for job ${j.id}: ${j.title}`}
                  />
                  <span className="truncate">
                    #{j.id} {j.title}
                  </span>
                  <span className="text-muted-foreground ml-auto shrink-0">{stateLabel(j.state)}</span>
                </label>
              ))}
            </div>
          )}
        </fieldset>
        <Field id="job-note" label="Notes">
          <textarea id="job-note" value={d.note} onChange={(e) => set('note', e.target.value)} rows={3} className={fieldClass} />
          {d.note.trim() && <Preview label="Rendered notes" source={d.note} />}
        </Field>
        {update.error != null && (
          <p role="alert" className="text-destructive text-xs">
            {errorText(update.error)}
          </p>
        )}
      </div>
      <SheetFooter className="flex-row justify-end">
        <Button type="button" variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button type="submit" disabled={!valid || update.isPending}>
          Save
        </Button>
      </SheetFooter>
    </form>
  )
}
