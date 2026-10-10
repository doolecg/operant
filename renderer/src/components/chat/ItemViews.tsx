import { memo, useState } from 'react'
import { AlertCircle, Bot, Box, BrainCircuit, ChevronRight, Copy, FileText, Gauge, Globe, Info, ListChecks, Minimize2, Network, Pencil, Plug, Search, Sparkles, Square, SquareTerminal, Webhook, Wrench, type LucideIcon } from 'lucide-react'
import {
  partialTarget,
  type CommandItem,
  type DiffFile,
  type NoticeItem,
  type SubagentItem,
  type TextItem,
  type ThinkingItem,
  type ToolItem,
  type TurnItem,
  type UserItem,
} from '@shared/claude-chat'
import { Markdown, CopyTextButton } from '@/components/ui/markdown'
import { cn } from '@/lib/utils'
import { agentContext, agentRowFor, agentTitle, agentTldr, firstLines, formatDuration, isToolRunning, kTokens, noticeChipIcon, toolIconKey, toolRowParts, type ChipIcon, type ToolIconKey } from './chatHelpers'

const TOOL_ICONS: Record<ToolIconKey, LucideIcon> = {
  memory: BrainCircuit,
  code: Network,
  web: Globe,
  file: FileText,
  edit: Pencil,
  terminal: SquareTerminal,
  search: Search,
  skill: Sparkles,
  agent: Bot,
  todo: ListChecks,
  plug: Plug,
  tool: Wrench,
}

export function Spinner({ className }: { className?: string }) {
  return <span aria-hidden className={cn('border-input border-t-foreground size-3 shrink-0 animate-spin rounded-full border-[1.5px] motion-reduce:animate-none', className)} />
}

// ---------------------------------------------------------------- code and diffs

const MAX_DIFF_LINES = 300

export function DiffBlock({ diff }: { diff: DiffFile }) {
  const [all, setAll] = useState(false)
  const rows: Array<{ ln: number | null; sign: string; text: string; hunk: boolean }> = []
  for (const h of diff.hunks) {
    let o = h.oldStart
    let n = h.newStart
    if (rows.length) rows.push({ ln: null, sign: ' ', text: '⋯', hunk: true })
    for (const l of h.lines) {
      const sign = l[0] ?? ' '
      const text = l.slice(1)
      if (sign === '+') rows.push({ ln: n++, sign, text, hunk: false })
      else if (sign === '-') rows.push({ ln: o++, sign, text, hunk: false })
      else {
        rows.push({ ln: n, sign: ' ', text, hunk: false })
        o++
        n++
      }
    }
  }
  const shown = all ? rows : rows.slice(0, MAX_DIFF_LINES)
  return (
    <div className="bg-code overflow-hidden rounded-[10px] py-1.5 font-mono text-[12.5px] leading-[1.65]" data-chat="diff">
      <div className="overflow-x-auto">
        <div className="w-max min-w-full">
          {shown.map((r, i) => (
            <div key={i} className={cn('flex whitespace-pre', r.sign === '+' && 'bg-success/10', r.sign === '-' && 'bg-destructive/10', r.hunk && 'text-muted-foreground/70')}>
              <span className="text-muted-foreground/70 w-10 shrink-0 pr-3 text-right select-none">{r.ln ?? ''}</span>
              <span className={cn('w-4 shrink-0 select-none', r.sign === '+' && 'text-success', r.sign === '-' && 'text-destructive')}>{r.hunk ? '' : r.sign}</span>
              <span className="pr-3">{r.text || ' '}</span>
            </div>
          ))}
        </div>
      </div>
      {rows.length > shown.length && (
        <button type="button" onClick={() => setAll(true)} className="text-muted-foreground hover:text-foreground px-3 pt-1 text-xs">
          Show all {rows.length} lines
        </button>
      )}
    </div>
  )
}

function Pre({ text, className }: { text: string; className?: string }) {
  return (
    <pre tabIndex={0} className={cn('bg-code max-h-80 overflow-auto rounded-[10px] px-3.5 py-3 font-mono text-[12.5px] leading-[1.65] whitespace-pre-wrap break-words', className)}>
      {text}
    </pre>
  )
}

// ---------------------------------------------------------------- messages

export const UserBubble = memo(function UserBubble({ item, small }: { item: UserItem; small?: boolean }) {
  return (
    <div className="group/user flex flex-col items-end gap-1" style={{ maxWidth: small ? '92%' : '76%' }}>
      <div className={cn('bg-bubble rounded-[18px] px-[15px] py-[9px] leading-[1.55] break-words whitespace-pre-wrap', small ? 'text-[13px]' : 'text-[15px]')}>
        {item.images.length > 0 && (
          <div className="mb-2 flex flex-wrap gap-1.5">
            {item.images.map((im, i) => (
              <a key={i} href={im.dataUrl} target="_blank" rel="noreferrer" onClick={(e) => (e.preventDefault(), window.open(im.dataUrl))} title="Open image">
                <img src={im.dataUrl} alt="Attached" className="size-16 rounded-lg object-cover" />
              </a>
            ))}
          </div>
        )}
        {item.text}
      </div>
      <div className="text-muted-foreground flex h-4 items-center gap-2 text-xs">
        {item.queued && <span>Queued</span>}
        <CopyTextButton text={item.text} label="Copy" ariaLabel="Copy message" className="opacity-0 group-focus-within/user:opacity-100 group-hover/user:opacity-100" />
      </div>
    </div>
  )
})

export const AssistantText = memo(function AssistantText({ item, small }: { item: TextItem; small?: boolean }) {
  return (
    <div className={cn('group/msg bg-card border-border relative max-w-[72ch] rounded-[18px] border', small ? 'px-3 py-2.5' : 'px-[18px] py-3.5')} data-chat="text">
      <Markdown variant="chat" source={item.md} className={small ? 'text-[13px] leading-[1.65]' : undefined} />
      {item.streaming && <span aria-hidden className="bg-foreground/70 ml-0.5 inline-block h-[15px] w-[7px] translate-y-[3px] rounded-[1px] motion-safe:animate-pulse" />}
      {!item.streaming && item.md.length > 0 && (
        <button
          type="button"
          aria-label="Copy reply"
          title="Copy reply"
          onClick={() => void navigator.clipboard?.writeText(item.md).catch(() => {})}
          className="text-muted-foreground hover:text-foreground mt-1 block opacity-0 group-focus-within/msg:opacity-100 group-hover/msg:opacity-100"
        >
          <Copy className="size-3" />
        </button>
      )}
    </div>
  )
})

// ---------------------------------------------------------------- quiet rows

const rowBtn = 'text-muted-foreground hover:text-foreground flex w-full items-center gap-2 py-[3px] text-left text-[13px]'

export const ThinkingRow = memo(function ThinkingRow({ item }: { item: ThinkingItem }) {
  const [open, setOpen] = useState(false)
  const done = item.endedAt !== null
  const label = done ? `Thought for ${formatDuration(item.endedAt! - item.startedAt)}` : 'Thinking…'
  const canOpen = item.text.trim().length > 0
  return (
    <div>
      <button
        type="button"
        disabled={!canOpen}
        aria-expanded={canOpen ? open : undefined}
        title={item.tokens ? `About ${item.tokens} tokens` : undefined}
        onClick={() => setOpen((o) => !o)}
        className={cn(rowBtn, !canOpen && 'cursor-default hover:text-muted-foreground')}
      >
        <ChevronRight className={cn('size-3 shrink-0 transition-transform', open && 'rotate-90')} aria-hidden />
        <span>{label}</span>
        {!done && <Spinner />}
      </button>
      {open && canOpen && <div className="text-muted-foreground ml-5 text-[13px] whitespace-pre-wrap">{item.text}</div>}
    </div>
  )
})

function ToolDetails({ t }: { t: ToolItem }) {
  const [all, setAll] = useState(false)
  const input = t.input && typeof t.input === 'object' ? (t.input as Record<string, unknown>) : {}
  const command = typeof input.command === 'string' ? input.command : null
  const text = t.result?.text ?? ''
  const shown = all ? { text, more: false } : firstLines(text, 40)
  return (
    <div className="mt-1 mb-1 ml-5 space-y-1.5">
      {t.blockedByHook && <p className="text-destructive text-[13px]">Blocked by a hook: {t.blockedByHook}</p>}
      {t.diff ? <DiffBlock diff={t.diff} /> : command ? <Pre text={command} className="max-h-40" /> : null}
      {!t.diff && text && (
        <div className="group/res relative">
          <Pre text={shown.text} className={t.result?.isError ? 'text-destructive' : undefined} />
          <CopyTextButton text={text} ariaLabel="Copy result" className="text-muted-foreground absolute top-1.5 right-2 opacity-0 group-focus-within/res:opacity-100 group-hover/res:opacity-100" />
          {shown.more && (
            <button type="button" onClick={() => setAll(true)} className="text-muted-foreground hover:text-foreground mt-1 text-xs">
              Show all
            </button>
          )}
        </div>
      )}
      {t.result?.images.map((src, i) => <img key={i} src={src} alt="Tool result" className="max-h-60 rounded-[10px]" />)}
      {!t.diff && !text && !command && !isToolRunning(t) && !t.blockedByHook && <p className="text-muted-foreground text-xs">No output</p>}
    </div>
  )
}

export const ToolRow = memo(function ToolRow({ t, small }: { t: ToolItem; small?: boolean }) {
  const [open, setOpen] = useState(t.status === 'failed')
  const p = toolRowParts(t)
  const running = isToolRunning(t)
  const target = p.target || (t.status === 'preparing' ? partialTarget(t.name, t.partial) : '')
  const state = running ? 'running' : t.status
  const Icon = TOOL_ICONS[toolIconKey(t.name)]
  return (
    <div data-chat="tool">
      <button
        type="button"
        aria-expanded={open}
        aria-label={`Tool: ${p.verb} ${target}, ${state}`}
        onClick={() => setOpen((o) => !o)}
        className={cn(rowBtn, small && 'text-xs')}
      >
        <ChevronRight className={cn('size-3 shrink-0 transition-transform', open && 'rotate-90')} aria-hidden />
        <Icon className="size-3.5 shrink-0" aria-hidden />
        <span className="min-w-0 truncate">
          {p.tone === 'denied' && <span className="text-foreground">Denied: </span>}
          <span className={cn('text-foreground font-medium', p.tone === 'failed' && 'text-destructive')}>{p.verb}</span>
          {target && <span className="text-muted-foreground/80"> {target}</span>}
        </span>
        {p.stat && (
          <span className="shrink-0 text-xs">
            <span className="text-success">{p.stat.split(' ')[0]}</span> <span className="text-destructive">{p.stat.split(' ')[1]}</span>
          </span>
        )}
        {running && <Spinner />}
      </button>
      {open && <ToolDetails t={t} />}
    </div>
  )
})

export const ToolGroupRow = memo(function ToolGroupRow({ summary, items, small }: { summary: string; items: ToolItem[]; small?: boolean }) {
  const [open, setOpen] = useState(false)
  return (
    <div data-chat="tool-group">
      <button type="button" aria-expanded={open} onClick={() => setOpen((o) => !o)} className={cn(rowBtn, small && 'text-xs')}>
        <ChevronRight className={cn('size-3 shrink-0 transition-transform', open && 'rotate-90')} aria-hidden />
        <span className="text-foreground">{summary}</span>
      </button>
      {open && (
        <div className="ml-5">
          {items.map((t) => (
            <ToolRow key={t.id} t={t} small={small} />
          ))}
        </div>
      )}
    </div>
  )
})

export const SubagentRow = memo(function SubagentRow({ item, onOpen, small }: { item: SubagentItem; onOpen: (id: string) => void; small?: boolean }) {
  const running = item.status === 'running' || item.status === 'waiting'
  const row = agentRowFor(item)
  const title = agentTitle(row)
  const tldr = agentTldr(item)
  const ctx = agentContext(item)
  return (
    <button type="button" onClick={() => onOpen(item.id)} title="Open this agent in the Agents panel" className={cn(rowBtn, 'items-start', small && 'text-xs')} data-chat="agent">
      <ChevronRight className="mt-[3px] size-3 shrink-0" aria-hidden />
      <span className="min-w-0 flex-1">
        <span className={cn('text-foreground block truncate font-semibold', item.status === 'failed' && 'text-destructive')}>{title}</span>
        {ctx && <ContextBar ctx={ctx} />}
        {tldr && <span className="block truncate text-xs">{tldr}</span>}
      </span>
      {running && <Spinner className="mt-1" />}
    </button>
  )
})

// A thin bar of how much of the model's context window the agent uses.
export function ContextBar({ ctx }: { ctx: { pct: number; used: number; window: number } }) {
  return (
    <span className="bg-muted mt-1 mb-0.5 block h-[3px] w-full overflow-hidden rounded-full" role="img" aria-label={`Context ${Math.round(ctx.pct)}% used`} title={`${kTokens(ctx.used)} of ${kTokens(ctx.window)} tokens`}>
      <span className={cn('block h-full rounded-full', ctx.pct >= 90 ? 'bg-destructive' : ctx.pct >= 75 ? 'bg-warning' : 'bg-muted-foreground/60')} style={{ width: `${Math.max(2, ctx.pct)}%` }} />
    </span>
  )
}

export const CommandRow = memo(function CommandRow({ item }: { item: CommandItem }) {
  return (
    <div className="text-muted-foreground" data-chat="command">
      <div className="text-[13px]">
        <span className="text-foreground">/{item.command}</span>
      </div>
      {item.md.trim() && <Markdown variant="chat" source={item.md} className="text-muted-foreground mt-1 text-[13px] leading-[1.6]" />}
    </div>
  )
})

const CHIP_ICONS: Record<ChipIcon, LucideIcon> = { cube: Box, hook: Webhook, gauge: Gauge, compact: Minimize2, stop: Square, alert: AlertCircle, plug: Plug, info: Info }

const chipBase = 'inline-flex max-w-full items-center gap-1.5 px-2.5 py-1 text-[12.5px] leading-snug'

// A keep-warm ping turn: icon, "ping", the prompt, then the reply behind an arrow.
function PingChip({ item }: { item: NoticeItem }) {
  const p = item.ping!
  const detail = p.running ? 'Keep-warm ping' : `Keep-warm ping: read ${kTokens(p.cacheRead)} tokens from the cache${p.usd !== null ? `, about $${p.usd.toFixed(2)}` : ''}`
  return (
    <div data-chat="ping" className="flex">
      <span className={cn(chipBase, 'bg-muted/60 text-muted-foreground rounded-full')} title={detail}>
        <Box className="size-3.5 shrink-0" aria-hidden />
        <span>ping</span>
        <span className="text-foreground/80 min-w-0 truncate">{item.text}</span>
        <span aria-hidden>↳</span>
        <span aria-hidden className="text-primary">
          ✳
        </span>
        {p.running ? <Spinner /> : p.ok ? <span className="text-success font-bold">{p.reply || 'done'}</span> : <span className="text-warning font-bold">failed</span>}
      </span>
    </div>
  )
}

export const NoticeRow = memo(function NoticeRow({ item, onRestart, onTerminal }: { item: NoticeItem; onRestart: () => void; onTerminal: () => void }) {
  const [open, setOpen] = useState(false)
  if (item.ping) return <PingChip item={item} />
  const Icon = CHIP_ICONS[noticeChipIcon(item.source, item.tone)]
  const tone = item.tone === 'error' ? 'bg-destructive/10 text-destructive' : item.tone === 'warn' ? 'bg-warning/10 text-warning' : 'bg-muted/60 text-muted-foreground'
  return (
    <div className="text-[13px]" data-chat="notice" data-source={item.source}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className={cn(chipBase, 'rounded-xl', tone)}>
          <Icon className="size-3.5 shrink-0" aria-hidden />
          <span className="break-words">{item.text}</span>
        </span>
        {item.detail && (
          <button type="button" aria-expanded={open} onClick={() => setOpen((o) => !o)} className="text-muted-foreground hover:text-foreground text-xs underline underline-offset-2">
            {open ? 'Hide details' : 'Details'}
          </button>
        )}
        {item.actions?.includes('restart') && (
          <button type="button" onClick={onRestart} className="border-border text-foreground hover:bg-accent rounded-lg border px-2.5 py-0.5 text-xs">
            Restart
          </button>
        )}
        {item.actions?.includes('terminal') && (
          <button type="button" onClick={onTerminal} className="border-border text-foreground hover:bg-accent rounded-lg border px-2.5 py-0.5 text-xs">
            Open in Terminal
          </button>
        )}
      </div>
      {open && item.detail && <Pre text={item.detail} className="text-muted-foreground mt-1.5 max-h-48" />}
    </div>
  )
})

export const TurnRow = memo(function TurnRow({ item }: { item: TurnItem }) {
  return <div className="text-muted-foreground/70 text-xs">{item.ok ? 'Done' : 'Stopped'} in {formatDuration(item.durationMs)}</div>
})
