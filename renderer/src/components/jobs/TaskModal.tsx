import { useEffect } from 'react'
import { Dialog, DialogContent } from '@/components/ui/dialog'
import { bridge } from '@/lib/bridge'
import { pruneStoredDrafts } from '@/lib/drafts'
import { RunDetail } from './RunDetail'
import { runActive } from './runUi'

// Drops saved drafts whose job is gone or finished (and new-task drafts of removed projects).
async function pruneDrafts() {
  try {
    const crews = await bridge().invoke('crews:list')
    const lists = await Promise.all(crews.map((c) => bridge().invoke('runs:list', c.id)))
    const live = new Set(lists.flat().filter((r) => runActive(r.status)).map((r) => r.id))
    pruneStoredDrafts(live, new Set(crews.map((c) => c.id)))
  } catch {
    /* nothing to prune against */
  }
}

// The near-full-screen task view: one job's details over whatever view is open. Closing it keeps typed notes as drafts.
export function TaskModal({
  runId,
  onClose,
  onOpenUsage,
  onOpenMaster,
}: {
  runId: number | null
  onClose: () => void
  onOpenUsage?: (runId: number) => void
  onOpenMaster?: () => void
}) {
  useEffect(() => {
    if (runId != null) void pruneDrafts()
  }, [runId])
  return (
    <Dialog open={runId != null} onOpenChange={(o) => !o && onClose()}>
      <DialogContent size="xl" showCloseButton={false} className="h-[92vh]">
        {runId != null && <RunDetail runId={runId} onClose={onClose} onOpenUsage={onOpenUsage} onOpenMaster={onOpenMaster} />}
      </DialogContent>
    </Dialog>
  )
}
