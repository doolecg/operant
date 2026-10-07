import { useEffect, useState } from 'react'
import { Check, Coins, Eye, Pencil, RotateCcw, Square, SquareTerminal, Trash2, Undo2, X } from 'lucide-react'
import { decodeIpcError } from '@shared/ipc'
import type { JobAgent, Run } from '@shared/types'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Markdown } from '@/components/ui/markdown'
import { ScrollArea } from '@/components/ui/scroll-area'
import { timeAgo } from '@/lib/format'
import { Textarea } from '@/components/ui/textarea'
import {
  useAnswerRun,
  useApproveRun,
  useCloseoutRun,
  useDeleteRun,
  useResumeMaster,
  useRun,
  useRunAgents,
  useRunEvents,
  useSendBackRun,
  useStopRun,
  useUpdateRun,
} from '@/lib/queries'
import { cn } from '@/lib/utils'
import { AgentView } from './AgentView'
import { ReasonDialog } from './ReasonDialog'
import { RunStatusBadge } from './RunStatusBadge'
import { runActive, runIsQuestion, timelineItem } from './runUi'

interface Props {
  runId: number
  onClose: () => void
  // Opens this job's page on the Usage tab.
  onOpenUsage?: (runId: number) => void
  // Closes the panel and moves to the Master Terminal.
  onOpenMaster?: () => void
}

const heading = 'text-muted-foreground text-[11px] font-medium tracking-wider uppercase'

const TONE_DOT = { neutral: 'bg-zinc-500', attention: 'bg-amber-400', good: 'bg-emerald-400', bad: 'bg-red-500' } as const

function Block({ title, tone, children }: { title: string; tone: 'amber' | 'violet'; children: React.ReactNode }) {
  return (
    <section className={cn('space-y-3 rounded-md border-2 p-4', tone === 'amber' ? 'border-amber-400/70' : 'border-violet-400/70')}>
      <h3 className="text-sm font-semibold">{title}</h3>
      {children}
    </section>
  )
}

// The Master's open question: its options as buttons, and a free text answer box.
function QuestionBlock({ run, onError }: { run: Run; onError: (m: string | null) => void }) {
  const answer = useAnswerRun()
  const [text, setText] = useState('')
  useEffect(() => setText(''), [run.id, run.question])
  const send = (value: string) => {
    onError(null)
    answer.mutate([run.id, value], { onSuccess: () => setText(''), onError: (e) => onError(decodeIpcError(e).message) })
  }
  return (
    <Block title="Question" tone="amber">
      <div className="rounded-md border p-3" data-question>
        <Markdown source={run.question} />
      </div>
      {run.questionOptions.length > 0 && (
        <div className="flex flex-wrap gap-2" role="group" aria-label="Answer options">
          {run.questionOptions.map((o) => (
            <Button key={o} variant="outline" disabled={answer.isPending} onClick={() => send(o)}>
              {o}
            </Button>
          ))}
        </div>
      )}
      <Textarea aria-label="Your answer" rows={3} placeholder="Or type your own answer" value={text} onChange={(e) => setText(e.target.value)} />
      <Button disabled={!text.trim() || answer.isPending} onClick={() => send(text.trim())}>
        Send answer
      </Button>
    </Block>
  )
}

// The Master's review: its summary as Markdown, then Approve (optional note) or Send back (note required).
function ReviewBlock({ run, onError }: { run: Run; onError: (m: string | null) => void }) {
  const approve = useApproveRun()
  const sendBack = useSendBackRun()
  const [note, setNote] = useState('')
  const [back, setBack] = useState(false)
  useEffect(() => setNote(''), [run.id])
  const fail = { onError: (e: unknown) => onError(decodeIpcError(e).message) }
  return (
    <Block title="Review" tone="violet">
      <div className="max-h-[45vh] overflow-y-auto rounded-md border p-3" data-review tabIndex={0}>
        {run.reviewSummary ? <Markdown source={run.reviewSummary} /> : <p className="text-muted-foreground text-sm">The Master gave no summary.</p>}
      </div>
      <Textarea aria-label="Approval note (optional)" rows={2} placeholder="Note for the Master (optional)" value={note} onChange={(e) => setNote(e.target.value)} />
      <div className="flex flex-wrap gap-3">
        <Button
          size="lg"
          disabled={approve.isPending}
          onClick={() => {
            onError(null)
            approve.mutate([run.id, note.trim() || undefined], fail)
          }}
        >
          <Check /> Approve
        </Button>
        <Button size="lg" variant="outline" onClick={() => setBack(true)}>
          <Undo2 /> Send back
        </Button>
      </div>
      <ReasonDialog
        open={back}
        title="Send back to the Master"
        description="Say what is missing or wrong. The Master gets your note and continues the job."
        submitLabel="Send back"
        pending={sendBack.isPending}
        error={sendBack.error}
        onClose={() => setBack(false)}
        onSubmit={(reason) => {
          onError(null)
          sendBack.mutate([run.id, reason], { onSuccess: () => setBack(false), ...fail })
        }}
      />
    </Block>
  )
}

const CLOSEOUT_LABEL = { pending: 'Waiting to start', running: 'Running', done: 'Done', partial: 'Partly done', failed: 'Failed' } as const

// After approval: where the close-out stands (Hindsight, CodeGraph, learning) and a retry when it did not finish.
function CloseoutBlock({ run, onError }: { run: Run; onError: (m: string | null) => void }) {
  const closeout = useCloseoutRun()
  if (!run.closeoutState) return null
  const retryable = run.closeoutState === 'partial' || run.closeoutState === 'failed'
  return (
    <section className="space-y-2">
      <h3 className={heading}>Close-out</h3>
      <p className="text-sm">
        {CLOSEOUT_LABEL[run.closeoutState]}
      </p>
      <p className="text-muted-foreground text-xs">Saves what was learned to Hindsight, refreshes the CodeGraph index and records lessons. The steps and their results are in the timeline.</p>
      {retryable && (
        <Button
          size="sm"
          variant="outline"
          disabled={closeout.isPending}
          onClick={() => {
            onError(null)
            closeout.mutate([run.id], { onError: (e) => onError(decodeIpcError(e).message) })
          }}
        >
          <RotateCcw className="size-3" /> Retry close-out
        </Button>
      )}
    </section>
  )
}

// What happened to the job, oldest first, as readable lines (never the raw events).
function Timeline({ runId }: { runId: number }) {
  const events = useRunEvents(runId).data ?? []
  return (
    <section className="space-y-2">
      <h3 className={heading}>Timeline</h3>
      {events.length === 0 ? (
        <p className="text-muted-foreground text-xs">Nothing has happened yet.</p>
      ) : (
        <ol className="space-y-2">
          {events.map((e) => {
            const item = timelineItem(e)
            return (
              <li key={item.id} className="flex gap-2.5">
                <span aria-hidden className={cn('mt-1.5 size-2 shrink-0 rounded-full', TONE_DOT[item.tone])} />
                <div className="min-w-0 flex-1">
                  <p className="text-sm">
                    {item.title} <span className="text-muted-foreground text-xs">· {timeAgo(item.at)}</span>
                  </p>
                  {item.detail && <p className="text-muted-foreground text-xs break-words whitespace-pre-wrap">{item.detail}</p>}
                </div>
              </li>
            )
          })}
        </ol>
      )}
    </section>
  )
}

// The full job panel over the right side: actions, the agent list and a live view of one agent.
export function RunPanel({ runId, onClose, onOpenUsage, onOpenMaster }: Props) {
  const run = useRun(runId).data
  const agents = useRunAgents(runId).data ?? []
  const stop = useStopRun()
  const update = useUpdateRun()
  const del = useDeleteRun()
  const resume = useResumeMaster()
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
        {run && <RunStatusBadge status={run.status} waiting={run.waiting} />}
        <div className="flex-1" />
        {onOpenUsage && (
          <Button size="sm" variant="outline" onClick={() => onOpenUsage(runId)}>
            <Coins className="size-3" /> Usage
          </Button>
        )}
        {run?.mode === 'master' && onOpenMaster && (
          <Button size="sm" variant="outline" onClick={onOpenMaster}>
            <SquareTerminal className="size-3" /> Open Master Terminal
          </Button>
        )}
        {run && runActive(run.status) && (
          <Button
            size="sm"
            variant="secondary"
            title={run.mode === 'master' ? 'Tells the Master to stop once it is idle' : undefined}
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

              {run.status === 'needs-you' && run.waiting === 'permission' && (
                <p className="rounded-md border-2 border-amber-400/70 p-3 text-sm">The Master is waiting at a permission prompt. Answer it in the Master Terminal.</p>
              )}

              {run.status === 'needs-you' && run.waiting === 'master' && (
                <Block title="The Master stopped" tone="amber">
                  <p className="text-sm">The Master Terminal stopped while this job was open. Resume it to continue where it left off.</p>
                  <Button
                    disabled={resume.isPending}
                    onClick={() => {
                      setError(null)
                      resume.mutate([runId], { onError: (e) => setError(decodeIpcError(e).message) })
                    }}
                  >
                    <RotateCcw /> Resume Master
                  </Button>
                </Block>
              )}

              {runIsQuestion(run) && <QuestionBlock run={run} onError={setError} />}
              {run.status === 'review' && <ReviewBlock run={run} onError={setError} />}
              {run.sentBackNote && run.status !== 'review' && run.status !== 'done' && (
                <section className="space-y-1.5">
                  <h3 className={heading}>Sent back with</h3>
                  <p className="text-sm break-words whitespace-pre-wrap">{run.sentBackNote}</p>
                </section>
              )}
              <CloseoutBlock run={run} onError={setError} />

              {run.outcome && (
                <section className="space-y-1.5">
                  <h3 className={heading}>Outcome</h3>
                  <div className="max-h-[55vh] overflow-y-auto rounded-md border p-3" data-outcome tabIndex={0}>
                    <Markdown source={run.outcome} />
                  </div>
                </section>
              )}

              {run.mode === 'master' && <Timeline runId={runId} />}

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
