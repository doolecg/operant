import { useEffect, useState } from 'react'
import { Activity } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { clearNotices, markNoticesRead, useNotices } from '@/lib/notices'
import { timeAgo } from '@/lib/format'
import { useClearEvents, useEvents } from '@/lib/queries'
import { cn } from '@/lib/utils'
import { iconBtn } from './pill'

const kindTone: Record<string, string> = {
  error: 'bg-red-500',
  budget: 'bg-amber-400',
  index: 'bg-violet-400',
  crew: 'bg-zinc-400',
  info: 'bg-sky-400',
}

interface Row {
  key: string
  at: number
  kind: string
  message: string
}

// The activity feed (the project's events and the app-wide ones) and the notices, newest first. The dot on the icon counts
// the notices that came in since the menu was last opened; opening the menu marks them read.
export function ActivityMenu({ crewId }: { crewId: number | null }) {
  const events = useEvents().data ?? []
  const notices = useNotices()
  const clear = useClearEvents()
  const [open, setOpen] = useState(false)
  // Re-render every half minute so relative times stay current while the menu is open.
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    if (!open) return
    setNow(Date.now())
    const t = setInterval(() => setNow(Date.now()), 30_000)
    return () => clearInterval(t)
  }, [open])

  const rows: Row[] = [
    ...notices.list.map((n) => ({ key: `n${n.id}`, at: n.at, kind: n.level === 'error' ? 'error' : 'info', message: n.text })),
    ...events
      .filter((e) => e.crewId === crewId || e.crewId == null)
      .map((e) => ({ key: `e${e.id}`, at: e.at, kind: e.kind, message: e.message })),
  ].sort((a, b) => b.at - a.at)

  const onOpenChange = (o: boolean) => {
    setOpen(o)
    if (o) markNoticesRead()
  }

  return (
    <DropdownMenu open={open} onOpenChange={onOpenChange}>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <button type="button" className={iconBtn} aria-label={notices.unread > 0 ? `Activity, ${notices.unread} new` : 'Activity'}>
              <Activity />
              {notices.unread > 0 && (
                <span aria-hidden className="absolute -top-0.5 -right-0.5 size-2 rounded-full bg-red-500 ring-2 ring-background" />
              )}
            </button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent>Activity and notices</TooltipContent>
      </Tooltip>
      <DropdownMenuContent align="end" aria-label="Activity" className="w-[min(380px,90vw)] p-0">
        <div className="flex items-center justify-between gap-2 border-b px-3 py-2">
          <h3 className="text-sm font-medium">Activity</h3>
          <Button
            variant="ghost"
            size="sm"
            disabled={rows.length === 0 || clear.isPending}
            onClick={() => {
              clear.mutate()
              clearNotices()
            }}
          >
            Clear all
          </Button>
        </div>
        {rows.length === 0 ? (
          <p className="text-muted-foreground p-4 text-xs">Nothing has happened yet.</p>
        ) : (
          <ol className="max-h-[min(60vh,420px)] space-y-px overflow-y-auto p-2">
            {rows.map((r) => (
              <li key={r.key} className="hover:bg-accent/40 flex gap-2.5 rounded-lg px-2 py-1.5">
                <span className={cn('mt-1.5 size-1.5 shrink-0 rounded-full', kindTone[r.kind] ?? 'bg-zinc-500')} />
                <span className={cn('flex-1 text-xs leading-relaxed', r.kind === 'error' && 'text-red-400')}>{r.message}</span>
                <span className="text-muted-foreground shrink-0 text-[11px] tabular-nums">{timeAgo(r.at, now)}</span>
              </li>
            ))}
          </ol>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
