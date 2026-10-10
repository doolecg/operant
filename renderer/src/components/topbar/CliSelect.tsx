import { RefreshCw } from 'lucide-react'
import type { MainCli } from '@shared/settings'
import { CLI_NAME, CLI_SHORT, MAIN_CLIS } from '@/lib/capabilities'
import { useCapabilities, useRefreshCapabilities, useSaveSettings, useSettings } from '@/lib/queries'
import { cn } from '@/lib/utils'
import { pillBtn } from './pill'

// The terminal CLI for new tiles, as a compact pill track. A CLI that is missing shows a short notice with Retry;
// the rest of the bar keeps working.
export function CliSelect() {
  const cli = useSettings().data?.mainCli ?? 'claude'
  const save = useSaveSettings()
  const caps = useCapabilities()
  const refresh = useRefreshCapabilities()
  const cap = caps.data?.[cli]
  const missing = !!cap && !cap.installed
  const failed = caps.isError

  return (
    <div className="flex min-w-0 shrink-0 items-center gap-1.5">
      <div role="group" aria-label="Terminal CLI" className="bg-foreground/5 flex shrink-0 items-center gap-1 rounded-full p-[3px]">
        {MAIN_CLIS.map((c: MainCli) => (
          <button
            key={c}
            type="button"
            data-cli={c}
            aria-pressed={c === cli}
            aria-label={CLI_NAME[c]}
            title={cap?.installed === false && c === cli ? `${CLI_NAME[c]} is not installed` : CLI_NAME[c]}
            onClick={() => c !== cli && save.mutate({ mainCli: c })}
            className={cn(
              'h-[22px] rounded-full px-2.5 text-xs outline-none transition-colors focus-visible:ring-[3px] focus-visible:ring-ring/50',
              c === cli ? 'bg-foreground/15 font-semibold' : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {CLI_SHORT[c]}
          </button>
        ))}
      </div>
      {(missing || failed) && (
        <span role="status" className="text-destructive flex min-w-0 items-center gap-1 text-[11px]">
          <span className="truncate">{failed ? 'CLI check failed' : `${CLI_SHORT[cli]} not found`}</span>
          <button type="button" className={cn(pillBtn, 'h-5 px-2')} onClick={() => refresh.mutate()} disabled={refresh.isPending}>
            <RefreshCw className={cn('size-3', refresh.isPending && 'animate-spin')} />
            Retry
          </button>
        </span>
      )}
    </div>
  )
}
