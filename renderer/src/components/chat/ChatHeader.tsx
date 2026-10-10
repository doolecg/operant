import { tileState } from '@shared/claude-chat'
import type { ScratchView } from '@shared/types'
import { cn } from '@/lib/utils'
import { ContextButton } from './ContextPopover'
import { useChatState } from './useChat'

// The tile header's parts for a Claude tile. TileFrame draws the icon, title, fullscreen and close; these fill the rest.

const DOT: Record<string, string> = {
  Working: 'bg-primary motion-safe:animate-pulse',
  'Waiting for you': 'bg-warning',
  Stopped: 'bg-destructive',
  Crashed: 'bg-destructive',
}

// Dot + word next to the title; clicking "Waiting for you" scrolls to the pending card.
export function ChatStateBadge({ scratchId }: { scratchId: number }) {
  const state = useChatState(scratchId)
  if (!state) return null
  const word = tileState(state)
  const dot = DOT[word]
  const waiting = word === 'Waiting for you'
  const body = (
    <>
      {dot && <i aria-hidden className={cn('size-[7px] rounded-full', dot)} />}
      {word}
    </>
  )
  const cls = cn('inline-flex items-center gap-1.5 text-[13px]', waiting ? 'text-warning' : word === 'Working' ? 'text-muted-foreground' : word === 'Idle' ? 'text-muted-foreground/70' : 'text-destructive')
  return waiting ? (
    <button
      type="button"
      title="Jump to the question"
      onClick={() => document.querySelector(`[data-tile="scratch:${scratchId}"] [data-pending]`)?.scrollIntoView({ block: 'center', behavior: 'smooth' })}
      className={cn(cls, 'hover:underline')}
      role="status"
    >
      {body}
    </button>
  ) : (
    <span role="status" className={cls}>
      {body}
    </span>
  )
}

// Chat | Terminal on the same session. Chat tiles may only switch between turns.
export function ViewSwitch({ view, blockedReason, onChange }: { view: ScratchView; blockedReason: string | null; onChange: (v: ScratchView) => void }) {
  const opt = (v: ScratchView, label: string) => (
    <button
      key={v}
      type="button"
      aria-pressed={view === v}
      disabled={view !== v && !!blockedReason}
      title={view !== v ? (blockedReason ?? undefined) : undefined}
      onClick={() => view !== v && onChange(v)}
      className={cn('rounded-full px-[11px] py-px text-[13px] disabled:cursor-not-allowed disabled:opacity-50', view === v ? 'bg-card text-foreground' : 'text-muted-foreground hover:text-foreground')}
    >
      {label}
    </button>
  )
  return (
    <div role="group" aria-label="View" className="bg-accent flex rounded-full p-0.5">
      {opt('chat', 'Chat')}
      {opt('terminal', 'Terminal')}
    </div>
  )
}

// Chat view: the context ring and the view switch. The switch is enabled only between turns.
export function ChatHeaderControls({ scratchId, onView }: { scratchId: number; onView: (v: ScratchView) => void }) {
  const state = useChatState(scratchId)
  const busy = !!state && state.turn.phase !== 'idle' && state.process === 'ready'
  return (
    <>
      <ContextButton scratchId={scratchId} />
      <ViewSwitch view="chat" blockedReason={busy ? 'Switch views when Claude is not working' : null} onChange={onView} />
    </>
  )
}
