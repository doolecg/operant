import { decodeIpcError } from '@shared/ipc'
import type { BudgetConfig, BudgetProgress } from '@shared/types'
import { NumberField } from '@/components/settings/parts'
import { usd } from '@/lib/format'
import { useBudgets, useCrews, useSaveSettings, useSetBudgets, useSettings } from '@/lib/queries'

const MAX_CAP = 100_000

function CapBar({ cap, warnPct, label }: { cap: BudgetProgress; warnPct: number; label: string }) {
  const pct = Math.min(100, Math.round(cap.pct))
  const tone = cap.pct >= 100 ? 'bg-red-400' : cap.pct >= warnPct ? 'bg-amber-400' : 'bg-emerald-400'
  return (
    <div className="space-y-1">
      <div
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={pct}
        aria-valuetext={`${usd(cap.spentUsd)} of ${usd(cap.capUsd)}`}
        className="bg-muted relative h-2 w-full rounded-full"
      >
        <div className={`h-full rounded-full ${tone}`} style={{ width: `${pct}%` }} />
        <div className="bg-foreground/60 absolute top-[-2px] h-3 w-px" style={{ left: `${Math.min(100, warnPct)}%` }} title={`Warns at ${warnPct}%`} aria-hidden />
      </div>
      <div className="text-muted-foreground text-[11px] tabular-nums">
        {usd(cap.spentUsd)} of {usd(cap.capUsd)} ({Math.round(cap.pct)}%)
      </div>
    </div>
  )
}

// One cap: spend against it and an editable amount (0 = no cap).
function CapRow({ name, value, progress, warnPct, busy, onCap }: { name: string; value: number; progress: BudgetProgress | null | undefined; warnPct: number; busy: boolean; onCap: (usd: number) => void }) {
  const id = `budget-${name.replace(/\W+/g, '-')}`
  return (
    <div className="space-y-1.5 py-2.5">
      <div className="flex items-center gap-2">
        <label htmlFor={id} className="min-w-0 flex-1 truncate text-xs font-medium" title={name}>
          {name}
        </label>
        <NumberField id={id} aria-label={`${name} cap in USD`} min={0} max={MAX_CAP} step="0.5" value={value} disabled={busy} className="h-7 w-20 text-xs" onCommit={onCap} />
        <span className="text-muted-foreground text-[11px]">USD</span>
      </div>
      {progress ? <CapBar cap={progress} warnPct={warnPct} label={`${name} spend against cap`} /> : <p className="text-muted-foreground text-[11px]">No cap applies</p>}
    </div>
  )
}

// A cap for the day and one for each project; they warn at the warning percentage.
export function BudgetsEditor() {
  const budgets = useBudgets()
  const settings = useSettings()
  const crews = useCrews()
  const setBudgets = useSetBudgets()
  const saveSettings = useSaveSettings()
  const b = budgets.data
  const s = settings.data
  if (!b || !s) return <p className="text-muted-foreground px-1 text-xs">{budgets.error ? 'Budgets could not be loaded.' : 'Loading...'}</p>

  const cfg = b.config
  const warnPct = s.tokens.capWarnPct
  const busy = setBudgets.isPending || saveSettings.isPending
  const err = setBudgets.error ?? saveSettings.error
  const patch = (p: Partial<BudgetConfig>) => setBudgets.mutate([p])

  return (
    <div className="space-y-3">
      <p className="text-muted-foreground text-[11px]">A cap warns at {warnPct}% of its amount (Settings, Tokens).</p>

      <div className="divide-y">
        <CapRow name="Day" value={s.dailyBudgetUsd} progress={null} warnPct={warnPct} busy={busy} onCap={(v) => saveSettings.mutate({ dailyBudgetUsd: v })} />
        {(crews.data ?? []).map((c) => (
          <CapRow
            key={c.id}
            name={`Project ${c.name}`}
            value={cfg.projectDailyUsd[String(c.id)] ?? 0}
            progress={b.projects.find((p) => p.crewId === c.id)}
            warnPct={warnPct}
            busy={busy}
            onCap={(v) => patch({ projectDailyUsd: { [String(c.id)]: v } })}
          />
        ))}
      </div>

      {err && (
        <p role="alert" className="text-destructive text-xs">
          {decodeIpcError(err).message}
        </p>
      )}
    </div>
  )
}
