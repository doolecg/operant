import { useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Check, ChevronDown, ChevronLeft, X } from 'lucide-react'
import { itemsOf, type ChatItem, type SubagentItem } from '@shared/claude-chat'
import type { ClaudeSubagent } from '@shared/claude-mods'
import { cn } from '@/lib/utils'
import { ConversationList } from '@/components/chat/ConversationList'
import { UserBubble } from '@/components/chat/ItemViews'
import { selectAgent, useAgentSelection } from '@/components/chat/agentSelection'
import { ContextBar } from '@/components/chat/ItemViews'
import { agentElapsed, agentTitle, agentList, agentRowFor, kTokens, type AgentDot, type AgentRowModel } from '@/components/chat/chatHelpers'
import { useAgentHistory, useChatState, useNow } from '@/components/chat/useChat'
import { Critter } from './agents/Critter'
import { RightNowCard } from './agents/RightNowCard'
import { cardTime, critterFor, effortInfo, loadCleared, loadStatusOpen, mcpSummary, mcpTiles, metricsOf, money, progressOf, saveCleared, saveStatusOpen, sessionRows, shortModel, skillSummary, skillTiles, summarize, viewFor, type AgentView, type EffortTone, type McpTile, type McpTone } from './agents/agentView'
import type { ModProps } from './registry'

const TONE: Record<EffortTone, { text: string; bar: string }> = {
  success: { text: 'text-success', bar: 'bg-success' },
  info: { text: 'text-info', bar: 'bg-info' },
  warning: { text: 'text-warning', bar: 'bg-warning' },
  destructive: { text: 'text-destructive', bar: 'bg-destructive' },
}

function StatusMark({ dot }: { dot: AgentDot }) {
  if (dot === 'done') return <Check role="img" aria-label="Done" className="text-success size-3.5 shrink-0" strokeWidth={3} />
  if (dot === 'failed') return <X role="img" aria-label="Failed" className="text-destructive size-3.5 shrink-0" strokeWidth={3} />
  if (dot === 'unknown') return <i role="img" aria-label="Stopped" className="bg-muted-foreground/60 size-[7px] shrink-0 rounded-full" />
  return <i role="img" aria-label={dot === 'waiting' ? 'Waiting for you' : 'Running'} className={cn('size-[8px] shrink-0 rounded-full', dot === 'waiting' ? 'bg-warning' : 'bg-primary motion-safe:animate-pulse')} />
}

function AgentRow({ row, now, onOpen, onClear }: { row: AgentView; now: number; onOpen: () => void; onClear?: () => void }) {
  const ms = agentElapsed(row, now)
  const critter = critterFor(row.id)
  const eff = effortInfo(row.effort)
  const model = shortModel(row.model)
  const prog = progressOf(row)
  const tone = TONE[eff?.tone ?? 'info']
  const open = row.dot === 'running' || row.dot === 'waiting'
  const metrics = metricsOf(row, ms)
  const kind = row.agentType && row.agentType !== row.description ? row.agentType : null
  const detail = [model, row.effort].filter(Boolean).join(' · ')
  return (
    <li className="border-border group/row relative border-b last:border-b-0">
      <button type="button" onClick={onOpen} className="hover:bg-accent flex w-full items-start gap-2.5 rounded-[10px] px-2.5 py-2.5 text-left">
        <Critter hat={critter.hat} tint={critter.tint} bob={open} />
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-2">
            <span className="min-w-0 flex-1 truncate text-[13px] font-semibold">{row.description}</span>
            <StatusMark dot={row.dot} />
          </span>
          <span className="text-muted-foreground/80 block truncate text-xs">{kind ? `${row.name} · ${kind}` : row.name}</span>
          {(eff || detail) && (
            <span className="block truncate text-xs">
              {eff && <span className={cn('font-medium', tone.text)}>{eff.word}</span>}
              {detail && (
                <span className="text-muted-foreground">
                  {eff ? ' ' : ''}
                  {detail}
                </span>
              )}
            </span>
          )}
          {(prog.label || metrics) && (
            <span className="text-muted-foreground mt-0.5 flex items-center justify-between gap-2 text-xs">
              <span className="truncate">{prog.label ?? ''}</span>
              <span className="shrink-0 tabular-nums">{metrics}</span>
            </span>
          )}
          {prog.pct !== null && (
            <span className="bg-muted mt-1 block h-[3px] w-full overflow-hidden rounded-full" role="img" aria-label={prog.label ? `Progress ${prog.label}` : `Context ${Math.round(prog.pct)}% used`}>
              <span className={cn('block h-full rounded-full', eff ? tone.bar : 'bg-primary')} style={{ width: `${Math.max(2, Math.min(100, prog.pct))}%` }} />
            </span>
          )}
        </span>
      </button>
      {onClear && (
        <button
          type="button"
          onClick={onClear}
          aria-label={`Clear ${row.description}`}
          title="Clear"
          className="text-muted-foreground hover:bg-accent hover:text-foreground bg-card absolute top-1.5 right-1.5 hidden size-5 place-items-center rounded-full group-hover/row:grid focus-visible:grid"
        >
          <X className="size-3" />
        </button>
      )}
    </li>
  )
}

function Card({ label, value }: { label: string; value: string }) {
  return (
    <div className="border-border bg-card min-w-0 flex-1 rounded-[12px] border px-3 py-2">
      <div className="truncate text-[15px] leading-tight font-bold tabular-nums">{value}</div>
      <div className="text-muted-foreground text-[11px]">{label}</div>
    </div>
  )
}

function Group({ label, count, open, onToggle, children }: { label: string; count: number; open: boolean; onToggle: () => void; children: ReactNode }) {
  return (
    <section className="mt-2">
      <button type="button" onClick={onToggle} aria-expanded={open} className="text-muted-foreground hover:text-foreground flex items-center gap-1 px-2.5 py-1 text-xs font-medium">
        <ChevronDown className={cn('size-3.5 transition-transform', !open && '-rotate-90')} aria-hidden />
        {label} · {count}
      </button>
      {open && <ul aria-label={label}>{children}</ul>}
    </section>
  )
}

// Cleared agents are hidden for this tile only (kept in localStorage); Claude and running agents are untouched.
function useCleared(tileId: number) {
  const [cleared, setCleared] = useState(() => loadCleared(tileId))
  const clear = (ids: string[]) =>
    setCleared((cur) => {
      const next = new Set(cur)
      for (const id of ids) next.add(id)
      saveCleared(tileId, next)
      return next
    })
  return { cleared, clear }
}

function AgentList({ tileId, views, now, onOpen }: { tileId: number; views: AgentView[]; now: number; onOpen: (id: string) => void }) {
  const { cleared, clear } = useCleared(tileId)
  const [runningOpen, setRunningOpen] = useState(true)
  const [doneOpen, setDoneOpen] = useState(true)
  const visible = views.filter((v) => !cleared.has(v.id))
  const running = visible.filter((v) => v.dot === 'running' || v.dot === 'waiting')
  const finished = visible.filter((v) => v.dot !== 'running' && v.dot !== 'waiting')
  const sum = summarize(visible, now)
  const allOpen = runningOpen && doneOpen
  return (
    <div className="p-2">
      {visible.length === 0 ? (
        <p className="text-muted-foreground px-2 py-2 text-[13px]">{views.length > 0 ? 'All agents cleared.' : 'No agents in this session yet.'}</p>
      ) : (
        <>
          <div className="flex gap-2 px-1">
            <Card label="Cost" value={sum.cost !== null ? money(sum.cost) : '—'} />
            <Card label="Tokens" value={sum.tokens !== null ? kTokens(sum.tokens) : '—'} />
            <Card label="Time" value={sum.ms !== null ? cardTime(sum.ms) : '—'} />
          </div>
          <div className="text-muted-foreground flex items-center justify-between px-2.5 pt-2 text-xs">
            <button
              type="button"
              onClick={() => {
                setRunningOpen(!allOpen)
                setDoneOpen(!allOpen)
              }}
              className="hover:text-foreground underline-offset-2 hover:underline"
            >
              {allOpen ? 'Collapse' : 'Expand'}
            </button>
            <button type="button" disabled={finished.length === 0} onClick={() => clear(finished.map((f) => f.id))} className="hover:text-foreground underline-offset-2 hover:underline disabled:opacity-40 disabled:hover:no-underline">
              Clear finished
            </button>
          </div>
          {running.length > 0 && (
            <Group label="Running" count={running.length} open={runningOpen} onToggle={() => setRunningOpen((o) => !o)}>
              {running.map((r) => (
                <AgentRow key={r.id} row={r} now={now} onOpen={() => onOpen(r.id)} />
              ))}
            </Group>
          )}
          {finished.length > 0 && (
            <Group label="Finished" count={finished.length} open={doneOpen} onToggle={() => setDoneOpen((o) => !o)}>
              {finished.map((r) => (
                <AgentRow key={r.id} row={r} now={now} onOpen={() => onOpen(r.id)} onClear={() => clear([r.id])} />
              ))}
            </Group>
          )}
        </>
      )}
    </div>
  )
}

// One agent's conversation in the panel, in the same calm style at 13 px: its prompt, tools and replies, live.
function AgentConversation({ scratchId, agent, live, onBack, fromTranscript }: { scratchId: number; agent: AgentRowModel & { prompt: string }; live: ChatItem[]; onBack: () => void; fromTranscript?: boolean }) {
  const running = agent.dot === 'running' || agent.dot === 'waiting'
  const history = useAgentHistory(scratchId, agent.id, live.length === 0 && (!running || !!fromTranscript))
  const items = live.length > 0 ? live : (history ?? [])
  const box = useRef<HTMLDivElement>(null)
  const stuck = useRef(true)
  useLayoutEffect(() => {
    const el = box.current
    if (el && stuck.current) el.scrollTop = el.scrollHeight
  }, [items])
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="shrink-0 px-3 pt-2.5 pb-1.5">
        <button type="button" onClick={onBack} className="text-muted-foreground hover:text-foreground inline-flex items-center gap-0.5 text-[13px]">
          <ChevronLeft className="size-3.5" aria-hidden /> Agents
        </button>
        <div className="mt-1 truncate text-[13px] font-semibold">{agentTitle(agent)}</div>
        {agent.context && <ContextBar ctx={agent.context} />}
        {agent.description && agent.description !== (agent.agentType || '') && <div className="text-muted-foreground truncate text-xs">{agent.description}</div>}
      </div>
      <div
        ref={box}
        role="log"
        aria-label={`Conversation of ${agent.description}`}
        onScroll={(e) => {
          const el = e.currentTarget
          stuck.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80
        }}
        className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-4 pt-2 pb-4"
      >
        {agent.prompt && (
          <div className="flex justify-end">
            <UserBubble item={{ kind: 'user', id: `${agent.id}:prompt`, parent: agent.id, text: agent.prompt, images: [], queued: false, at: 0 }} small />
          </div>
        )}
        <ConversationList scratchId={scratchId} items={items} onOpenAgent={() => {}} onTerminal={() => {}} small prompts={false} />
        {items.length === 0 && <p className="text-muted-foreground text-xs">{running ? 'Waiting for the agent…' : 'No conversation is available for this agent.'}</p>}
      </div>
    </div>
  )
}

// Chat tiles: the agents come from the chat stream.
function ChatAgents({ tileId }: { tileId: number }) {
  const state = useChatState(tileId)
  const sel = useAgentSelection(tileId)
  const anyOpen = !!state?.items.some((i) => i.kind === 'subagent' && (i.status === 'running' || i.status === 'waiting'))
  const now = useNow(anyOpen)
  const views = useMemo(() => {
    const items = state?.items ?? []
    const byId = new Map(items.filter((i): i is SubagentItem => i.kind === 'subagent').map((i) => [i.id, i]))
    const { shown, earlier } = agentList(items, now)
    return [...shown, ...earlier].map((r) => viewFor(r, byId.get(r.id) ?? null, items))
  }, [state?.items, now])
  const open = sel.agent ? state?.items.find((i): i is SubagentItem => i.kind === 'subagent' && i.id === sel.agent) : undefined
  if (!state) return <p className="text-muted-foreground px-4 py-3 text-[13px]">Loading…</p>
  if (open) return <AgentConversation scratchId={tileId} agent={{ ...agentRowFor(open), prompt: open.prompt }} live={itemsOf(state, open.id)} onBack={() => selectAgent(tileId, null)} />
  return <AgentList tileId={tileId} views={views} now={now} onOpen={(id) => selectAgent(tileId, id)} />
}

const HOOK_DOT: Record<ClaudeSubagent['status'], AgentDot> = { running: 'running', completed: 'done', failed: 'failed', stopped: 'unknown', unknown: 'unknown' }

const hookRow = (a: ClaudeSubagent): AgentRowModel => ({
  id: a.agentId,
  description: a.description ?? a.agentType ?? 'Agent',
  dot: HOOK_DOT[a.status],
  now: a.status === 'running' ? (a.agentType ?? '') : a.status === 'completed' ? 'Done' : a.status === 'failed' ? 'Failed' : '',
  tldr: a.status === 'running' ? 'Working…' : a.status === 'completed' ? 'Done' : a.status === 'failed' ? 'Failed' : '',
  context: null,
  startedAt: a.startedAt ?? null,
  endedAt: a.endedAt ?? null,
  agentType: a.agentType,
  model: a.model ?? null,
})

// Terminal tiles: the same list from the hook events; the conversation is read from the agent's transcript.
function HookAgents({ tileId, agents }: { tileId: number; agents: ClaudeSubagent[] }) {
  const [openId, setOpenId] = useState<string | null>(null)
  const running = agents.some((a) => a.status === 'running')
  const now = useNow(running)
  const rows = useMemo(() => agents.map(hookRow).sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0)), [agents])
  const views = useMemo(() => rows.map((r) => viewFor(r, null, [])), [rows])
  const open = rows.find((r) => r.id === openId)
  if (open) return <AgentConversation scratchId={tileId} agent={{ ...open, prompt: '' }} live={[]} fromTranscript onBack={() => setOpenId(null)} />
  return <AgentList tileId={tileId} views={views} now={now} onOpen={setOpenId} />
}

const MCP_DOT: Record<McpTone, string> = { success: 'bg-success', warning: 'bg-warning', destructive: 'bg-destructive', muted: 'bg-muted-foreground/50' }
const MCP_TEXT: Record<McpTone, string> = { success: 'text-success', warning: 'text-warning', destructive: 'text-destructive', muted: 'text-muted-foreground' }

// The tile grid of MCP servers and skills: one compact tile each, the same look for both.
function StatusTiles({ label, tiles }: { label: string; tiles: McpTile[] }) {
  return (
    <div>
      <div className="text-muted-foreground mb-1.5 text-[11px] font-medium">{label}</div>
      <ul className="grid grid-cols-[repeat(auto-fill,minmax(120px,1fr))] gap-1.5">
        {tiles.map((t) => (
          <li
            key={t.name}
            title={t.reason ? `${t.name} · ${t.reason}` : t.name}
            className={cn('flex min-w-0 items-start gap-1.5 rounded-[8px] border px-2 py-1.5', t.attention ? (t.tone === 'destructive' ? 'border-destructive/30 bg-destructive/10' : 'border-warning/30 bg-warning/10') : 'border-border bg-card')}
          >
            <i role="img" aria-label={t.state} className={cn('mt-[4px] size-[7px] shrink-0 rounded-full', MCP_DOT[t.tone])} />
            <span className="min-w-0 flex-1">
              <span className="flex min-w-0 flex-col text-xs leading-tight">
                {t.prefix && <span className="text-muted-foreground truncate text-[10px]">{t.prefix}</span>}
                <span className="truncate font-medium">{t.short}</span>
              </span>
              <span className={cn('mt-0.5 block truncate text-[11px] leading-tight', MCP_TEXT[t.tone])}>{t.state}</span>
            </span>
          </li>
        ))}
      </ul>
    </div>
  )
}

// Soft Status section at the foot of the panel: MCP servers, skills loaded, and the SessionStart hook messages (moved out of the chat).
function StatusSection({ tileId, chat }: { tileId: number; chat?: boolean }) {
  const state = useChatState(chat ? tileId : null)
  const [open, setOpen] = useState(loadStatusOpen)
  const toggle = () =>
    setOpen((o) => {
      saveStatusOpen(!o)
      return !o
    })
  const servers = state?.mcpServers ?? []
  const session = useMemo(() => sessionRows(state?.items ?? []), [state?.items])
  const tiles = mcpTiles(servers)
  const skills = useMemo(() => skillTiles(state?.items ?? []), [state?.items])
  const bad = tiles.some((t) => t.tone === 'destructive')
  return (
    <section className="border-border bg-muted/40 m-2 mt-auto shrink-0 rounded-[12px] border">
      <button type="button" onClick={toggle} aria-expanded={open} className="flex w-full items-center gap-1.5 px-3 py-2 text-left text-xs font-semibold">
        <ChevronDown className={cn('text-muted-foreground size-3.5 transition-transform', !open && '-rotate-90')} aria-hidden />
        Status
        {!open && bad && <i aria-label="A server failed" className="bg-destructive size-[6px] rounded-full" />}
      </button>
      {open && (
        <div className="px-3 pb-3">
          {!chat ? (
            <p className="text-muted-foreground text-xs">Available in Chat view.</p>
          ) : (
            <>
              {servers.length > 0 && <StatusTiles label={mcpSummary(servers)} tiles={tiles} />}
              {skills.length > 0 && <div className={servers.length > 0 ? 'mt-3' : undefined}><StatusTiles label={skillSummary(skills)} tiles={skills} /></div>}
              {session.length > 0 && (
                <div className={servers.length > 0 || skills.length > 0 ? 'mt-3' : undefined}>
                  <div className="text-muted-foreground mb-1 text-[11px] font-medium">Session</div>
                  <ul className="flex flex-col gap-1.5">
                    {session.map((r, i) => (
                      <li key={i} className="bg-card rounded-[8px] px-2 py-1.5 text-xs leading-snug">
                        <span className="text-muted-foreground block text-[11px]">{r.origin}</span>
                        {r.text}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {servers.length === 0 && skills.length === 0 && session.length === 0 && <p className="text-muted-foreground text-xs">Nothing to report.</p>}
            </>
          )}
        </div>
      )}
    </section>
  )
}

// The Agents panel: summary cards and the tile's agents as critters (running, then finished; finished ones can be cleared);
// a click opens that agent's conversation inside the panel. Observation only: it never starts or stops anything.
export function SubagentPanel({ tileId, crewId, state, chat, onCollapse }: ModProps) {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="border-border flex h-11 shrink-0 items-center gap-2 border-b pr-2.5 pl-4">
        <h3 className="text-[13px] font-semibold">Agents</h3>
        <span className="flex-1" />
        <button type="button" onClick={onCollapse} aria-label="Hide Agents panel" title="Hide" className="text-muted-foreground hover:bg-accent hover:text-foreground grid size-7 place-items-center rounded-full">
          <X className="size-3.5" />
        </button>
      </div>
      <RightNowCard tileId={tileId} crewId={crewId} chat={!!chat} />
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto pt-1">
        {chat ? <ChatAgents tileId={tileId} /> : <HookAgents tileId={tileId} agents={state?.subagents ?? []} />}
        <StatusSection tileId={tileId} chat={chat} />
      </div>
    </div>
  )
}
