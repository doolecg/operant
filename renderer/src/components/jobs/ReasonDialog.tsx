import { useEffect, useRef, useState, type FormEvent } from 'react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Label } from '@/components/ui/label'
import { useDraftByKey } from '@/lib/drafts'
import { errorText } from './jobUi'

// Reject and escalate both need a reason.
export function ReasonDialog({
  open,
  title,
  description,
  submitLabel,
  pending,
  error,
  onSubmit,
  onClose,
  draftKey,
}: {
  open: boolean
  title: string
  description: string
  submitLabel: string
  pending: boolean
  error: unknown
  onSubmit: (reason: string) => void
  onClose: () => void
  // When set, the text is kept in the drafts store (survives closing and restarts) and cleared after a successful submit.
  draftKey?: string
}) {
  const [local, setLocal] = useState('')
  const [stored, setStored, clearStored] = useDraftByKey(draftKey ?? '')
  const reason = draftKey ? stored : local
  const setReason = draftKey ? setStored : setLocal
  useEffect(() => {
    if (open && !draftKey) setLocal('')
  }, [open, draftKey])
  const submitted = useRef(false)
  const wasPending = useRef(false)
  useEffect(() => {
    if (draftKey && wasPending.current && !pending && submitted.current && error == null) {
      clearStored()
      submitted.current = false
    }
    wasPending.current = pending
  }, [pending, error, draftKey, clearStored])
  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (reason.trim() && !pending) {
      submitted.current = true
      onSubmit(reason.trim())
    }
  }
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent size="md">
        <form onSubmit={submit}>
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            <DialogDescription>{description}</DialogDescription>
          </DialogHeader>
          <DialogBody>
            <div className="space-y-1.5">
            <Label htmlFor="job-reason">Reason</Label>
            <textarea
              id="job-reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={4}
              className="border-input bg-background focus-visible:ring-ring/50 w-full resize-y rounded-md border px-3 py-2 text-sm outline-none focus-visible:ring-[3px]"
            />
          </div>
          {error != null && <p className="text-destructive text-xs">{errorText(error)}</p>}
          </DialogBody>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={!reason.trim() || pending}>
              {submitLabel}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
