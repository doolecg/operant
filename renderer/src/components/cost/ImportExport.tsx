import { useState } from 'react'
import { Download, FileUp, FolderInput } from 'lucide-react'
import { decodeIpcError } from '@shared/ipc'
import type { ImportCounts, ImportPreview, ImportResult, ImportSource } from '@shared/types'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { usd } from '@/lib/format'
import { pickImportFile, useExportAllData, useImportApply, useImportPreview } from '@/lib/queries'

const KINDS: Array<{ key: 'projects' | 'usage' | 'presets' | 'settings'; label: string }> = [
  { key: 'projects', label: 'Projects' },
  { key: 'usage', label: 'Usage rows' },
  { key: 'presets', label: 'Presets and roles' },
  { key: 'settings', label: 'Settings' },
]

const day = (t: number | null) => (t == null ? '' : new Date(t).toLocaleDateString())
const sum = (p: ImportPreview, f: keyof ImportCounts) => KINDS.reduce((a, k) => a + p[k.key][f], 0)

function PreviewView({ p, applied }: { p: ImportPreview; applied: boolean }) {
  const toAdd = sum(p, 'add')
  return (
    <div className="space-y-3" aria-label={applied ? 'Import result' : 'Import preview'} role="region">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <Badge variant="outline">{p.format === 'operant-2.8.2' ? 'Operant 2.8.2 data folder' : 'Operant export file'}</Badge>
        <span className="text-muted-foreground min-w-0 truncate" title={p.location}>
          {p.location}
        </span>
      </div>
      {!p.found ? (
        <p role="alert" className="text-destructive text-xs">
          {p.notes[0] ?? 'Nothing to import was found there.'}
        </p>
      ) : (
        <>
          <table className="w-full text-xs">
            <caption className="sr-only">{applied ? 'What was imported' : 'What importing would add'}</caption>
            <thead className="text-muted-foreground">
              <tr>
                <th scope="col" className="py-1 text-left font-medium">Kind</th>
                <th scope="col" className="py-1 text-right font-medium">{applied ? 'Added' : 'To add'}</th>
                <th scope="col" className="py-1 text-right font-medium">Already here</th>
                <th scope="col" className="py-1 text-right font-medium">Skipped</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {KINDS.map((k) => (
                <tr key={k.key}>
                  <th scope="row" className="py-1.5 text-left font-normal">{k.label}</th>
                  <td className="py-1.5 text-right tabular-nums">{p[k.key].add}</td>
                  <td className="py-1.5 text-right tabular-nums">{p[k.key].existing}</td>
                  <td className="py-1.5 text-right tabular-nums">{p[k.key].skipped}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {p.usage.add + p.usage.existing > 0 && (
            <p className="text-muted-foreground text-xs">
              Usage history: {usd(p.usageCostUsd)}
              {p.usageFrom != null && ` from ${day(p.usageFrom)} to ${day(p.usageTo)}`}. Rows from 2.8.2 carry cost only, not token kinds.
            </p>
          )}
          {!applied && toAdd === 0 && <p className="text-xs font-medium">Nothing new to import: everything in this source is already here.</p>}
          {applied && <p className="text-xs font-medium">Imported {toAdd} item{toAdd === 1 ? '' : 's'}. Running it again adds nothing.</p>}
        </>
      )}
      {p.notes.length > 0 && p.found && (
        <ul className="text-muted-foreground list-disc space-y-0.5 pl-4 text-[11px]">
          {p.notes.map((n, i) => (
            <li key={i}>{n}</li>
          ))}
        </ul>
      )}
      {p.skipped.length > 0 && (
        <section aria-label="Skipped rows" className="space-y-1">
          <h4 className="text-xs font-medium">Skipped ({p.skipped.length})</h4>
          <ul className="bg-muted/30 max-h-40 divide-y overflow-y-auto rounded-md border text-[11px]">
            {p.skipped.map((r, i) => (
              <li key={i} className="flex gap-2 px-2 py-1">
                <Badge variant="outline">{r.kind}</Badge>
                <span className="min-w-0 flex-1 truncate font-mono" title={r.ref}>
                  {r.ref}
                </span>
                <span className="text-muted-foreground">{r.reason}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  )
}

// Import from Operant 2.8.2 (its data folder or an export file) with a preview, and export everything as JSON.
export function ImportExportPanel() {
  const preview = useImportPreview()
  const apply = useImportApply()
  const exportAll = useExportAllData()
  const [source, setSource] = useState<ImportSource | null>(null)
  const [result, setResult] = useState<ImportResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState<string | null>(null)

  const fail = (e: unknown) => setError(decodeIpcError(e).message)
  const runPreview = (s: ImportSource) => {
    setError(null)
    setResult(null)
    setSource(s)
    preview.mutate(s, { onError: fail })
  }
  const p = result ?? preview.data ?? null
  const toAdd = preview.data ? sum(preview.data, 'add') : 0

  return (
    <div className="space-y-6">
      <section aria-label="Import" className="space-y-3">
        <div>
          <h3 className="text-sm font-medium">Import</h3>
          <p className="text-muted-foreground mt-0.5 text-xs">
            Bring usage history, projects, presets and operator roles from Operant 2.8.2. The old data is only read, never changed. Importing twice adds nothing twice.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="outline" disabled={preview.isPending} onClick={() => runPreview({ kind: 'legacy' })}>
            <FolderInput /> Preview import from Operant 2.8.2
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={preview.isPending}
            onClick={async () => {
              try {
                const path = await pickImportFile()
                if (path) runPreview({ kind: 'file', path })
              } catch (e) {
                fail(e)
              }
            }}
          >
            <FileUp /> Choose an export file
          </Button>
        </div>
        {error && (
          <p role="alert" className="text-destructive text-xs">
            {error}
          </p>
        )}
        {preview.isPending && <p className="text-muted-foreground text-xs">Reading...</p>}
        {p && <PreviewView p={p} applied={result != null} />}
        {preview.data && !result && preview.data.found && (
          <Button
            size="sm"
            disabled={apply.isPending || toAdd === 0 || source == null}
            onClick={() => {
              if (!source) return
              setError(null)
              apply.mutate(source, { onSuccess: (r) => setResult(r), onError: fail })
            }}
          >
            {apply.isPending ? 'Importing...' : `Apply: add ${toAdd} item${toAdd === 1 ? '' : 's'}`}
          </Button>
        )}
        {result && (
          <Button size="sm" variant="outline" disabled={!source} onClick={() => source && runPreview(source)}>
            Check again
          </Button>
        )}
      </section>

      <section aria-label="Export" className="space-y-3">
        <div>
          <h3 className="text-sm font-medium">Export all data</h3>
          <p className="text-muted-foreground mt-0.5 text-xs">
            Usage history, projects and presets as one JSON file, to move to another machine and import there. Keys and tokens are never included.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            variant="outline"
            disabled={exportAll.isPending}
            onClick={() => {
              setSaved(null)
              exportAll.mutate(undefined, { onSuccess: (r) => setSaved(r.saved), onError: fail })
            }}
          >
            <Download /> Export all data as JSON
          </Button>
          {saved && (
            <span role="status" className="text-muted-foreground min-w-0 truncate text-xs" title={saved}>
              Saved to {saved}
            </span>
          )}
        </div>
      </section>
    </div>
  )
}
