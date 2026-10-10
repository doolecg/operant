import { useState } from 'react'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { UsagePage } from './UsagePage'

// The Usage page in a large popout: from the sidebar footer's provider limit badge and the project menus.
export function UsageDialog({ crewId, open, onOpenChange }: { crewId: number; open: boolean; onOpenChange: (open: boolean) => void }) {
  const [wide, setWide] = useState(false)
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="lg" className="h-[85vh] w-[90vw] max-w-[min(1100px,90vw)]">
        <DialogTitle asChild>
          <span className="sr-only">Usage</span>
        </DialogTitle>
        <DialogDescription className="sr-only">Token use, cost and provider limits for this project</DialogDescription>
        <div className="flex min-h-0 flex-1 flex-col pt-11">
          <UsagePage crewId={crewId} wide={wide} onToggleWide={() => setWide((w) => !w)} />
        </div>
      </DialogContent>
    </Dialog>
  )
}
