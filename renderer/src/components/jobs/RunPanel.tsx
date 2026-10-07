import { useEffect, useState } from 'react'
import { Coins, Eye, Pencil, Square, Trash2, X } from 'lucide-react'
import { decodeIpcError } from '@shared/ipc'
import type { JobAgent } from '@shared/types'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Markdown } from '@/components/ui/markdown'
import { ScrollArea } from '@/components/ui/scroll-area'
import { timeAgo } from '@/lib/format'
import { Textarea } from '@/components/ui/textarea'
import { useDeleteRun, useRun, useRunAgents, useStopRun, useUpdateRun } from '@/lib/queries'
import { AgentView } from './AgentView'
import { RunStatusBadge } from './RunStatusBadge'
import { runActive } from './runUi'

interface Props {
  runId: number
  onClose: () => void
  // Opens this job's page on the Usage tab.
  onOpenUsage?: (runId: number) => void
}

const heading = 'text-muted-foreground text-[11px] font-medium tracking-wider uppercase'

// The full job panel over the right side: actions, the agent list and a live view of one agent.
export function RunPanel({ runId, onClose, onOpenUsage }: Props) {
  const run = useRun(runId).data
  const agents = useRunAgents(runId).data ?? []
  const stop = useStopRun()
  const update = useUpdateRun()
  const del = useDeleteRun()
  const [editing, setEditing] = useState<string | null>(null)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [viewId, setViewId] = useState<number | null>(null)
  const viewing: JobAgent | null = agents.find((a) => a.id === viewId) ?? null

  useEffect(() => {
    setError(null)
    setViewId(null)
    setEditing(null)
    setConfirmDelete(false)
  }, [runId])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && !e.defaultPrevented && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <aside
      role="region"
      aria-label={`Job panel JOB#${runId}`}
      className="bg-background absolute top-11 right-0 bottom-0 z-10 flex w-[min(760px,100%)] flex-col border-l shadow-xl"
    >
      <header className="flex items-center gap-3 border-b px-4 py-3">
        <h2 className="font-mono text-sm font-semibold">JOB#{runId}</h2>
        {run && <RunStatusBadge status={run.status} />}
        <div className="flex-1" />
        {onOpenUsage && (
          <Button size="sm" variant="outline" onClick={() => onOpenUsage(runId)}>
            <Coins className="size-3" /> Usage
          </Button>
        )}
        {run && runActive(run.status) && (
          <Button
            size="sm"
            variant="secondary"
            disabled={stop.isPending}
            onClick={() => {
              setError(null)
              stop.mutate([runId], { onError: (e) => setError(decodeIpcError(e).message) })
            }}
          >
            <Square className="size-3" /> Stop job
          </Button>
        )}
        {run?.status === 'queued' && editing === null && (
          <Button size="sm" variant="outline" onClick={() => setEditing(run.task)}>
            <Pencil className="size-3" /> Edit task
          </Button>
        )}
        {run && (run.status === 'done' || run.status === 'failed') &&
          (confirmDelete ? (
            <>
              <Button
                size="sm"
                variant="destructive"
                disabled={del.isPending}
                onClick={() => {
                  setError(null)
                  del.mutate([runId], { onSuccess: onClose, onError: (e) => setError(decodeIpcError(e).message) })
                }}
              >
                Confirm delete
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setConfirmDelete(false)}>
                Keep
              </Button>
            </>
          ) : (
            <Button size="sm" variant="outline" onClick={() => setConfirmDelete(true)}>
              <Trash2 className="size-3" /> Delete job
            </Button>
          ))}
        <Button variant="ghost" size="icon" className="size-8" aria-label="Close job panel" onClick={onClose}>
          <X className="size-4" />
        </Button>
      </header>

      {error && (
        <p role="alert" className="text-destructive border-b px-4 py-2 text-xs">
          {error}
        </p>
      )}

      {viewing ? (
        <AgentView runId={runId} live={run != null && runActive(run.status)} agent={viewing} onBack={() => setViewId(null)} />
      ) : (
        <ScrollArea className="min-h-0 flex-1">
          {run && (
            <div className="space-y-5 p-4">
              <section className="space-y-1.5">
                <h3 className={heading}>Task</h3>
                {editing !== null ? (
                  <div className="space-y-2">
                    <Textarea aria-label="Task" rows={5} value={editing} onChange={(e) => setEditing(e.target.value)} />
                    <div className="flex gap-2">
                      <Button
                        size="sm"
                        disabled={!editing.trim() || update.isPending}
                        onClick={() => {
                          setError(null)
                          update.mutate([runId, { task: editing }], {
                            onSuccess: () => setEditing(null),
                            onError: (e) => setError(decodeIpcError(e).message),
                          })
                        }}
                      >
                        Save task
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => setEditing(null)}>
                        Cancel
                      </Button>
                    </div>
                  </div>
                ) : (
                  <p className="text-sm break-words whitespace-pre-wrap">{run.task}</p>
                )}
                <p className="text-muted-foreground font-mono text-[11px]">
                  {run.masterCli}
                  {run.masterModel && ` · ${run.masterModel}`}
                  {run.masterEffort && ` (${run.masterEffort})`} · created {timeAgo(run.createdAt)}
                  {run.startedAt != null && ` · started ${timeAgo(run.startedAt)}`}
                  {run.finishedAt != null && ` · finished ${timeAgo(run.finishedAt)}`}
                </p>
              </section>

              {run.outcome && (
                <section className="space-y-1.5">
                  <h3 className={heading}>Outcome</h3>
                  <div className="max-h-[55vh] overflow-y-auto rounded-md border p-3" data-outcome tabIndex={0}>
                    <Markdown source={run.outcome} />
                  </div>
                </section>
              )}

              <section className="space-y-2">
                <h3 className={heading}>Agents</h3>
                {agents.length === 0 ? (
                  <p className="text-muted-foreground text-xs">
                    {run?.seats.length === 0 ? 'A solo job has no subagents.' : 'No agents seen yet.'}
                  </p>
                ) : (
                  <ul className="space-y-1.5">
                    {agents.map((a) => (
                      <li key={a.id} className="bg-card flex items-center gap-3 rounded-md border px-3 py-2">
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-sm">{a.seat}</div>
                          <div className="text-muted-foreground truncate font-mono text-[11px]">{a.model || 'model unknown'}</div>
                        </div>
                        <Badge variant="outline" className="font-normal">
                          {a.status}
                        </Badge>
                        <Button size="sm" variant="outline" aria-label={`Open agent ${a.seat}`} onClick={() => setViewId(a.id)}>
                          <Eye /> Open
                        </Button>
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            </div>
          )}
        </ScrollArea>
      )}
    </aside>
  )
}
