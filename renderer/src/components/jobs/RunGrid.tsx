import { useState } from 'react'
import { Pencil, Square, Trash2 } from 'lucide-react'
import { decodeIpcError } from '@shared/ipc'
import { markdownToPlain } from '@shared/markdown'
import type { Run } from '@shared/types'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Textarea } from '@/components/ui/textarea'
import { timeAgo } from '@/lib/format'
import { useDeleteRun, useStopRun, useUpdateRun } from '@/lib/queries'
import { cn } from '@/lib/utils'
import { RunStatusBadge } from './RunStatusBadge'
import { runActive } from './runUi'

interface Props {
  runs: Run[]
  selectedId: number | null
  onOpen: (run: Run) => void
  // Called after a card's job was deleted, so an open panel for it can close.
  onDeleted?: (runId: number) => void
}

// Stop, edit task and delete on a card, with the same rules as the job panel: stop while it is queued or working,
// edit while queued, delete once it ended.
function RunCardActions({ run, onDeleted }: { run: Run; onDeleted?: (runId: number) => void }) {
  const stop = useStopRun()
  const update = useUpdateRun()
  const del = useDeleteRun()
  const [editing, setEditing] = useState<string | null>(null)
  const [confirm, setConfirm] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const fail = { onError: (e: unknown) => setError(decodeIpcError(e).message) }
  const ended = run.status === 'done' || run.status === 'failed'

  return (
    <div className="space-y-1.5">
      {editing !== null && (
        <div className="space-y-1.5">
          <Textarea aria-label={`Task of JOB#${run.id}`} rows={3} value={editing} onChange={(e) => setEditing(e.target.value)} className="text-xs" />
          <div className="flex gap-1.5">
            <Button
              size="sm"
              className="h-6 px-2 text-[11px]"
              disabled={!editing.trim() || update.isPending}
              onClick={() => {
                setError(null)
                update.mutate([run.id, { task: editing }], { onSuccess: () => setEditing(null), ...fail })
              }}
            >
              Save task
            </Button>
            <Button size="sm" variant="ghost" className="h-6 px-2 text-[11px]" onClick={() => setEditing(null)}>
              Cancel
            </Button>
          </div>
        </div>
      )}
      <div className="flex flex-wrap gap-1.5">
        {runActive(run.status) && (
          <Button
            size="sm"
            variant="secondary"
            className="h-6 px-2 text-[11px]"
            aria-label={`Stop JOB#${run.id}`}
            disabled={stop.isPending}
            onClick={() => {
              setError(null)
              stop.mutate([run.id], fail)
            }}
          >
            <Square className="size-3" /> Stop
          </Button>
        )}
        {run.status === 'queued' && editing === null && (
          <Button size="sm" variant="outline" className="h-6 px-2 text-[11px]" aria-label={`Edit task of JOB#${run.id}`} onClick={() => setEditing(run.task)}>
            <Pencil className="size-3" /> Edit task
          </Button>
        )}
        {ended &&
          (confirm ? (
            <>
              <Button
                size="sm"
                variant="destructive"
                className="h-6 px-2 text-[11px]"
                aria-label={`Confirm delete JOB#${run.id}`}
                disabled={del.isPending}
                onClick={() => {
                  setError(null)
                  del.mutate([run.id], { onSuccess: () => onDeleted?.(run.id), ...fail })
                }}
              >
                Confirm delete
              </Button>
              <Button size="sm" variant="ghost" className="h-6 px-2 text-[11px]" onClick={() => setConfirm(false)}>
                Keep
              </Button>
            </>
          ) : (
            <Button size="sm" variant="outline" className="h-6 px-2 text-[11px]" aria-label={`Delete JOB#${run.id}`} onClick={() => setConfirm(true)}>
              <Trash2 className="size-3" /> Delete
            </Button>
          ))}
      </div>
      {error && (
        <p role="alert" className="text-destructive text-[11px]">
          {error}
        </p>
      )}
    </div>
  )
}

// The job card grid: one card per JOB#, newest first. Status comes live from the run push event.
export function RunGrid({ runs, selectedId, onOpen, onDeleted }: Props) {
  return (
    <ScrollArea className="min-h-0 flex-1">
      {runs.length === 0 ? (
        <p className="text-muted-foreground px-4 py-6 text-center text-xs">No jobs yet. Start a new task to create one.</p>
      ) : (
        <ul className="grid grid-cols-1 gap-2 p-3 2xl:grid-cols-2">
          {runs.map((run) => {
            const seats = run.seats.reduce((n, s) => n + s.count, 0)
            return (
              <li key={run.id} className={cn('bg-card space-y-2 rounded-md border p-2.5', run.id === selectedId && 'border-primary')}>
                <button
                  type="button"
                  onClick={() => onOpen(run)}
                  aria-label={`Open JOB#${run.id}`}
                  aria-pressed={run.id === selectedId}
                  className="hover:bg-accent/40 -m-1 block w-[calc(100%+0.5rem)] space-y-1.5 rounded p-1 text-left transition-colors"
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-mono text-xs font-semibold">JOB#{run.id}</span>
                    <RunStatusBadge status={run.status} />
                  </div>
                  <p className="line-clamp-2 text-xs break-words">{run.task}</p>
                  {run.outcome && <p className="text-muted-foreground line-clamp-2 text-[11px] break-words">{markdownToPlain(run.outcome, 160)}</p>}
                  <p className="text-muted-foreground font-mono text-[10px]">
                    {run.masterCli} · {seats > 0 ? `${seats} seats` : 'solo'} · {timeAgo(run.createdAt)}
                  </p>
                </button>
                <RunCardActions run={run} onDeleted={onDeleted} />
              </li>
            )
          })}
        </ul>
      )}
    </ScrollArea>
  )
}
