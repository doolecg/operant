import { Gauge } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { requestUsageTab } from './openUsage'
import { useLimitAlerts } from './Providers'

// Shown near the settings gear while a provider limit window is at 80% or more; opens the Usage tab.
export function ProviderLimitBadge({ onOpen }: { onOpen: () => void }) {
  const hot = useLimitAlerts()
  if (hot.length === 0) return null
  const text = hot.map((h) => `${h.provider} ${h.window} ${Math.round(h.pct)}% used`).join('; ')
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="gap-1 px-2 text-amber-400"
          aria-label={`Provider limits: ${text}`}
          onClick={() => {
            onOpen()
            requestUsageTab()
          }}
        >
          <Gauge className="size-4" />
          <span className="text-xs">{Math.round(Math.max(...hot.map((h) => h.pct)))}%</span>
        </Button>
      </TooltipTrigger>
      <TooltipContent>{text}</TooltipContent>
    </Tooltip>
  )
}
