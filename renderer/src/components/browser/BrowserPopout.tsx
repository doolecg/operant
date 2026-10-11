import { PictureInPicture2 } from 'lucide-react'
import { useLiveUpdates } from '@/lib/queries'
import { Button } from '@/components/ui/button'
import { BrowserTile } from './BrowserTile'

// The whole content of a pop-out window (main.tsx renders it when the URL has ?browserPopout=<crewId>): the project's
// browser tile under a thin bar with the way back.
export function BrowserPopoutPage({ crewId, onPopIn }: { crewId: number; onPopIn: () => void }) {
  useLiveUpdates()
  return (
    <div className="bg-background text-foreground flex h-screen flex-col p-2">
      <div className="flex shrink-0 justify-end pb-1">
        <Button type="button" variant="outline" size="sm" className="h-7 gap-1.5 text-xs" aria-label="Pop browser back in" onClick={onPopIn}>
          <PictureInPicture2 aria-hidden className="size-3.5" />
          Pop back in
        </Button>
      </div>
      <div className="min-h-0 flex-1">
        <BrowserTile crewId={crewId} popout />
      </div>
    </div>
  )
}

// What the tile area shows in the main window while the browser lives in its own window.
export function PoppedOutNotice({ onPopIn }: { onPopIn: () => void }) {
  return (
    <div className="text-muted-foreground flex h-full flex-col items-center justify-center gap-3 text-sm">
      <p>The browser is in its own window.</p>
      <Button type="button" variant="outline" size="sm" aria-label="Pop browser back in" onClick={onPopIn}>
        Pop back in
      </Button>
    </div>
  )
}
