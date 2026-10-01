import type { JobRecord, Operator } from '@shared/types'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { useDeleteJob } from '@/lib/queries'
import { errorText, operatorLabel, stateLabel } from './jobUi'

export function DeleteJobDialog({
  job,
  jobs,
  operators,
  onClose,
}: {
  job: JobRecord | null
  jobs: JobRecord[]
  operators: Operator[]
  onClose: () => void
}) {
  const del = useDeleteJob()
  const dependents = job ? jobs.filter((j) => j.deps.includes(job.id)).length : 0
  const holder = job?.assigneeId != null && (job.state === 'doing' || job.state === 'review') ? operatorLabel(operators, job.assigneeId) : null
  const close = () => {
    del.reset()
    onClose()
  }
  return (
    <Dialog open={job != null} onOpenChange={(o) => !o && close()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Delete job</DialogTitle>
          <DialogDescription>
            Delete &quot;{job?.title}&quot; ({job ? stateLabel(job.state) : ''})? This cannot be undone.
          </DialogDescription>
        </DialogHeader>
        <ul className="text-muted-foreground list-disc space-y-1 pl-5 text-xs">
          {holder && <li>{holder} holds this job and will be told it was deleted.</li>}
          <li>
            {dependents === 0 ? 'No other job waits for it.' : `${dependents} other ${dependents === 1 ? 'job waits' : 'jobs wait'} for it and will be unblocked.`}
          </li>
        </ul>
        {del.error != null && <p className="text-destructive text-xs">{errorText(del.error)}</p>}
        <DialogFooter>
          <Button variant="ghost" onClick={close}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            disabled={del.isPending}
            onClick={() => job && del.mutate([job.id], { onSuccess: close })}
          >
            Delete job
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
