import type { ReactNode } from 'react'
import { Activity, CircleDollarSign, Network, SquareCheckBig } from 'lucide-react'
import type { DashboardSummary } from '@shared/ipc'
import type { IndexStatus } from '@shared/types'
import { compact, usd } from '@/lib/format'

function Stat({ icon, label, value, hint }: { icon: ReactNode; label: string; value: ReactNode; hint?: ReactNode }) {
  return (
    <div className="bg-card flex flex-1 items-start gap-3 rounded-lg border px-4 py-3">
      <div className="text-muted-foreground mt-0.5">{icon}</div>
      <div className="min-w-0">
        <div className="text-muted-foreground text-xs">{label}</div>
        <div className="text-xl font-semibold tabular-nums">{value}</div>
        {hint && <div className="text-muted-foreground truncate text-[11px]">{hint}</div>}
      </div>
    </div>
  )
}

export function StatStrip({ summary, index }: { summary?: DashboardSummary; index?: IndexStatus | null }) {
  const budget = summary?.dailyBudgetUsd ?? 0
  const over = budget > 0 && (summary?.spendToday ?? 0) >= budget
  return (
    <div className="flex gap-3">
      <Stat
        icon={<Activity className="size-4" />}
        label="Operators running"
        value={
          <>
            {summary?.operatorsRunning ?? 0}
            <span className="text-muted-foreground text-sm font-normal"> / {summary?.operatorsTotal ?? 0}</span>
          </>
        }
        hint="across all crews"
      />
      <Stat
        icon={<SquareCheckBig className="size-4" />}
        label="Open tasks"
        value={summary?.tasksOpen ?? 0}
        hint="todo, doing, review"
      />
      <Stat
        icon={<CircleDollarSign className="size-4" />}
        label="Spend today"
        value={
          <span className={over ? 'text-red-400' : undefined}>{usd(summary?.spendToday ?? 0)}</span>
        }
        hint={budget > 0 ? `of ${usd(budget)} daily budget` : 'from operator transcripts'}
      />
      <Stat
        icon={<Network className="size-4" />}
        label="CodeGraph"
        value={index?.initialized ? compact(index.symbols) : '—'}
        hint={
          index?.indexing
            ? 'indexing…'
            : index?.initialized
              ? `symbols in ${compact(index.files)} files`
              : index?.error
                ? 'unavailable'
                : 'not indexed'
        }
      />
    </div>
  )
}
