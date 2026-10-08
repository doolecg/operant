import { useState } from 'react'
import type { BoardColumn as Column } from '@shared/board'
import type { Run } from '@shared/types'
import { cn } from '@/lib/utils'
import { TaskCard } from './TaskCard'

export const COLUMN_LABEL: Record<Column, string> = {
  queued: 'Queued',
  working: 'Working',
  'needs-you': 'Needs you',
  review: 'In review',
  done: 'Done',
}

const DOT: Record<Column, string> = {
  queued: 'bg-zinc-400',
  working: 'bg-emerald-400',
  'needs-you': 'bg-amber-400',
  review: 'bg-violet-400',
  done: 'bg-sky-400',
}

const DONE_SHOWN = 20

// One status column: header with the count, then its cards. Done shows the newest 20 and a "Show older" link.
export function BoardColumn({ column, runs, onOpen, onDeleted }: { column: Column; runs: Run[]; onOpen: (run: Run) => void; onDeleted: (runId: number) => void }) {
  const [all, setAll] = useState(false)
  const capped = column === 'done' && !all && runs.length > DONE_SHOWN
  const shown = capped ? runs.slice(0, DONE_SHOWN) : runs
  return (
    <section aria-label={COLUMN_LABEL[column]} data-board-column={column} className="bg-muted/30 flex min-h-0 min-w-[12.5rem] flex-1 flex-col rounded-xl border">
      <header className="flex h-10 shrink-0 items-center gap-2 px-3.5">
        <span aria-hidden className={cn('size-2 rounded-full', DOT[column])} />
        <h3 className="text-sm font-medium">{COLUMN_LABEL[column]}</h3>
        <span data-column-count className="bg-muted text-muted-foreground ml-auto rounded-full px-2 text-[11px] tabular-nums">
          {runs.length}
        </span>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto px-2.5 pb-2.5">
        {runs.length === 0 ? (
          <p className="text-muted-foreground px-1 py-4 text-center text-xs">Nothing here</p>
        ) : (
          <ul className="space-y-2.5">
            {shown.map((run) => (
              <TaskCard key={run.id} run={run} onOpen={onOpen} onDeleted={onDeleted} />
            ))}
          </ul>
        )}
        {capped && (
          <button type="button" className="text-primary mt-2 w-full text-center text-xs hover:underline" onClick={() => setAll(true)}>
            Show older ({runs.length - DONE_SHOWN})
          </button>
        )}
      </div>
    </section>
  )
}
