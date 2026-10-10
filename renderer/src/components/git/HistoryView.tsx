import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { useCommitDetails, useRepoDiff, useRepoLog } from '@/lib/queries'
import { cn } from '@/lib/utils'
import { DiffPane } from './DiffPane'
import { baseName, dirName } from './status'

const PAGE = 50
const LETTER: Record<string, string> = { A: 'text-success', M: 'text-warning', D: 'text-destructive', R: 'text-info', C: 'text-info' }

const when = (iso: string) => {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
}

// The last commits (50 at a time); a click shows the commit's message, its files and each file's diff.
export function HistoryView({ crewId, wide }: { crewId: number; wide: boolean }) {
  const [limit, setLimit] = useState(PAGE)
  const log = useRepoLog(crewId, limit)
  const [hash, setHash] = useState<string | null>(null)
  const [file, setFile] = useState<string | null>(null)
  const commits = log.data ?? []
  const details = useCommitDetails(crewId, hash)
  const files = details.data?.files ?? []
  const chosen = files.find((f) => f.path === file) ?? files[0] ?? null

  useEffect(() => {
    if (!hash && commits[0]) setHash(commits[0].hash)
  }, [commits, hash])
  useEffect(() => setFile(null), [hash])

  const diff = useRepoDiff(crewId, hash && chosen ? { path: chosen.path, orig: chosen.orig, side: 'commit', commit: hash } : null, hash ?? '')
  const c = details.data?.commit

  return (
    <div className={cn('flex min-h-0 flex-1', wide ? 'flex-row' : 'flex-col')}>
      <div className={cn('flex min-h-0 shrink-0 flex-col', wide ? 'w-[clamp(18rem,34%,34rem)] border-r' : 'h-[40%] border-b')}>
        <ul className="min-h-0 flex-1 overflow-y-auto" data-testid="git-log" aria-label="Commits">
          {log.isSuccess && commits.length === 0 && <li className="text-muted-foreground p-3 text-sm">No commits yet.</li>}
          {commits.map((k) => (
            <li key={k.hash}>
              <button
                type="button"
                aria-current={k.hash === hash}
                onClick={() => setHash(k.hash)}
                className={cn('block w-full border-b px-3 py-1.5 text-left text-xs', k.hash === hash ? 'bg-accent' : 'hover:bg-accent/50')}
              >
                <span className="flex items-center gap-2">
                  <span className="min-w-0 flex-1 truncate text-[13px] font-medium">{k.subject}</span>
                  {k.refs.map((r) => (
                    <span key={r} className="bg-muted text-muted-foreground max-w-32 shrink-0 truncate rounded-sm px-1 text-[10px]">
                      {r.replace('HEAD -> ', '')}
                    </span>
                  ))}
                </span>
                <span className="text-muted-foreground mt-0.5 flex gap-2">
                  <span className="font-mono">{k.short}</span>
                  <span className="truncate">{k.author}</span>
                  <span className="ml-auto shrink-0">{when(k.date)}</span>
                </span>
              </button>
            </li>
          ))}
          {commits.length >= limit && (
            <li className="p-2">
              <Button size="xs" variant="ghost" className="w-full" onClick={() => setLimit((n) => n + PAGE)}>
                Load {PAGE} more
              </Button>
            </li>
          )}
        </ul>
      </div>
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        {c && (
          <div className="max-h-[38%] shrink-0 space-y-1.5 overflow-y-auto border-b p-3 text-xs" data-testid="git-commit-details">
            <p className="text-sm font-semibold">{c.subject}</p>
            {c.body && <p className="text-muted-foreground whitespace-pre-wrap">{c.body}</p>}
            <p className="text-muted-foreground">
              <span className="font-mono">{c.short}</span> · {c.author} · {when(c.date)}
            </p>
            <ul className="flex flex-wrap gap-1" aria-label="Files in this commit">
              {files.map((f) => (
                <li key={f.path}>
                  <button
                    type="button"
                    aria-pressed={chosen?.path === f.path}
                    onClick={() => setFile(f.path)}
                    title={f.orig ? `${f.orig} → ${f.path}` : f.path}
                    className={cn('flex items-center gap-1.5 rounded-md border px-1.5 py-0.5', chosen?.path === f.path ? 'bg-accent' : 'hover:bg-accent/50')}
                  >
                    <span className={cn('font-mono font-semibold', LETTER[f.status])}>{f.status}</span>
                    <span className="font-medium">{baseName(f.path)}</span>
                    <span className="text-muted-foreground">{dirName(f.path)}</span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
        <DiffPane
          crewId={crewId}
          path={chosen?.path ?? null}
          sideLabel={c ? `Commit ${c.short}` : undefined}
          diff={diff.data}
          loading={diff.isFetching}
          error={diff.error ?? details.error}
          hunkAction={null}
        />
      </div>
    </div>
  )
}
