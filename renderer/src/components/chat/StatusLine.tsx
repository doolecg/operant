import type { ChatState } from '@shared/claude-chat'
import { cn } from '@/lib/utils'
import { formatDuration, kTokens } from './chatHelpers'
import { useNow } from './useChat'

// Above the composer while a turn runs: a turning coral ✻, the status word derived from real events, the turn time and
// the output tokens so far; "esc to interrupt" at the right. While a prompt is pending it points at the card instead.
export function StatusLine({ state }: { state: ChatState }) {
  const { turn } = state
  const active = turn.phase === 'working' || turn.phase === 'waiting'
  const now = useNow(active && turn.startedAt !== null)
  if (!active) return null
  const waiting = turn.pendingCount > 0
  const elapsed = turn.startedAt !== null ? Math.max(0, now - turn.startedAt) : turn.elapsedMs
  return (
    <div role="status" aria-label="Claude status" data-chat="status-line" className="mx-auto flex w-full max-w-[720px] items-center gap-2 px-5 pb-2 text-[13px]">
      <span aria-hidden className={cn('inline-block text-sm', waiting ? 'text-warning' : 'text-primary animate-[spin_2.4s_linear_infinite] motion-reduce:animate-none')}>
        ✻
      </span>
      {waiting ? (
        <span className="text-muted-foreground min-w-0 truncate">
          <span className="text-foreground">Needs your answer above</span>
          {turn.pendingLabel && <span> · {turn.pendingLabel}</span>}
        </span>
      ) : (
        <span className="text-muted-foreground min-w-0 truncate">
          <span className="text-foreground">{turn.word || 'Working…'}</span>
          {turn.startedAt !== null && <span> {formatDuration(elapsed)}</span>}
          {turn.outputTokens > 0 && <span> · ↓ {kTokens(turn.outputTokens)} tokens</span>}
        </span>
      )}
      <span className="text-muted-foreground/70 ml-auto shrink-0 text-xs">esc to interrupt</span>
    </div>
  )
}
