import { useEffect, useRef, useState } from 'react'
import { Ban, Check, ChevronDown, ChevronRight, Hand, Loader2, TriangleAlert } from 'lucide-react'
import { cn } from '@/lib/utils'

export type TimelineStatus = 'running' | 'done' | 'error' | 'refused' | 'interrupted'

// The shape of the browser:actions items this list shows.
export interface TimelineAction {
  id: number
  at: number
  tool: string
  summary: string
  status: TimelineStatus
}

const STATUS: Record<TimelineStatus, { label: string; icon: typeof Check; className: string }> = {
  running: { label: 'Running', icon: Loader2, className: 'text-primary animate-spin' },
  done: { label: 'Done', icon: Check, className: 'text-muted-foreground' },
  error: { label: 'Failed', icon: TriangleAlert, className: 'text-destructive' },
  refused: { label: 'Refused', icon: Ban, className: 'text-destructive' },
  interrupted: { label: 'Interrupted', icon: Hand, className: 'text-muted-foreground' },
}

const time = (at: number) => new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })

// What the AI did in the browser, oldest first. It follows the newest entry until the user scrolls up.
export function ActionTimeline({ actions, defaultOpen = false, className }: { actions: readonly TimelineAction[]; defaultOpen?: boolean; className?: string }) {
  const [open, setOpen] = useState(defaultOpen)
  const list = useRef<HTMLDivElement>(null)
  const follow = useRef(true)
  const last = actions.at(-1)

  useEffect(() => {
    const el = list.current
    if (open && el && follow.current) el.scrollTop = el.scrollHeight
  }, [open, actions.length, last?.status])

  if (actions.length === 0) return null
  const Chevron = open ? ChevronDown : ChevronRight

  return (
    <section aria-label="AI action log" className={cn('shrink-0 border-t text-xs', className)}>
      <button
        type="button"
        aria-expanded={open}
        aria-label={open ? 'Collapse AI action log' : 'Expand AI action log'}
        onClick={() => {
          follow.current = true
          setOpen(!open)
        }}
        className="hover:bg-accent/50 flex w-full min-w-0 items-center gap-1.5 px-3 py-1 text-left"
      >
        <Chevron aria-hidden className="size-3 shrink-0" />
        <span className="shrink-0 font-medium">AI actions ({actions.length})</span>
        {!open && last && <span className="text-muted-foreground min-w-0 truncate">{last.summary}</span>}
      </button>
      {open && (
        <div
          ref={list}
          role="log"
          aria-label="AI actions"
          tabIndex={0}
          onScroll={(e) => {
            const el = e.currentTarget
            follow.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24
          }}
          className="max-h-40 overflow-y-auto px-3 pb-1.5"
        >
          <ol className="space-y-0.5">
            {actions.map((a) => {
              const s = STATUS[a.status]
              const Icon = s.icon
              return (
                <li key={a.id} className="flex min-w-0 items-center gap-2">
                  <time dateTime={new Date(a.at).toISOString()} className="text-muted-foreground w-16 shrink-0 tabular-nums">
                    {time(a.at)}
                  </time>
                  <Icon role="img" aria-label={s.label} className={cn('size-3 shrink-0', s.className)} />
                  <span className="min-w-0 truncate" title={a.summary}>
                    <span className="font-medium">{a.tool}</span> <span className="text-muted-foreground">{a.summary}</span>
                  </span>
                </li>
              )
            })}
          </ol>
        </div>
      )}
    </section>
  )
}
