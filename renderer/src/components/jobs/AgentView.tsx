import { useEffect, useRef, useState } from 'react'
import { ArrowDownToLine, ArrowLeft, Check, Copy } from 'lucide-react'
import type { JobAgent } from '@shared/types'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { useRunAgentLog } from '@/lib/queries'

// The log of one agent: the tail of its transcript, re-read every 2 seconds while live. It follows the newest line until
// you scroll up (or switch Follow off) and copies the log. Also the body of a subagent tile in the Terminal view.
export function AgentLog({ runId, agentId, seat, live, className = '' }: { runId: number; agentId: number; seat: string; live: boolean; className?: string }) {
  const log = useRunAgentLog(runId, agentId, live)
  const lines = log.data ?? []
  const box = useRef<HTMLDivElement>(null)
  const [follow, setFollow] = useState(true)
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    const el = box.current
    if (follow && el) el.scrollTop = el.scrollHeight
  }, [follow, lines.length, log.dataUpdatedAt])
  useEffect(() => {
    if (!copied) return
    const t = setTimeout(() => setCopied(false), 1500)
    return () => clearTimeout(t)
  }, [copied])
  // Scrolling away from the bottom stops following; reaching the bottom again resumes it.
  const onScroll = () => {
    const el = box.current
    if (el) setFollow(el.scrollHeight - el.scrollTop - el.clientHeight < 24)
  }
  const copy = () => {
    void navigator.clipboard
      ?.writeText(lines.join('\n'))
      .then(() => setCopied(true))
      .catch(() => undefined)
  }
  return (
    <div className={`flex min-h-0 flex-1 flex-col gap-1.5 ${className}`}>
      <div className="flex items-center gap-2">
        <h3 className="text-muted-foreground flex-1 text-[11px] font-medium tracking-wider uppercase">Log{live ? ' (live)' : ''}</h3>
        <Button
          variant={follow ? 'secondary' : 'outline'}
          size="sm"
          className="h-6 px-2 text-[11px]"
          aria-pressed={follow}
          aria-label="Follow the newest line"
          onClick={() => setFollow((f) => !f)}
        >
          <ArrowDownToLine className="size-3" /> Follow
        </Button>
        <Button variant="outline" size="sm" className="h-6 px-2 text-[11px]" aria-label="Copy the log" disabled={lines.length === 0} onClick={copy}>
          {copied ? <Check className="size-3" /> : <Copy className="size-3" />} {copied ? 'Copied' : 'Copy'}
        </Button>
      </div>
      <div
        ref={box}
        onScroll={onScroll}
        role="log"
        aria-label={`Log of ${seat}`}
        className="bg-card min-h-0 flex-1 overflow-y-auto rounded-md border p-2 font-mono text-[11px]"
      >
        {lines.length === 0 ? (
          <p className="text-muted-foreground">{log.isPending ? 'Loading...' : 'No log available for this agent yet.'}</p>
        ) : (
          lines.map((l, i) => (
            <div key={i} className="break-words whitespace-pre-wrap">
              {l}
            </div>
          ))
        )}
      </div>
    </div>
  )
}

// A live, read-only view of one agent of a job: its details and the log, with whether the agent is still working.
// Nothing is editable.
export function AgentView({ runId, live, agent, onBack }: { runId: number; live: boolean; agent: JobAgent; onBack: () => void }) {
  const working = live && agent.status !== 'done'
  const rows: Array<[string, string]> = [
    ['Seat', agent.seat],
    ['Model', agent.model || 'unknown'],
    ['Status', agent.status],
    ['Transcript', agent.transcriptRef || 'none'],
  ]
  return (
    <section aria-label={`Agent ${agent.seat}`} className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-2 border-b px-3 py-2">
        <Button variant="ghost" size="icon" className="size-7" aria-label="Back to agent list" onClick={onBack}>
          <ArrowLeft className="size-4" />
        </Button>
        <div className="min-w-0 flex-1 truncate text-sm font-medium">{agent.seat}</div>
        <Badge variant="outline" className="gap-1.5 font-normal" role="status" aria-label={working ? 'Working' : 'Finished'}>
          <span aria-hidden className={working ? 'size-1.5 animate-pulse rounded-full bg-emerald-400' : 'bg-muted-foreground size-1.5 rounded-full'} />
          {working ? 'Working' : 'Done'}
        </Badge>
        <Badge variant="outline" className="font-normal">
          Read-only
        </Badge>
      </div>
      <dl className="grid grid-cols-[6rem_1fr] gap-x-4 gap-y-2 p-4 text-sm">
        {rows.map(([k, v]) => (
          <div key={k} className="contents">
            <dt className="text-muted-foreground text-xs">{k}</dt>
            <dd className="font-mono text-xs break-all">{v}</dd>
          </div>
        ))}
      </dl>
      <AgentLog runId={runId} agentId={agent.id} seat={agent.seat} live={live} className="px-4 pb-4" />
    </section>
  )
}
