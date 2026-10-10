import { useEffect, useState } from 'react'
import type { ChatState, ContextRowId, ContextUsage } from '@shared/claude-chat'
import { bridge } from '@/lib/bridge'
import { usd } from '@/lib/format'
import { useSettings } from '@/lib/queries'
import { cn } from '@/lib/utils'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { contextHeadline, contextTone, kTokens, type ContextTone } from './chatHelpers'
import { useChatState } from './useChat'

const SWATCH: Record<ContextRowId, string> = {
  system: 'bg-ctx-system',
  tools: 'bg-ctx-tools',
  mcp: 'bg-ctx-mcp',
  agents: 'bg-ctx-agents',
  memory: 'bg-ctx-memory',
  skills: 'bg-ctx-skills',
  messages: 'bg-ctx-messages',
  other: 'bg-muted-foreground',
  free: 'bg-ctx-free',
}
const LEGEND: Record<ContextRowId, string> = {
  system: 'system prompt',
  tools: 'tools',
  mcp: 'mcp tools',
  agents: 'agents',
  memory: 'memory files',
  skills: 'skills',
  messages: 'messages',
  other: 'other',
  free: 'free',
}
const PILL: Record<ContextTone, string> = { ok: 'bg-success/15 text-success', warn: 'bg-warning/15 text-warning', danger: 'bg-destructive/15 text-destructive' }
const RING: Record<ContextTone, string> = { ok: 'var(--muted-foreground)', warn: 'var(--warning)', danger: 'var(--destructive)' }

function pctOf(state: ChatState | null, usage: ContextUsage | null): number | null {
  const p = usage?.percentage ?? state?.context?.percentage ?? null
  return p === null ? null : Math.round(p)
}

// The card: header, one segmented bar with the compaction tick, the legend, and the session cost. The only place the
// chat shows context, tokens and cost.
export function ContextCard({ state, usage, warn, danger }: { state: ChatState; usage: ContextUsage | null; warn: number; danger: number }) {
  const pct = pctOf(state, usage)
  const tone = contextTone(pct ?? 0, warn, danger)
  const running = state.turn.phase === 'working'
  return (
    <div role="region" aria-label="Context window" className="px-4 py-3.5" title="Estimated by Claude Code, from its context report">
      <header className="flex items-center gap-2 text-[13px]">
        <b className="font-semibold whitespace-nowrap">
          <span className="text-primary">◆</span> context window
        </b>
        {usage ? (
          <span className="text-muted-foreground ml-auto text-xs whitespace-nowrap">{contextHeadline(usage.totalTokens, usage.maxTokens, usage.autoCompactAt)}</span>
        ) : state.context ? (
          <span className="text-muted-foreground ml-auto text-xs whitespace-nowrap">
            {kTokens(state.context.usedTokens)}
            {state.context.windowTokens ? ` of ${kTokens(state.context.windowTokens)}` : ''}
          </span>
        ) : (
          <span className="ml-auto" />
        )}
        {pct !== null && <span className={cn('rounded-full px-2 text-xs font-semibold', PILL[tone])}>{pct}%</span>}
      </header>
      {usage ? (
        <>
          <div className="bg-ctx-free relative my-3.5 flex h-[5px] rounded-full" role="img" aria-label={`Context ${pct ?? 0}% used`}>
            {usage.rows
              .filter((r) => r.id !== 'free')
              .map((r) => (
                <i key={r.id} className={cn('block h-full first:rounded-l-full', SWATCH[r.id])} style={{ width: `${r.pct}%` }} />
              ))}
            {usage.tickPct !== null && <i aria-hidden className="bg-ctx-tick absolute -top-[3px] h-[11px] w-0.5 rounded-[1px]" style={{ left: `${usage.tickPct}%` }} title="Auto-compaction starts here" />}
          </div>
          <div className="grid grid-cols-2 gap-x-[18px] gap-y-[7px] text-xs">
            {usage.rows.map((r) => (
              <span key={r.id} title={r.note} className="flex items-center gap-[7px] whitespace-nowrap">
                <i className={cn('size-2 rounded-[2px]', SWATCH[r.id])} />
                {LEGEND[r.id]}
                <b className="ml-auto font-semibold">{kTokens(r.tokens)}</b>
                <em className="text-muted-foreground w-[26px] text-right not-italic">{r.id === 'free' ? '' : `${Math.round(r.pct)}%`}</em>
              </span>
            ))}
          </div>
        </>
      ) : (
        <p className="text-muted-foreground my-3 text-xs">{running ? 'The breakdown updates after this turn.' : 'Loading the breakdown…'}</p>
      )}
      <div className="text-muted-foreground border-border mt-3 flex justify-between border-t pt-2.5 text-xs">
        <span>This session</span>
        <b className="text-foreground font-normal">{state.costUsd === null ? '—' : state.costUsd > 0 && state.costUsd < 0.01 ? '<$0.01' : usd(state.costUsd)}</b>
      </div>
    </div>
  )
}

// The small ring + percent in the tile header; opens the card (asking Claude Code for a fresh report).
export function ContextButton({ scratchId }: { scratchId: number }) {
  const state = useChatState(scratchId)
  const settings = useSettings().data
  const warn = settings?.contextWarnPct ?? 60
  const danger = settings?.contextDangerPct ?? 85
  const [open, setOpen] = useState(false)
  const [fresh, setFresh] = useState<ContextUsage | null>(null)
  useEffect(() => {
    if (!open) return
    let live = true
    bridge()
      .invoke('chat:requestContext', scratchId)
      .then((u) => live && u && setFresh(u))
      .catch(() => {})
    return () => {
      live = false
    }
  }, [open, scratchId])
  if (!state) return null
  const usage = fresh && (!state.contextUsage || fresh.updatedAt >= state.contextUsage.updatedAt) ? fresh : state.contextUsage
  const pct = pctOf(state, usage)
  const tone = contextTone(pct ?? 0, warn, danger)
  const deg = Math.min(100, pct ?? 0)
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        aria-label={`Context window${pct === null ? '' : `, ${pct}% used`}`}
        className={cn('text-muted-foreground hover:bg-accent hover:text-foreground inline-flex items-center gap-1.5 rounded-lg px-2 py-[3px] text-[13px]', open && 'bg-accent text-foreground')}
      >
        <span
          aria-hidden
          className="size-3.5 rounded-full"
          style={{
            background: `conic-gradient(${RING[tone]} 0 ${deg}%, var(--input) ${deg}% 100%)`,
            WebkitMask: 'radial-gradient(circle, transparent 4px, #000 4.5px)',
            mask: 'radial-gradient(circle, transparent 4px, #000 4.5px)',
          }}
        />
        {pct === null ? '—' : `${pct}%`}
      </PopoverTrigger>
      <PopoverContent align="end" className="w-[410px]">
        <ContextCard state={state} usage={usage} warn={warn} danger={danger} />
      </PopoverContent>
    </Popover>
  )
}
