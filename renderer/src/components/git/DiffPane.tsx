import { useEffect, useMemo, useRef, useState } from 'react'
import { ChevronDown, ChevronRight, ChevronUp, Copy, ExternalLink } from 'lucide-react'
import type { GitDiff, GitDiffLine, GitHunk } from '@shared/git'
import { decodeIpcError } from '@shared/ipc'
import { Button } from '@/components/ui/button'
import { call } from '@/lib/queries'
import { toast } from '@/lib/toast'
import { cn } from '@/lib/utils'

type Mode = 'unified' | 'split'
const MODE_KEY = 'operant.git.diffMode'

function readMode(): Mode {
  try {
    return localStorage.getItem(MODE_KEY) === 'split' ? 'split' : 'unified'
  } catch {
    return 'unified'
  }
}

const ADD = 'bg-[color-mix(in_srgb,var(--success)_16%,transparent)]'
const DEL = 'bg-[color-mix(in_srgb,var(--destructive)_16%,transparent)]'
const ADD_NO = 'bg-[color-mix(in_srgb,var(--success)_28%,transparent)]'
const DEL_NO = 'bg-[color-mix(in_srgb,var(--destructive)_28%,transparent)]'
const NO = 'text-muted-foreground select-none px-2 text-right tabular-nums'

interface Pair {
  l?: GitDiffLine
  r?: GitDiffLine
  start: boolean
}

// Side by side: a run of removed lines sits next to the run of added lines that replaced it.
export function pairRows(lines: GitDiffLine[]): Pair[] {
  const rows: Pair[] = []
  let i = 0
  while (i < lines.length) {
    const x = lines[i]!
    if (x.type === 'ctx') {
      rows.push({ l: x, r: x, start: false })
      i++
      continue
    }
    const dels: GitDiffLine[] = []
    const adds: GitDiffLine[] = []
    while (lines[i]?.type === 'del') dels.push(lines[i++]!)
    while (lines[i]?.type === 'add') adds.push(lines[i++]!)
    for (let k = 0; k < Math.max(dels.length, adds.length); k++) rows.push({ l: dels[k], r: adds[k], start: k === 0 })
  }
  return rows
}

function Unified({ hunk }: { hunk: GitHunk }) {
  return (
    <div>
      {hunk.lines.map((l, i) => {
        const prev = hunk.lines[i - 1]
        const start = l.type !== 'ctx' && (!prev || prev.type === 'ctx')
        return (
          <div key={i} data-change={start ? '' : undefined} className={cn('grid grid-cols-[3.25rem_3.25rem_minmax(0,1fr)]', l.type === 'add' && ADD, l.type === 'del' && DEL)}>
            <span className={cn(NO, l.type === 'del' && DEL_NO)}>{l.oldNo ?? ''}</span>
            <span className={cn(NO, l.type === 'add' && ADD_NO)}>{l.newNo ?? ''}</span>
            <span className="pr-4 pl-2 whitespace-pre">
              <span className="text-muted-foreground select-none">{l.type === 'add' ? '+' : l.type === 'del' ? '-' : ' '}</span>
              {l.text}
            </span>
          </div>
        )
      })}
    </div>
  )
}

function Split({ hunk }: { hunk: GitHunk }) {
  const rows = useMemo(() => pairRows(hunk.lines), [hunk])
  return (
    <div>
      {rows.map((p, i) => (
        <div key={i} data-change={p.start ? '' : undefined} className="grid grid-cols-[3.25rem_minmax(0,1fr)_3.25rem_minmax(0,1fr)]">
          <span className={cn(NO, p.l?.type === 'del' && DEL_NO)}>{p.l?.oldNo ?? ''}</span>
          <span className={cn('border-r pr-2 pl-2 break-all whitespace-pre-wrap', p.l?.type === 'del' && DEL)}>{p.l?.text ?? ''}</span>
          <span className={cn(NO, p.r?.type === 'add' && ADD_NO)}>{p.r?.newNo ?? ''}</span>
          <span className={cn('pr-2 pl-2 break-all whitespace-pre-wrap', p.r?.type === 'add' && ADD)}>{p.r?.text ?? ''}</span>
        </div>
      ))}
    </div>
  )
}

export interface HunkAction {
  label: string
  run: (index: number, hunk: GitHunk) => void
  disabled?: boolean
}

// One file's diff: unified or side by side, collapsible hunks, next/previous change, copy path, open in the IDE.
export function DiffPane({
  crewId,
  path,
  sideLabel,
  diff,
  loading,
  error,
  hunkAction,
}: {
  crewId: number
  path: string | null
  sideLabel?: string
  diff: GitDiff | undefined
  loading: boolean
  error: unknown
  hunkAction?: HunkAction | null
}) {
  const [mode, setModeState] = useState<Mode>(readMode)
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const [cursor, setCursor] = useState(-1)
  const body = useRef<HTMLDivElement>(null)

  const setMode = (m: Mode) => {
    setModeState(m)
    try {
      localStorage.setItem(MODE_KEY, m)
    } catch {
      /* storage unavailable */
    }
  }

  useEffect(() => {
    setCursor(-1)
    setCollapsed(new Set())
    body.current?.scrollTo({ top: 0 })
  }, [path, sideLabel])

  const changes = () => Array.from(body.current?.querySelectorAll('[data-change]') ?? [])
  const go = (dir: 1 | -1) => {
    const nodes = changes()
    if (nodes.length === 0) return
    const next = (cursor + dir + nodes.length) % nodes.length
    setCursor(next)
    nodes[next]!.scrollIntoView({ block: 'center' })
  }

  const copyPath = () => {
    if (!path) return
    void navigator.clipboard.writeText(path).then(
      () => toast('Path copied'),
      () => toast('The path could not be copied', true),
    )
  }
  const openIde = () => void call('ide:open', crewId).catch((e) => toast(decodeIpcError(e).message, true))

  const hunks = diff?.hunks ?? []
  const allCollapsed = hunks.length > 0 && hunks.every((h) => collapsed.has(h.header))
  const message = error
    ? decodeIpcError(error).message
    : !path
      ? 'Choose a file to see its changes.'
      : loading && !diff
        ? 'Reading the changes…'
        : diff?.binary
          ? 'A binary file: its content is not shown.'
          : diff && hunks.length === 0
            ? (diff.note ?? (diff.isDeleted ? 'The file was deleted.' : 'No line changes (only its mode or name changed).'))
            : null

  return (
    <section aria-label="Diff" className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="flex min-h-9 shrink-0 flex-wrap items-center gap-x-2 gap-y-1 border-b px-3 py-1">
        <span className="min-w-0 flex-1 truncate font-mono text-xs" title={path ?? ''}>
          {path ?? 'No file chosen'}
          {diff?.renamedFrom && <span className="text-muted-foreground"> (renamed from {diff.renamedFrom})</span>}
        </span>
        {sideLabel && <span className="text-muted-foreground text-[11px]">{sideLabel}</span>}
        {diff && !diff.binary && (
          <span className="font-mono text-[11px] tabular-nums">
            <span className="text-success">+{diff.additions}</span> <span className="text-destructive">-{diff.deletions}</span>
          </span>
        )}
        <div role="group" aria-label="Diff layout" className="flex">
          <Button size="xs" variant={mode === 'unified' ? 'secondary' : 'ghost'} aria-pressed={mode === 'unified'} onClick={() => setMode('unified')}>
            Unified
          </Button>
          <Button size="xs" variant={mode === 'split' ? 'secondary' : 'ghost'} aria-pressed={mode === 'split'} onClick={() => setMode('split')}>
            Side by side
          </Button>
        </div>
        <Button size="icon-xs" variant="ghost" aria-label="Previous change" disabled={hunks.length === 0} onClick={() => go(-1)}>
          <ChevronUp />
        </Button>
        <Button size="icon-xs" variant="ghost" aria-label="Next change" disabled={hunks.length === 0} onClick={() => go(1)}>
          <ChevronDown />
        </Button>
        <Button
          size="xs"
          variant="ghost"
          disabled={hunks.length === 0}
          onClick={() => setCollapsed(allCollapsed ? new Set() : new Set(hunks.map((h) => h.header)))}
        >
          {allCollapsed ? 'Expand all' : 'Collapse all'}
        </Button>
        <Button size="icon-xs" variant="ghost" aria-label="Copy path" disabled={!path} onClick={copyPath}>
          <Copy />
        </Button>
        <Button size="xs" variant="ghost" aria-label="Open in IDE" onClick={openIde}>
          <ExternalLink /> Open in IDE
        </Button>
      </div>
      <div ref={body} className="min-h-0 flex-1 overflow-auto font-mono text-xs leading-5" data-testid="diff-body">
        {message ? (
          <p className={cn('p-4 font-sans text-sm', error ? 'text-destructive' : 'text-muted-foreground')}>{message}</p>
        ) : (
          <div className="w-max min-w-full">
            {hunks.map((h, i) => {
              const closed = collapsed.has(h.header)
              return (
                <div key={`${i}-${h.header}`} className="border-b">
                  <div className="bg-muted/60 sticky top-0 z-10 flex items-center gap-1 px-1 py-0.5">
                    <button
                      type="button"
                      aria-expanded={!closed}
                      aria-label={`${closed ? 'Expand' : 'Collapse'} ${h.header}`}
                      className="hover:text-foreground text-muted-foreground flex items-center gap-1 rounded-md px-1"
                      onClick={() =>
                        setCollapsed((cur) => {
                          const n = new Set(cur)
                          if (n.has(h.header)) n.delete(h.header)
                          else n.add(h.header)
                          return n
                        })
                      }
                    >
                      {closed ? <ChevronRight className="size-3.5" /> : <ChevronDown className="size-3.5" />}
                      {h.header}
                    </button>
                    {hunkAction && (
                      <Button size="xs" variant="outline" className="ml-auto h-5" disabled={hunkAction.disabled} onClick={() => hunkAction.run(i, h)}>
                        {hunkAction.label}
                      </Button>
                    )}
                  </div>
                  {!closed && (mode === 'unified' ? <Unified hunk={h} /> : <Split hunk={h} />)}
                </div>
              )
            })}
            {diff?.note && <p className="text-muted-foreground p-3 font-sans text-xs">{diff.note}</p>}
          </div>
        )}
      </div>
    </section>
  )
}
