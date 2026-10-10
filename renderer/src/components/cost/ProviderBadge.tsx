import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { useLimitAlerts } from './Providers'
import { useProviders } from '@/lib/queries'

const FIVE_HOUR = /5[\s-]?h|five|hour|session/i
const WEEK = /week|7[\s-]?day/i

interface Win {
  label: string
  pct: number
  resetsAt: number | null
}

// "3h 20m", "2d 4h": the time until a window resets.
function untilReset(at: number): string {
  const ms = (at < 1e12 ? at * 1000 : at) - Date.now()
  if (ms <= 0) return 'resets now'
  const min = Math.round(ms / 60_000)
  const d = Math.floor(min / 1440)
  const h = Math.floor((min % 1440) / 60)
  const m = min % 60
  return `resets in ${d > 0 ? `${d}d ${h}h` : h > 0 ? `${h}h ${m}m` : `${m}m`}`
}

const R = 9
const C = 2 * Math.PI * R

// One window as a ring that fills with the share used (amber at 80% or more), the number in the middle.
function Ring({ label, pct }: { label: string; pct: number | null }) {
  const value = pct === null ? null : Math.min(100, Math.max(0, Math.round(pct)))
  const hot = value !== null && value >= 80
  return (
    <span className="relative inline-grid size-7 place-items-center" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={value ?? undefined} aria-label={label}>
      <svg aria-hidden viewBox="0 0 24 24" className="absolute inset-0 size-full -rotate-90">
        <circle cx="12" cy="12" r={R} fill="none" strokeWidth="2.5" className="stroke-foreground/10" />
        <circle
          cx="12"
          cy="12"
          r={R}
          fill="none"
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeDasharray={C}
          strokeDashoffset={C * (1 - (value ?? 0) / 100)}
          className={cn('transition-[stroke-dashoffset]', hot ? 'stroke-amber-400' : 'stroke-primary')}
        />
      </svg>
      <span aria-hidden className="text-[9px] leading-none font-semibold tabular-nums">
        {value === null ? '--' : value}
      </span>
    </span>
  )
}

// The usage badge of the sidebar footer, never hidden: Claude's 5-hour and weekly windows as rings (amber at 80% or more),
// the highest percentage as one ring when Claude reports none, dimmed when no provider reports usage. Hover for each
// window's label, share used and time to reset. Opens the Usage popout.
export function ProviderLimitBadge({ onOpen }: { onOpen: () => void }) {
  const hot = useLimitAlerts()
  const providers = useProviders().data?.providers ?? []
  const reported = providers.flatMap((p) => p.windows.filter((w) => w.usedPct != null).map((w) => ({ p, w: { label: w.label, pct: w.usedPct as number, resetsAt: w.resetsAt } })))
  const all = reported.map(({ p, w }) => ({ provider: p.name, window: w.label, pct: w.pct }))
  const claude: Win[] = reported.filter(({ p }) => p.id === 'claude' || /^claude/i.test(p.name)).map(({ w }) => w)
  const five = claude.find((w) => FIVE_HOUR.test(w.label))
  const week = claude.find((w) => WEEK.test(w.label) && !w.label.includes('(')) ?? claude.find((w) => WEEK.test(w.label))
  const pair = five && week ? [five, week] : claude.slice(0, 2)
  const shown = hot.length > 0 ? hot : all
  const text = shown.length === 0 ? 'no usage data' : shown.map((h) => `${h.provider} ${h.window} ${Math.round(h.pct)}% used`).join('; ')
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className={cn('gap-1 px-1', hot.length > 0 ? 'text-amber-400' : 'text-muted-foreground', shown.length === 0 && 'opacity-60')}
          aria-label={`Provider limits: ${text}`}
          onClick={onOpen}
        >
          {pair.length > 0 ? (
            pair.map((w) => <Ring key={w.label} label={w.label} pct={w.pct} />)
          ) : (
            <Ring label="Highest provider usage" pct={shown.length === 0 ? null : Math.max(...shown.map((h) => h.pct))} />
          )}
        </Button>
      </TooltipTrigger>
      <TooltipContent>
        {pair.length > 0 ? (
          <div className="space-y-1">
            {pair.map((w) => (
              <div key={w.label} className="flex items-baseline gap-3 text-xs">
                <span className="font-medium">{w.label}</span>
                <span className="tabular-nums">{Math.round(w.pct)}% used</span>
                {w.resetsAt != null && <span className="opacity-70">{untilReset(w.resetsAt)}</span>}
              </div>
            ))}
            <div className="text-[11px] opacity-70">Click for all providers</div>
          </div>
        ) : (
          text
        )}
      </TooltipContent>
    </Tooltip>
  )
}
