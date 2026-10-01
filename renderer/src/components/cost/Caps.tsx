import type { CapProgress } from '@shared/types'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { usd } from '@/lib/format'
import { CommitInput } from '@/components/settings/parts'

export const raisedCap = (capUsd: number) => Math.max(capUsd + 1, Math.ceil(capUsd * 1.5 * 2) / 2)

export function CapBar({ cap, warnPct, label }: { cap: CapProgress; warnPct: number; label: string }) {
  const pct = Math.min(100, Math.round(cap.pct))
  const tone = cap.paused ? 'bg-red-400' : cap.pct >= warnPct ? 'bg-amber-400' : 'bg-emerald-400'
  return (
    <div className="space-y-1">
      <div
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={pct}
        aria-valuetext={`${usd(cap.spentUsd)} of ${usd(cap.capUsd)}${cap.paused ? ', paused' : ''}`}
        className="bg-muted relative h-2 w-full rounded-full"
      >
        <div className={`h-full rounded-full ${tone}`} style={{ width: `${pct}%` }} />
        <div
          className="bg-foreground/60 absolute top-[-2px] h-3 w-px"
          style={{ left: `${Math.min(100, warnPct)}%` }}
          title={`Warns at ${warnPct}%`}
          aria-hidden
        />
      </div>
      <div className="text-muted-foreground flex items-center gap-1.5 text-[11px] tabular-nums">
        {usd(cap.spentUsd)} of {usd(cap.capUsd)} ({Math.round(cap.pct)}%)
        {cap.paused && <Badge variant="destructive">Paused</Badge>}
      </div>
    </div>
  )
}

// One cap line: progress, an editable cap, and the Raise and Reset buttons.
export function CapEditor({
  name,
  cap,
  value,
  placeholder,
  warnPct,
  onSetCap,
  onRaise,
  onReset,
  busy,
  error,
}: {
  name: string
  cap: CapProgress | null
  // The stored cap text ('' = the default applies).
  value: string
  placeholder: string
  warnPct: number
  onSetCap: (usd: number | null) => void
  onRaise: (nextUsd: number) => void
  onReset: () => void
  busy: boolean
  error?: string | null
}) {
  const id = `cap-${name.replace(/\W+/g, '-')}`
  return (
    <div className="space-y-1.5">
      {cap ? (
        <CapBar cap={cap} warnPct={warnPct} label={`${name} spend against cap`} />
      ) : (
        <div className="text-muted-foreground text-[11px]">No cap applies</div>
      )}
      <div className="flex items-center gap-1.5">
        <label htmlFor={id} className="sr-only">
          {name} cap in USD
        </label>
        <CommitInput
          id={id}
          type="number"
          min={0}
          step="0.5"
          className="h-7 w-20 text-right text-xs tabular-nums"
          value={value}
          placeholder={placeholder}
          disabled={busy}
          onCommit={(v) => onSetCap(v.trim() === '' ? null : Math.max(0, Number(v) || 0))}
        />
        <Button
          size="xs"
          variant="outline"
          aria-label={`Raise ${name} cap`}
          disabled={busy || !cap}
          onClick={() => cap && onRaise(raisedCap(cap.capUsd))}
        >
          Raise
        </Button>
        <Button size="xs" variant="outline" aria-label={`Reset ${name} cap`} disabled={busy || !cap} onClick={onReset}>
          Reset
        </Button>
      </div>
      {error && (
        <div role="alert" className="text-destructive text-[11px]">
          {error}
        </div>
      )}
    </div>
  )
}
