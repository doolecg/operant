import { useCallback, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { ArrowDown } from 'lucide-react'
import { cliBlocked } from '@/lib/capabilities'
import { useCapabilities } from '@/lib/queries'
import { cn } from '@/lib/utils'
import { Composer } from './Composer'
import { ConversationList } from './ConversationList'
import { StatusLine } from './StatusLine'
import { capItems, mainThread } from './chatHelpers'
import { selectAgent } from './agentSelection'
import { chatActions, useChatState } from './useChat'

const RENDER_CAP = 300
const NEAR_BOTTOM = 80

interface Props {
  scratchId: number
  // The effort the tile was launched with ("Default" in the effort popover).
  launchEffort: string | null
  // The tile's saved model (pending until Claude reports one).
  tileModel: string | null
  // Switches the tile to the Terminal view.
  onTerminal: () => void
}

// The Chat view of a Claude tile: the conversation (Claude's text on the background, owner messages as soft bubbles,
// tools as quiet rows, one bordered card per prompt), the running status line and the composer.
export function ChatView({ scratchId, launchEffort, tileModel, onTerminal }: Props) {
  const state = useChatState(scratchId)
  const caps = useCapabilities().data
  const scroller = useRef<HTMLDivElement>(null)
  const inner = useRef<HTMLDivElement>(null)
  const stuck = useRef(true)
  const [atBottom, setAtBottom] = useState(true)
  const [limit, setLimit] = useState(RENDER_CAP)
  const [loading, setLoading] = useState(false)

  const items = state?.items
  const main = useMemo(() => (items ? mainThread(items) : []), [items])
  const capped = useMemo(() => capItems(main, limit), [main, limit])

  const toBottom = useCallback(() => {
    const el = scroller.current
    if (el) el.scrollTop = el.scrollHeight
  }, [])

  // Follow the newest content while the owner has not scrolled away.
  useLayoutEffect(() => {
    const el = inner.current
    if (!el) return
    const ro = new ResizeObserver(() => stuck.current && toBottom())
    ro.observe(el)
    return () => ro.disconnect()
  }, [toBottom, state === null])
  useLayoutEffect(() => {
    if (stuck.current) toBottom()
  }, [items, toBottom])

  const onScroll = () => {
    const el = scroller.current
    if (!el) return
    const near = el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM
    stuck.current = near
    setAtBottom(near)
  }
  const jump = () => {
    stuck.current = true
    setAtBottom(true)
    toBottom()
  }

  const loadEarlier = async () => {
    if (capped.hidden > 0) return setLimit((l) => l + 200)
    const el = scroller.current
    const before = el?.scrollHeight ?? 0
    stuck.current = false
    setLoading(true)
    await chatActions.loadEarlier(scratchId)
    setLoading(false)
    setLimit((l) => l + 200)
    requestAnimationFrame(() => el && (el.scrollTop += el.scrollHeight - before))
  }

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key !== 'Escape' || e.defaultPrevented || !state) return
    if (state.turn.phase !== 'working' && state.turn.phase !== 'waiting') return
    if (document.querySelector('[data-radix-popper-content-wrapper]')) return
    chatActions.interrupt(scratchId)
  }

  if (!state) return <div className="text-muted-foreground grid h-full place-content-center text-[13px]">Loading the conversation…</div>

  const blockedReason = state.process === 'blocked' ? (cliBlocked(caps, 'claude') ?? 'Claude Code is missing or too old for the Chat view.') : null
  if (blockedReason)
    return (
      <div className="grid h-full place-content-center gap-3 p-6 text-center">
        <p className="text-muted-foreground max-w-sm text-[13px]">{blockedReason}</p>
        <div>
          <button type="button" onClick={onTerminal} className="border-border hover:bg-accent rounded-[9px] border px-3 py-[5px] text-[13px]">
            Open in Terminal
          </button>
        </div>
      </div>
    )

  const crashNotice = items!.slice(-10).some((i) => i.kind === 'notice' && i.source === 'crash')

  return (
    <div className="relative flex h-full min-h-0 flex-col" onKeyDown={onKeyDown} data-chat="view">
      <div className="relative min-h-0 flex-1">
        <div ref={scroller} onScroll={onScroll} role="log" aria-live="polite" aria-relevant="additions" aria-label="Conversation" className="h-full overflow-y-auto">
          <div ref={inner} className="mx-auto flex max-w-[720px] flex-col gap-3.5 px-5 pt-7 pb-4">
            {state.mcpFailed.length > 0 && <div className="text-warning text-[13px]">MCP server failed to connect: {state.mcpFailed.join(', ')}</div>}
            {(capped.hidden > 0 || state.hasEarlier) && (
              <button type="button" disabled={loading} onClick={() => void loadEarlier()} className="text-muted-foreground hover:text-foreground self-center text-[13px] underline-offset-2 hover:underline">
                {loading ? 'Loading…' : 'Load earlier'}
              </button>
            )}
            {capped.items.length === 0 && state.process !== 'starting' && <p className="text-muted-foreground py-10 text-center text-[13px]">Ask Claude to work on this project.</p>}
            <ConversationList scratchId={scratchId} items={capped.items} onOpenAgent={(id) => selectAgent(scratchId, id)} onTerminal={onTerminal} />
            {state.process === 'starting' && <div className="text-muted-foreground animate-pulse text-[13px]">Starting Claude Code…</div>}
            {state.process === 'crashed' && !crashNotice && (
              <div className="text-destructive flex items-center gap-3 text-[13px]">
                Claude Code stopped unexpectedly.
                <button type="button" onClick={() => void chatActions.restart(scratchId)} className="border-border text-foreground hover:bg-accent rounded-lg border px-2.5 py-0.5 text-xs">
                  Restart
                </button>
              </div>
            )}
            {state.process === 'stopped' && items!.length > 0 && <div className="text-muted-foreground text-xs">Claude Code is stopped. Sending a message starts it again.</div>}
          </div>
        </div>
        {!atBottom && (
          <button
            type="button"
            onClick={jump}
            className={cn('border-border bg-popover text-foreground absolute bottom-3 left-1/2 inline-flex -translate-x-1/2 items-center gap-1.5 rounded-full border px-3 py-1 text-[13px] shadow-md hover:bg-accent')}
          >
            <ArrowDown className="size-3.5" aria-hidden /> Jump to latest
          </button>
        )}
      </div>
      <StatusLine state={state} />
      <Composer scratchId={scratchId} state={state} launchEffort={launchEffort} tileModel={tileModel} onSent={jump} />
    </div>
  )
}
