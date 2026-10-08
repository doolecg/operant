import { useState } from 'react'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'

// Thumbnails of the images pasted into a task; click one to enlarge it.
export function TaskImages({ urls }: { urls: string[] }) {
  const [open, setOpen] = useState<number | null>(null)
  return (
    <>
      <ul className="mt-2 flex flex-wrap gap-2" aria-label="Attached images">
        {urls.map((url, i) => (
          <li key={i}>
            <button type="button" className="block rounded-md border focus-visible:ring-2" onClick={() => setOpen(i)} aria-label={`Enlarge image ${i + 1}`}>
              <img src={url} alt={`Attached image ${i + 1}`} className="h-20 w-28 rounded-md object-cover" />
            </button>
          </li>
        ))}
      </ul>
      <Dialog open={open != null} onOpenChange={(o) => !o && setOpen(null)}>
        <DialogContent size="xl">
          <DialogTitle className="sr-only">Attached image</DialogTitle>
          <DialogDescription className="sr-only">The image pasted into this task.</DialogDescription>
          {open != null && <img src={urls[open]} alt={`Attached image ${open + 1}`} className="max-h-[80vh] w-full object-contain" />}
        </DialogContent>
      </Dialog>
    </>
  )
}
