import { useEffect, useMemo, useRef, useState } from 'react'
import { Copy, Pause, Play, Square, Trash2, X } from 'lucide-react'
import { CONSOLE_SOURCES, type ConsoleLine, type ConsoleProcess, type ConsoleSource } from '@shared/console'
import { Button } from '@/components/ui/button'
import { DrawerResizeHandle } from '@/components/ui/resize-handle'
import { cn } from '@/lib/utils'

const HEIGHT = 'operant.console.height'
const MIN = 15
const MAX = 80

function readHeight(): number {
  try {
    const v = Number(localStorage.getItem(HEIGHT))
    return v >= MIN && v <= MAX ? v : 35
  } catch {
    return 35
  }
}

const time = (at: number) => new Date(at).toTimeString().slice(0, 8)
const plain = (l: ConsoleLine) => `${time(l.at)} [${l.source}] ${l.text}`

interface Props {
  lines: ConsoleLine[]
  processes: ConsoleProcess[]
  onClear: (source?: ConsoleSource) => void
  onStop: (pid: number) => void
  onClose: () => void
}

// Bottom drawer with the output of the background processes Operant runs. Its height is a percentage of the window.
export function ConsoleDrawer({ lines, processes, onClear, onStop, onClose }: Props) {
  const [height, setHeight] = useState(readHeight)
  const [source, setSource] = useState<ConsoleSource | 'all'>('all')
  const [query, setQuery] = useState('')
  const [frozenAt, setFrozenAt] = useState<number | null>(null)
  const root = useRef<HTMLElement>(null)
  const body = useRef<HTMLDivElement>(null)

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase()
    return lines.filter(
      (l) => (frozenAt === null || l.id <= frozenAt) && (source === 'all' || l.source === source) && (!q || l.text.toLowerCase().includes(q)),
    )
  }, [lines, source, query, frozenAt])

  const counts = useMemo(() => {
    const c: Partial<Record<ConsoleSource, number>> = {}
    for (const l of lines) if (l.error) c[l.source] = (c[l.source] ?? 0) + 1
    return c
  }, [lines])

  useEffect(() => {
    const el = body.current
    if (el && frozenAt === null) el.scrollTop = el.scrollHeight
  }, [visible, frozenAt])

  const tab = (id: ConsoleSource | 'all', label: string) => (
    <button
      key={id}
      type="button"
      role="tab"
      aria-selected={source === id}
      onClick={() => setSource(id)}
      className={cn(
        'flex items-center gap-1 rounded px-2 py-0.5 text-xs transition-colors',
        source === id ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground',
      )}
    >
      {label}
      {id !== 'all' && counts[id] ? <span className="rounded-full bg-red-500/20 px-1 text-[10px] text-red-400">{counts[id]}</span> : null}
    </button>
  )

  return (
    <section
      ref={root}
      aria-label="Console"
      data-testid="console-drawer"
      style={{ flexBasis: `${height}%` }}
      className="bg-background relative flex min-h-0 shrink-0 flex-col border-t"
    >
      <DrawerResizeHandle root={root} label="Resize console" storageKey={HEIGHT} onHeight={setHeight} />
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b px-3 py-1.5">
        <span className="text-sm font-medium">Console</span>
        <div role="tablist" aria-label="Source" className="bg-muted flex flex-wrap rounded-md p-0.5">
          {tab('all', 'All')}
          {CONSOLE_SOURCES.map((s) => tab(s, s))}
        </div>
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search"
          aria-label="Search console"
          className="bg-muted/50 h-7 min-w-24 flex-1 rounded border px-2 text-xs outline-none sm:max-w-56"
        />
        <Button
          variant="ghost"
          size="sm"
          aria-label={frozenAt === null ? 'Pause scrolling' : 'Resume scrolling'}
          onClick={() => setFrozenAt(frozenAt === null ? (lines[lines.length - 1]?.id ?? 0) : null)}
        >
          {frozenAt === null ? <Pause /> : <Play />}
          <span className="max-[900px]:hidden">{frozenAt === null ? 'Pause' : 'Resume'}</span>
        </Button>
        <Button variant="ghost" size="sm" aria-label="Copy lines" onClick={() => void navigator.clipboard?.writeText(visible.map(plain).join('\n'))}>
          <Copy />
          <span className="max-[900px]:hidden">Copy</span>
        </Button>
        <Button variant="ghost" size="sm" aria-label="Clear console" onClick={() => onClear(source === 'all' ? undefined : source)}>
          <Trash2 />
          <span className="max-[900px]:hidden">Clear</span>
        </Button>
        <Button variant="ghost" size="icon" aria-label="Close console" onClick={onClose}>
          <X />
        </Button>
      </div>

      {processes.length > 0 && (
        <ul aria-label="Running processes" className="flex shrink-0 flex-wrap gap-x-4 gap-y-1 border-b px-3 py-1 text-xs">
          {processes.map((p) => (
            <li key={p.pid} className="flex min-w-0 items-center gap-1.5">
              <span className="size-1.5 shrink-0 rounded-full bg-emerald-400" aria-hidden />
              <span className="text-muted-foreground">{p.source}</span>
              <span className="max-w-72 truncate font-mono" title={p.command}>
                {p.command}
              </span>
              <span className="text-muted-foreground font-mono">pid {p.pid}</span>
              <Button variant="outline" size="sm" className="h-5 px-1.5 text-[11px]" aria-label={`Stop process ${p.pid}`} onClick={() => onStop(p.pid)}>
                <Square className="size-3" /> Stop
              </Button>
            </li>
          ))}
        </ul>
      )}

      <div ref={body} className="min-h-0 flex-1 overflow-auto px-3 py-1 font-mono text-xs leading-5" role="log" aria-live="off">
        {visible.length === 0 ? (
          <p className="text-muted-foreground py-2">No output yet. Background commands (memory server, OpenCode, MCP checks, git) log here.</p>
        ) : (
          visible.map((l) => (
            <div
              key={l.id}
              data-source={l.source}
              className={cn('whitespace-pre-wrap break-all', l.error ? 'text-red-400' : l.stream === 'stderr' ? 'text-amber-400' : l.stream === 'info' ? 'text-muted-foreground' : '')}
            >
              <span className="text-muted-foreground">{time(l.at)}</span> <span className="text-sky-400">[{l.source}]</span> {l.text}
            </div>
          ))
        )}
      </div>
    </section>
  )
}
