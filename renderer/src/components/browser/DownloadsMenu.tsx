import { Download, FolderOpen, X } from 'lucide-react'
import { downloadPercent, formatBytes, isDownloadActive, isRiskyFile, type BrowserDownload } from '@shared/browser-prompts'
import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { cn } from '@/lib/utils'

interface Props {
  // The project's downloads, newest first.
  downloads: readonly BrowserDownload[]
  onOpen: (id: string) => void
  onShowInFolder: (id: string) => void
  onCancel: (id: string) => void
  disabled?: boolean
}

const rowBtn = 'size-6 shrink-0'

const stateText = (d: BrowserDownload): string => {
  if (d.state === 'completed') return `Done, ${formatBytes(d.received)}`
  if (d.state === 'cancelled') return 'Cancelled'
  if (d.state === 'interrupted') return 'Interrupted'
  const pct = downloadPercent(d)
  return pct === null ? `${formatBytes(d.received)} downloaded` : `${formatBytes(d.received)} of ${formatBytes(d.total)} (${String(pct)}%)`
}

// The toolbar's download button: a count badge and, in the menu, every download with its progress and actions.
export function DownloadsMenu({ downloads, onOpen, onShowInFolder, onCancel, disabled }: Props) {
  const active = downloads.filter(isDownloadActive).length
  const count = downloads.length
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="relative size-7 shrink-0"
          aria-label={count === 0 ? 'Downloads' : `Downloads (${String(count)}${active > 0 ? `, ${String(active)} in progress` : ''})`}
          title="Downloads"
          disabled={disabled}
        >
          <Download className={cn('size-3.5', active > 0 && 'text-primary')} />
          {count > 0 && (
            <span
              aria-hidden
              className="bg-primary text-primary-foreground absolute -top-0.5 -right-0.5 flex h-3.5 min-w-3.5 items-center justify-center rounded-full px-0.5 text-[9px] leading-none font-medium"
            >
              {count > 9 ? '9+' : count}
            </span>
          )}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-80">
        <DropdownMenuLabel>Downloads</DropdownMenuLabel>
        <DropdownMenuSeparator />
        {count === 0 ? (
          <div className="text-muted-foreground px-2 py-3 text-xs">Nothing downloaded yet.</div>
        ) : (
          <ul className="max-h-72 overflow-y-auto" aria-label="Downloads list">
            {downloads.map((d) => {
              const pct = downloadPercent(d)
              return (
                <li key={d.id} className="flex items-center gap-1.5 px-2 py-1.5 text-xs">
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-medium" title={d.path}>
                      {d.filename}
                    </div>
                    {isDownloadActive(d) && (
                      <div
                        role="progressbar"
                        aria-label={`Progress of ${d.filename}`}
                        aria-valuemin={0}
                        aria-valuemax={100}
                        aria-valuenow={pct ?? undefined}
                        className="bg-muted my-1 h-1 overflow-hidden rounded-full"
                      >
                        <div className={cn('bg-primary h-full', pct === null && 'w-1/3 animate-pulse')} style={pct === null ? undefined : { width: `${String(pct)}%` }} />
                      </div>
                    )}
                    <div className={cn('text-muted-foreground', d.state === 'interrupted' && 'text-destructive')}>{stateText(d)}</div>
                  </div>
                  {isDownloadActive(d) ? (
                    <Button type="button" variant="ghost" size="icon" className={rowBtn} aria-label={`Cancel download of ${d.filename}`} title="Cancel" onClick={() => onCancel(d.id)}>
                      <X className="size-3.5" />
                    </Button>
                  ) : d.state === 'completed' ? (
                    <>
                      {!isRiskyFile(d.filename) && (
                        <Button type="button" variant="ghost" size="sm" className="h-6 px-2 text-xs" aria-label={`Open ${d.filename}`} onClick={() => onOpen(d.id)}>
                          Open
                        </Button>
                      )}
                      <Button type="button" variant="ghost" size="icon" className={rowBtn} aria-label={`Show ${d.filename} in folder`} title="Show in folder" onClick={() => onShowInFolder(d.id)}>
                        <FolderOpen className="size-3.5" />
                      </Button>
                    </>
                  ) : null}
                </li>
              )
            })}
          </ul>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
