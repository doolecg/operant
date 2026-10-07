import { useState } from 'react'
import { Download } from 'lucide-react'
import { decodeIpcError } from '@shared/ipc'
import type { ExportFormat, UsageView } from '@shared/types'
import { Button } from '@/components/ui/button'
import { useExportUsage } from '@/lib/queries'

export interface ExportViewChoice {
  id: string
  label: string
  view: UsageView
}

// CSV and JSON of the view on screen (or another view): the main process asks where to save.
export function ExportButtons({ views }: { views: ExportViewChoice[] }) {
  const [viewId, setViewId] = useState(views[0]!.id)
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null)
  const exp = useExportUsage()
  const current = views.find((v) => v.id === viewId) ?? views[0]!
  const run = (format: ExportFormat) => {
    setNote(null)
    exp.mutate([current.view, format], {
      onSuccess: (r) => setNote(r.saved ? { ok: true, text: `Saved to ${r.saved}` } : null),
      onError: (e) => setNote({ ok: false, text: decodeIpcError(e).message }),
    })
  }
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {views.length > 1 && (
        <>
          <label htmlFor="export-view" className="sr-only">
            Export view
          </label>
          <select
            id="export-view"
            value={current.id}
            onChange={(e) => setViewId(e.target.value)}
            className="border-input bg-background h-6 rounded-md border px-1.5 text-[11px]"
          >
            {views.map((v) => (
              <option key={v.id} value={v.id}>
                {v.label}
              </option>
            ))}
          </select>
        </>
      )}
      <Button size="xs" variant="outline" disabled={exp.isPending} onClick={() => run('csv')}>
        <Download /> Export CSV
      </Button>
      <Button size="xs" variant="outline" disabled={exp.isPending} onClick={() => run('json')}>
        <Download /> Export JSON
      </Button>
      {note && (
        <span role={note.ok ? 'status' : 'alert'} className={note.ok ? 'text-muted-foreground max-w-full truncate text-[11px]' : 'text-destructive text-[11px]'} title={note.text}>
          {note.text}
        </span>
      )}
    </div>
  )
}
