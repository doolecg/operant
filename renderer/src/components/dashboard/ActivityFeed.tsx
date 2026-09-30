import { useEffect, useState } from 'react'
import type { OperantEvent } from '@shared/types'
import { timeAgo } from '@/lib/format'
import { cn } from '@/lib/utils'

const kindTone: Record<string, string> = {
  error: 'bg-red-500',
  budget: 'bg-amber-400',
  operator: 'bg-emerald-400',
  task: 'bg-sky-400',
  index: 'bg-violet-400',
  crew: 'bg-zinc-400',
}

export function ActivityFeed({ events, crewId }: { events: OperantEvent[]; crewId: number | null }) {
  // Re-render every half minute so relative times stay current.
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000)
    return () => clearInterval(t)
  }, [])

  const shown = events.filter((e) => crewId == null || e.crewId === crewId || e.crewId == null)
  if (shown.length === 0) return <p className="text-muted-foreground p-4 text-xs">Nothing has happened yet.</p>

  return (
    <ol className="space-y-px p-2">
      {shown.map((e) => (
        <li key={e.id} className="hover:bg-accent/40 flex gap-2.5 rounded-md px-2 py-1.5">
          <span className={cn('mt-1.5 size-1.5 shrink-0 rounded-full', kindTone[e.kind] ?? 'bg-zinc-500')} />
          <span className={cn('flex-1 text-xs leading-relaxed', e.kind === 'error' && 'text-red-400')}>
            {e.message}
          </span>
          <span className="text-muted-foreground shrink-0 text-[11px] tabular-nums">{timeAgo(e.at, now)}</span>
        </li>
      ))}
    </ol>
  )
}
