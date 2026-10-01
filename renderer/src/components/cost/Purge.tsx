import { useState } from 'react'
import { decodeIpcError } from '@shared/ipc'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { usePurgeNow, usePurgeStatus } from '@/lib/queries'

export function PurgeLine() {
  const status = usePurgeStatus()
  const purge = usePurgeNow()
  const [confirm, setConfirm] = useState(false)
  const s = status.data
  if (!s) return null
  const kept = s.candidates.length
  const eligible = s.candidates.filter((c) => c.eligible).length
  const blocked = s.candidates.filter((c) => !c.eligible)
  const last = purge.data
  return (
    <section aria-label="Purge status" className="bg-card flex flex-wrap items-center gap-3 rounded-lg border px-3.5 py-2.5 text-xs">
      <div className="min-w-0 flex-1">
        <span className="font-medium">
          {kept} deleted operator{kept === 1 ? '' : 's'} kept
        </span>
        <span className="text-muted-foreground">
          {' '}
          for their spend and history.{' '}
          {s.enabled ? `Purged after ${s.retentionDays} days; ${eligible} eligible now.` : 'Automatic purge is off.'}
          {blocked.length > 0 && ` ${blocked.length} held back by open jobs or unread messages.`}
        </span>
        {last && last.length > 0 && (
          <div className="text-muted-foreground mt-0.5">
            Last purge: {last.filter((o) => o.purged).length} of {last.length} removed.
          </div>
        )}
        {purge.error && (
          <div role="alert" className="text-destructive mt-0.5">
            {decodeIpcError(purge.error).message}
          </div>
        )}
      </div>
      <Button size="sm" variant="outline" disabled={eligible === 0 || purge.isPending} onClick={() => setConfirm(true)}>
        Purge now
      </Button>
      <Dialog open={confirm} onOpenChange={setConfirm}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Purge deleted operators</DialogTitle>
            <DialogDescription>
              This permanently removes {eligible} deleted operator{eligible === 1 ? '' : 's'} and their messages and transcripts.
              Their spend stays in the totals as an archive. Operators held by open jobs or unread messages are skipped.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirm(false)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                purge.mutate(['all'])
                setConfirm(false)
              }}
            >
              Purge {eligible}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  )
}
