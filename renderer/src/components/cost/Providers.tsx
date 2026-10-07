import { RefreshCw } from 'lucide-react'
import { decodeIpcError } from '@shared/ipc'
import type { ProviderState, ProviderStatus, ProviderWindow } from '@shared/types'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { compact, timeAgo, usd } from '@/lib/format'
import { useProviders, useRefreshProviders } from '@/lib/queries'

export const LIMIT_ALERT_PCT = 80

const STATE_LABEL: Record<ProviderState, string> = {
  ok: 'Live',
  estimate: 'Estimate',
  error: 'Error',
  off: 'Off',
  'rate-limited': 'Busy',
  'signed-out': 'Signed out',
}

function resetText(at: number | null): string | null {
  if (at == null) return null
  const ms = at - Date.now()
  const when = new Date(at).toLocaleString(undefined, { weekday: 'short', hour: '2-digit', minute: '2-digit' })
  if (ms <= 0) return `reset ${when}`
  const m = Math.round(ms / 60_000)
  const left = m < 60 ? `${m}m` : m < 2880 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${Math.round(m / 1440)}d`
  return `resets in ${left} (${when})`
}

function WindowBar({ w, providerName }: { w: ProviderWindow; providerName: string }) {
  const pct = w.usedPct == null ? null : Math.max(0, Math.min(100, w.usedPct))
  const tone = pct == null ? 'bg-muted-foreground' : pct >= 95 ? 'bg-red-400' : pct >= LIMIT_ALERT_PCT ? 'bg-amber-400' : 'bg-emerald-400'
  const amount = w.used != null ? `${compact(w.used)}${w.limit != null ? ` of ${compact(w.limit)}` : ''} ${w.unit === 'percent' ? '' : w.unit}`.trim() : null
  const reset = resetText(w.resetsAt)
  return (
    <div className="space-y-1">
      <div className="flex items-baseline justify-between gap-2 text-xs">
        <span>{w.label}</span>
        <span className="text-muted-foreground tabular-nums">{pct == null ? 'no figure' : `${Math.round(pct)}% used`}</span>
      </div>
      {pct != null && (
        <div
          role="progressbar"
          aria-label={`${providerName} ${w.label}`}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(pct)}
          aria-valuetext={`${Math.round(pct)}% used${reset ? `, ${reset}` : ''}`}
          className="bg-muted h-2 w-full overflow-hidden rounded-full"
        >
          <div className={`h-full rounded-full ${tone}`} style={{ width: `${pct}%` }} />
        </div>
      )}
      <div className="text-muted-foreground flex flex-wrap gap-x-3 text-[11px]">
        {amount && <span>{amount}</span>}
        {w.remaining != null && <span>{compact(w.remaining)} left</span>}
        {reset && <span>{reset}</span>}
      </div>
    </div>
  )
}

function ProviderCard({ p }: { p: ProviderStatus }) {
  const noData = p.windows.length === 0 && p.rows.length === 0 && p.balance == null
  return (
    <section aria-label={`${p.name} usage`} className="bg-card space-y-2 rounded-lg border px-3.5 py-3">
      <div className="flex flex-wrap items-center gap-2">
        <h4 className="text-sm font-medium">{p.name}</h4>
        <Badge variant={p.state === 'error' ? 'destructive' : 'outline'}>{STATE_LABEL[p.state]}</Badge>
        {p.estimate && <Badge variant="secondary">Estimate from tokens</Badge>}
        {p.fetchedAt != null && <span className="text-muted-foreground ml-auto text-[11px]">Updated {timeAgo(p.fetchedAt)}</span>}
      </div>
      {p.windows.map((w) => (
        <WindowBar key={w.id} w={w} providerName={p.name} />
      ))}
      {p.balance && (
        <p className="text-xs">
          Balance <span className="font-medium tabular-nums">{p.balance.currency === 'USD' ? usd(p.balance.amount) : `${p.balance.amount} ${p.balance.currency}`}</span>
        </p>
      )}
      {p.rows.length > 0 && (
        <table className="w-full text-[11px]">
          <caption className="sr-only">{p.name} usage per provider</caption>
          <thead className="text-muted-foreground">
            <tr>
              <th scope="col" className="py-1 text-left font-medium">Provider</th>
              <th scope="col" className="py-1 text-right font-medium">Input</th>
              <th scope="col" className="py-1 text-right font-medium">Output</th>
              <th scope="col" className="py-1 text-right font-medium">Cost</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {p.rows.map((r) => (
              <tr key={r.provider}>
                <th scope="row" className="py-1 text-left font-normal">{r.provider || 'unknown'}</th>
                <td className="py-1 text-right tabular-nums">{compact(r.inputTokens)}</td>
                <td className="py-1 text-right tabular-nums">{compact(r.outputTokens)}</td>
                <td className="py-1 text-right tabular-nums">
                  {usd(r.costUsd)}
                  {r.estimate && <span className="text-muted-foreground"> (estimate)</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {noData && <p className="text-muted-foreground text-xs">No data{p.note ? `: ${p.note}` : '.'}</p>}
      {!noData && p.note && <p className="text-muted-foreground text-[11px]">{p.note}</p>}
    </section>
  )
}

// What the services behind the CLIs report: plan windows, per-provider usage, balances. Never shows a key.
export function ProvidersSection() {
  const q = useProviders()
  const refresh = useRefreshProviders()
  return (
    <section aria-label="Provider usage" className="space-y-2">
      <div className="flex items-center gap-2">
        <h3 className="text-sm font-medium">Provider usage</h3>
        <Button size="xs" variant="outline" className="ml-auto" aria-label="Refresh provider usage" disabled={refresh.isPending} onClick={() => refresh.mutate()}>
          <RefreshCw className={refresh.isPending ? 'animate-spin' : ''} /> Refresh
        </Button>
      </div>
      {(q.error || refresh.error) && (
        <p role="alert" className="text-destructive text-xs">
          {decodeIpcError(refresh.error ?? q.error).message}
        </p>
      )}
      {!q.data ? (
        <p className="text-muted-foreground px-1 text-xs">{q.error ? 'Provider usage could not be loaded.' : 'Loading...'}</p>
      ) : (
        <div className="space-y-2">
          {q.data.providers.map((p) => (
            <ProviderCard key={p.id} p={p} />
          ))}
        </div>
      )}
    </section>
  )
}

// Windows at or past the alert threshold, for the header badge.
export function useLimitAlerts() {
  const q = useProviders()
  const hot: Array<{ provider: string; window: string; pct: number; resetsAt: number | null }> = []
  for (const p of q.data?.providers ?? []) {
    for (const w of p.windows) if (w.usedPct != null && w.usedPct >= LIMIT_ALERT_PCT) hot.push({ provider: p.name, window: w.label, pct: w.usedPct, resetsAt: w.resetsAt })
  }
  return hot
}
