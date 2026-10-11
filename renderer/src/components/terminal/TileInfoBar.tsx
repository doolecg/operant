import { useQuery } from '@tanstack/react-query'
import { Folder, GitBranch } from 'lucide-react'
import type { ClaudeSessionStatus } from '@shared/claude-mods'
import type { Crew } from '@shared/types'
import { compact, usd } from '@/lib/format'
import { call, useClaudeTileState, useGitInfo, usePresets, useSettings } from '@/lib/queries'
import { cn } from '@/lib/utils'
import { pill } from '@/components/topbar/pill'
import { ContextCard } from '@/components/mods/ContextCard'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import type { TerminalTab } from './useTerminals'

const NA = 'n/a'

// Tokens of the current context: what the status line reports for the last request. Unknown stays unknown.
function contextTokens(s: ClaudeSessionStatus | null): number | null {
  const u = s?.currentUsage
  if (!u) return null
  return (u.inputTokens ?? 0) + (u.cacheCreationTokens ?? 0) + (u.cacheReadTokens ?? 0)
}

const costText = (n: number) => (n > 0 && n < 0.01 ? '<$0.01' : usd(n))

// Only the folder and branch shrink (and truncate); the others keep their width so no text runs into the next item.
function Item({ label, children, title, shrink }: { label: string; children: React.ReactNode; title?: string; shrink?: boolean }) {
  return (
    <span title={title} className={cn('inline-flex items-center gap-1', shrink ? 'min-w-0 overflow-hidden' : 'shrink-0')}>
      <span className="sr-only">{label}: </span>
      {children}
    </span>
  )
}

// The thin row under a tile's title: model, context, tokens, cost, folder and branch. Values Operant cannot observe show as n/a.
// The state pill in a tile's header. Claude tiles follow the hook-derived phase; the others only show "Exited".
export function TileStatus({ tile }: { tile: TerminalTab }) {
  const claude = tile.kind === 'claude'
  const state = useClaudeTileState(claude ? tile.scratchId : null).data
  let dot: string | null = null
  let label = ''
  if (tile.exited || (claude && state?.ptyRunning === false)) [dot, label] = ['bg-destructive', 'Exited']
  else if (claude && state) {
    const { phase, waiting } = state.session
    if (phase === 'waiting') [dot, label] = ['bg-warning', waiting?.type === 'permission_prompt' ? 'Needs you' : 'Waiting']
    else if (phase === 'working') [dot, label] = ['bg-working animate-pulse', 'Working']
    else if (phase === 'done') [dot, label] = ['bg-success', 'Done']
    else if (phase === 'idle') [dot, label] = ['bg-muted-foreground/60', 'Idle']
  }
  if (!dot) return null
  return (
    <span role="status" className={cn(pill, 'text-muted-foreground text-[11px]')}>
      <span className={cn('size-1.5 rounded-full', dot)} aria-hidden />
      {label}
    </span>
  )
}

export function TileInfoBar({ tile, crew }: { tile: TerminalTab; crew: Crew | undefined }) {
  const enabled = useSettings().data?.infoBar ?? true
  const warn = useSettings().data?.contextWarnPct ?? 60
  const danger = useSettings().data?.contextDangerPct ?? 85
  const claude = tile.kind === 'claude'
  const state = useClaudeTileState(claude ? tile.scratchId : null).data
  const status = state?.status ?? null
  // The tile's context cap (its preset's), when set: the card says where auto-compaction runs.
  const scratch = useQuery({
    queryKey: ['scratchList', crew?.id ?? -1],
    queryFn: () => call('scratch:list', crew!.id),
    enabled: claude && !!crew,
  }).data?.find((s) => s.id === tile.scratchId)
  const cap = usePresets().data?.find((p) => p.id === scratch?.presetId)?.contextCap ?? 0
  const git = useGitInfo(crew?.id ?? null).data
  const branch = git?.branch
  const spend = useQuery({
    queryKey: ['scratchSpend', crew?.id ?? -1],
    queryFn: () => call('scratch:spend', crew!.id),
    enabled: !claude && !!crew,
    refetchInterval: 30_000,
  }).data
  if (!enabled) return null

  const used = status?.usedPercentage
  const pct = used === undefined ? null : Math.round(used)
  const tokens = contextTokens(status)
  const max = status?.contextWindowSize
  const folder = crew?.folder.split(/[\/]/).filter(Boolean).pop()
  const cost = claude ? status?.costUsd : spend?.find((r) => r.scratchId === tile.scratchId)?.costUsd
  const tone = pct === null ? '' : pct >= danger ? 'bg-red-500' : pct >= warn ? 'bg-amber-400' : 'bg-primary'

  return (
    <div aria-label="Tile info" className="text-muted-foreground flex h-7 shrink-0 items-center gap-3 overflow-hidden border-b px-3 pb-1 font-mono text-[11px] whitespace-nowrap">
      <Item label="Model">{claude ? (status?.model ?? NA) : NA}</Item>
      <Item label="Context" title={claude ? undefined : 'Context is not reported by OpenCode'}>
        {claude ? (
          <Popover>
            <PopoverTrigger aria-label="Context details" className="inline-flex min-w-0 items-center gap-1.5 hover:text-foreground">
            <span className="bg-foreground/10 relative h-1.5 w-20 overflow-hidden rounded-full" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct ?? undefined} aria-label="Context used">
              <span className={cn('absolute inset-y-0 left-0 rounded-full', tone)} style={{ width: `${Math.min(100, Math.max(0, pct ?? 0))}%` }} />
            </span>
            <span className={cn(pct !== null && pct >= danger && 'text-red-400', pct !== null && pct >= warn && pct < danger && 'text-amber-400')}>
              {`${tokens === null ? NA : compact(tokens)} / ${max === undefined ? NA : compact(max)} (${pct === null ? NA : `${pct}%`})`}
            </span>
            </PopoverTrigger>
            <PopoverContent align="end" className="w-80 border-0 bg-transparent p-0 shadow-none">
              <ContextCard status={status} warn={warn} danger={danger} compactAt={cap > 0 ? cap : null} />
            </PopoverContent>
          </Popover>
        ) : (
          'unavailable'
        )}
      </Item>
      <Item label="Tokens">
        {claude && status?.currentUsage
          ? `in ${compact(status.currentUsage.inputTokens ?? 0)} out ${compact(status.currentUsage.outputTokens ?? 0)}`
          : 'unavailable'}
      </Item>
      <Item label="Cost" title={claude ? undefined : 'Spend over the last 24 hours'}>
        {cost === undefined ? NA : costText(cost)}
        {!claude && cost !== undefined && <span className="text-muted-foreground/70"> 24h</span>}
      </Item>
      {folder && (
        <Item label="Folder" title={crew?.folder} shrink>
          <Folder className="size-3 shrink-0" aria-hidden />
          <span className="truncate">{folder}</span>
        </Item>
      )}
      {branch && (
        <Item label="Branch" shrink>
          <GitBranch className="size-3 shrink-0" aria-hidden />
          <span className="truncate">{branch}</span>
          {git && git.changes > 0 ? (
            <span className="text-amber-400">· {git.changes} changed</span>
          ) : git && (git.ahead > 0 || git.behind > 0) ? (
            <span>· {[git.ahead > 0 && `↑${git.ahead}`, git.behind > 0 && `↓${git.behind}`].filter(Boolean).join(' ')}</span>
          ) : (
            <span>· clean</span>
          )}
        </Item>
      )}
    </div>
  )
}
