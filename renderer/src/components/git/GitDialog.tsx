import { useState } from 'react'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { GitPage } from './GitPage'

// The Git page in a large popout: from the branch chip, the provider and project menus' "Show changes".
export function GitDialog({ crewId, open, onOpenChange }: { crewId: number; open: boolean; onOpenChange: (open: boolean) => void }) {
  const [wide, setWide] = useState(false)
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="lg" className="h-[85vh] w-[90vw] max-w-[min(1100px,90vw)]">
        <DialogTitle asChild>
          <span className="sr-only">Git</span>
        </DialogTitle>
        <DialogDescription className="sr-only">Changes, commits and branches for this project</DialogDescription>
        <div className="flex min-h-0 flex-1 flex-col pt-11">
          <GitPage crewId={crewId} wide={wide} onToggleWide={() => setWide((w) => !w)} />
        </div>
      </DialogContent>
    </Dialog>
  )
}
