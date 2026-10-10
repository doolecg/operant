import type { ClaudeSessionStatus } from '@shared/claude-mods'
import { compact } from '@/lib/format'
import { contextView } from '@/lib/context'
import { cn } from '@/lib/utils'

// Token counts as the brief writes them: 90k, 1M.
const tokens = (n: number) => compact(n).replace(/m$/, 'M')

// Segment colours are theme tokens only, so every theme renders the bar.
const SEGMENT_CLASS: Record<string, string> = {
  input: 'bg-primary',
  cacheRead: 'bg-primary/55',
  cacheWrite: 'bg-primary/25',
  used: 'bg-primary',
  free: 'bg-muted',
}

// The context card: a rounded card with the used and total tokens, a percent pill in the warn and danger colours, a
// segmented bar and a legend. Shows nothing invented: unknown values are left out.
export function ContextCard({
  status,
  warn,
  danger,
  compactAt = null,
  className,
}: {
  status: ClaudeSessionStatus | null
  warn: number
  danger: number
  compactAt?: number | null
  className?: string
}) {
  const v = contextView(status, compactAt)
  if (!v) {
    return (
      <section aria-label="Context" className={cn('bg-card rounded-2xl border p-3 text-xs', className)}>
        <h3 className="font-medium">◆ context</h3>
        <p className="text-muted-foreground mt-1">No context reported yet.</p>
      </section>
    )
  }
  const pct = Math.round(v.pct)
  const tone = pct >= danger ? 'text-red-400 border-red-400/40' : pct >= warn ? 'text-amber-400 border-amber-400/40' : 'text-muted-foreground'
  return (
    <section aria-label="Context" className={cn('bg-card rounded-2xl border p-3 text-xs', className)}>
      <header className="flex items-center justify-between gap-2">
        <h3 className="font-medium">◆ context</h3>
        <span className="text-muted-foreground truncate font-mono text-[10px]">
          {`${tokens(v.used)} of ${tokens(v.size)}`}
          {v.compactAt !== null && ` · compacts at ${tokens(v.compactAt)}`}
        </span>
        <span className={cn('shrink-0 rounded-full border px-2 py-0.5 font-mono text-[11px]', tone)}>{`${pct}%`}</span>
      </header>
      <div className="bg-muted mt-2.5 flex h-2.5 overflow-hidden rounded-full" role="img" aria-label={`Context ${pct}% used`}>
        {v.segments.map((s) => (
          <span key={s.key} className={cn('h-full', SEGMENT_CLASS[s.key])} style={{ width: `${Math.max(0, Math.min(100, s.pct))}%` }} />
        ))}
      </div>
      <ul className="mt-2.5 grid grid-cols-2 gap-x-3 gap-y-1.5">
        {v.segments.map((s) => (
          <li key={s.key} className="flex min-w-0 items-center gap-1.5">
            <span className={cn('size-2 shrink-0 rounded-sm', SEGMENT_CLASS[s.key])} aria-hidden />
            <span className="truncate">{s.label}</span>
            <span className="text-muted-foreground ml-auto font-mono text-[10px]">{`${tokens(s.tokens)} ${s.pct.toFixed(s.pct < 10 ? 1 : 0)}%`}</span>
          </li>
        ))}
      </ul>
      {!v.breakdown && <p className="text-muted-foreground mt-2 text-[10px]">Only the total is reported by the status line.</p>}
      <p className="text-muted-foreground mt-2 text-[10px]">Category breakdown is only available from /context inside Claude</p>
    </section>
  )
}
