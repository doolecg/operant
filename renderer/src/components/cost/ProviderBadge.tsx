import { Gauge } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { requestUsageTab } from './openUsage'
import { cn } from '@/lib/utils'
import { useLimitAlerts } from './Providers'
import { useProviders } from '@/lib/queries'

// The usage badge of the sidebar footer, never hidden: amber at 80% or more of a provider limit window, plain with the highest
// percentage below that, dimmed "--%" when no provider reports usage. Opens the Usage tab.
export function ProviderLimitBadge({ onOpen }: { onOpen: () => void }) {
  const hot = useLimitAlerts()
  const all = (useProviders().data?.providers ?? []).flatMap((p) => p.windows.filter((w) => w.usedPct != null).map((w) => ({ provider: p.name, window: w.label, pct: w.usedPct as number })))
  const shown = hot.length > 0 ? hot : all
  const text = shown.length === 0 ? 'no usage data' : shown.map((h) => `${h.provider} ${h.window} ${Math.round(h.pct)}% used`).join('; ')
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className={cn('gap-1 px-2', hot.length > 0 ? 'text-amber-400' : 'text-muted-foreground', shown.length === 0 && 'opacity-60')}
          aria-label={`Provider limits: ${text}`}
          onClick={() => {
            onOpen()
            requestUsageTab()
          }}
        >
          <Gauge className="size-4" />
          <span className="text-xs">{shown.length === 0 ? '--' : Math.round(Math.max(...shown.map((h) => h.pct)))}%</span>
        </Button>
      </TooltipTrigger>
      <TooltipContent>{text}</TooltipContent>
    </Tooltip>
  )
}
