import { useEffect, useState, type FormEvent } from 'react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Label } from '@/components/ui/label'
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
}: {
  open: boolean
  title: string
  description: string
  submitLabel: string
  pending: boolean
  error: unknown
  onSubmit: (reason: string) => void
  onClose: () => void
}) {
  const [reason, setReason] = useState('')
  useEffect(() => {
    if (open) setReason('')
  }, [open])
  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (reason.trim() && !pending) onSubmit(reason.trim())
  }
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        <form onSubmit={submit} className="space-y-4">
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            <DialogDescription>{description}</DialogDescription>
          </DialogHeader>
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
