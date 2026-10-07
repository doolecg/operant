import { useEffect, useMemo, useState } from 'react'
import { Undo2 } from 'lucide-react'
import type { GitFileEntry, GitStatus } from '@shared/git'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { call, useRepoDiff } from '@/lib/queries'
import { cn } from '@/lib/utils'
import type { Confirm } from './ConfirmDialog'
import { DiffPane } from './DiffPane'
import { baseName, dirName, letterOf, sectionsOf, type Sel, type Side } from './status'
import type { GitOps } from './useGitOps'

const SIDE_LABEL: Record<Side, string> = { staged: 'Staged changes', unstaged: 'Changes not staged', untracked: 'New file, not tracked yet' }

function Row({
  f,
  side,
  selected,
  busy,
  onSelect,
  onToggle,
  onDiscard,
}: {
  f: GitFileEntry
  side: Side | 'conflict'
  selected: boolean
  busy: boolean
  onSelect: () => void
  onToggle: () => void
  onDiscard: () => void
}) {
  const l = letterOf(f, side)
  return (
    <li data-file-row={f.path} data-side={side} className={cn('group flex items-center gap-2 px-2 py-1 text-xs', selected ? 'bg-accent' : 'hover:bg-accent/50')}>
      <input
        type="checkbox"
        aria-label={`${side === 'staged' ? 'Unstage' : 'Stage'} ${f.path}`}
        checked={side === 'staged'}
        disabled={busy || side === 'conflict'}
        onChange={onToggle}
        className="accent-primary size-3.5 shrink-0"
      />
      <button type="button" className="flex min-w-0 flex-1 items-center gap-2 text-left" onClick={onSelect} title={`${l.name} · ${f.orig ? `${f.orig} → ` : ''}${f.path}`}>
        <span aria-label={l.name} className={cn('w-4 shrink-0 text-center font-mono font-semibold', l.color)}>
          {l.letter}
        </span>
        <span className="truncate font-medium">{baseName(f.path)}</span>
        <span className="text-muted-foreground truncate">{f.orig ? `← ${f.orig}` : dirName(f.path)}</span>
      </button>
      <Button
        size="icon-xs"
        variant="ghost"
        aria-label={`Discard changes to ${f.path}`}
        className="opacity-0 group-focus-within:opacity-100 group-hover:opacity-100"
        disabled={busy || side === 'conflict'}
        onClick={onDiscard}
      >
        <Undo2 />
      </Button>
    </li>
  )
}

function Section({ title, count, action, actionLabel, children }: { title: string; count: number; action?: () => void; actionLabel?: string; children: React.ReactNode }) {
  if (count === 0) return null
  return (
    <section aria-label={title}>
      <div className="bg-muted/50 flex items-center gap-2 px-2 py-1 text-[11px] font-semibold tracking-wide uppercase">
        {title}
        <span className="bg-muted rounded-full px-1.5 tabular-nums">{count}</span>
        {action && (
          <Button size="xs" variant="ghost" className="ml-auto h-5" onClick={action}>
            {actionLabel}
          </Button>
        )}
      </div>
      <ul>{children}</ul>
    </section>
  )
}

export function ChangesView({ crewId, status, ops, wide, ask }: { crewId: number; status: GitStatus; ops: GitOps; wide: boolean; ask: (c: Confirm) => void }) {
  const [filter, setFilter] = useState('')
  const [sel, setSel] = useState<Sel | null>(null)
  const [message, setMessage] = useState('')
  const [amend, setAmend] = useState(false)
  const s = useMemo(() => sectionsOf(status.files, filter), [status.files, filter])
  const all = useMemo(() => sectionsOf(status.files), [status.files])

  // Keep the chosen file while it still has changes on that side; else the first file there is.
  useEffect(() => {
    const on = (x: Sel) =>
      x.side === 'staged'
        ? all.staged.some((f) => f.path === x.path)
        : x.side === 'unstaged'
          ? all.unstaged.some((f) => f.path === x.path) || all.conflicts.some((f) => f.path === x.path)
          : all.untracked.some((f) => f.path === x.path)
    if (sel && on(sel)) return
    const f = all.conflicts[0] ?? all.unstaged[0] ?? all.staged[0] ?? all.untracked[0]
    if (!f) return setSel(null)
    const side: Side = f.conflicted || all.unstaged.includes(f) ? 'unstaged' : f.untracked ? 'untracked' : 'staged'
    setSel({ path: f.path, orig: f.orig, side, conflicted: f.conflicted })
  }, [all, sel])

  const tick = status.files.map((f) => `${f.path}${f.x}${f.y}`).join('|')
  const diff = useRepoDiff(crewId, sel ? { path: sel.path, orig: sel.orig, side: sel.side } : null, tick)

  const pick = (f: GitFileEntry, side: Side) => setSel({ path: f.path, orig: f.orig, side, conflicted: f.conflicted })
  const busy = ops.busy != null

  const discard = (f: GitFileEntry) =>
    ask({
      title: `Discard changes to ${baseName(f.path)}?`,
      detail: f.untracked || f.x === 'A' ? 'It is a new file, so discarding it deletes it from the folder. This cannot be undone.' : 'Its changes since the last commit, staged or not, are lost. This cannot be undone.',
      action: 'Discard',
      danger: true,
      run: () => void ops.discard([f.path]),
    })

  const submit = async () => {
    const r = await ops.commit(message, amend)
    if (r?.ok) {
      setMessage('')
      setAmend(false)
    }
  }
  const toggleAmend = async (on: boolean) => {
    setAmend(on)
    if (on && !message.trim()) setMessage(await call('git:lastMessage', crewId).catch(() => ''))
  }

  const stagedCount = all.staged.length
  const subject = message.split('\n')[0] ?? ''
  const canCommit = !busy && message.trim().length > 0 && (stagedCount > 0 || amend)

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className={cn('flex min-h-0 flex-1', wide ? 'flex-row' : 'flex-col')}>
        <div className={cn('flex min-h-0 shrink-0 flex-col', wide ? 'w-[clamp(16rem,28%,26rem)] border-r' : 'h-[40%] border-b')}>
          <div className="p-2">
            <Input aria-label="Filter files" placeholder="Filter files…" className="h-7 text-xs" value={filter} onChange={(e) => setFilter(e.target.value)} />
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto" data-testid="git-files">
            {status.files.length === 0 && <p className="text-muted-foreground p-3 text-sm">No changes since the last commit.</p>}
            <Section title="Conflicts" count={s.conflicts.length}>
              {s.conflicts.map((f) => (
                <Row key={f.path} f={f} side="conflict" busy={busy} selected={sel?.path === f.path && sel.side === 'unstaged'} onSelect={() => pick(f, 'unstaged')} onToggle={() => undefined} onDiscard={() => undefined} />
              ))}
            </Section>
            <Section title="Staged" count={s.staged.length} action={() => void ops.unstage(s.staged.map((f) => f.path))} actionLabel="Unstage all">
              {s.staged.map((f) => (
                <Row key={f.path} f={f} side="staged" busy={busy} selected={sel?.path === f.path && sel.side === 'staged'} onSelect={() => pick(f, 'staged')} onToggle={() => void ops.unstage([f.path])} onDiscard={() => discard(f)} />
              ))}
            </Section>
            <Section title="Changes" count={s.unstaged.length} action={() => void ops.stage(s.unstaged.map((f) => f.path))} actionLabel="Stage all">
              {s.unstaged.map((f) => (
                <Row key={f.path} f={f} side="unstaged" busy={busy} selected={sel?.path === f.path && sel.side === 'unstaged'} onSelect={() => pick(f, 'unstaged')} onToggle={() => void ops.stage([f.path])} onDiscard={() => discard(f)} />
              ))}
            </Section>
            <Section title="Untracked" count={s.untracked.length} action={() => void ops.stage(s.untracked.map((f) => f.path))} actionLabel="Stage all">
              {s.untracked.map((f) => (
                <Row key={f.path} f={f} side="untracked" busy={busy} selected={sel?.path === f.path && sel.side === 'untracked'} onSelect={() => pick(f, 'untracked')} onToggle={() => void ops.stage([f.path])} onDiscard={() => discard(f)} />
              ))}
            </Section>
            {status.more > 0 && <p className="text-muted-foreground p-2 text-xs">and {status.more} more files not listed</p>}
          </div>
        </div>
        <DiffPane
          crewId={crewId}
          path={sel?.path ?? null}
          sideLabel={sel ? (sel.conflicted ? 'In conflict' : SIDE_LABEL[sel.side]) : undefined}
          diff={diff.data}
          loading={diff.isFetching}
          error={diff.error}
          hunkAction={
            sel && (sel.side === 'staged' || sel.side === 'unstaged') && !sel.conflicted
              ? {
                  label: sel.side === 'staged' ? 'Unstage hunk' : 'Stage hunk',
                  disabled: busy,
                  run: (index, h) => void ops.stageHunk({ path: sel.path, index, header: h.header }, sel.side === 'unstaged'),
                }
              : null
          }
        />
      </div>

      <form
        aria-label="Commit"
        className="shrink-0 space-y-2 border-t p-3"
        onSubmit={(e) => {
          e.preventDefault()
          if (canCommit) void submit()
        }}
      >
        <Textarea
          aria-label="Commit message"
          placeholder={'Commit message\n\nThe first line is the subject; leave a blank line and add details below.'}
          rows={wide ? 3 : 2}
          className="min-h-0 resize-y font-mono text-xs"
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && canCommit) {
              e.preventDefault()
              void submit()
            }
          }}
        />
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
          <label className="flex items-center gap-1.5 text-xs" title="Change the last commit instead of making a new one">
            <input type="checkbox" className="accent-primary size-3.5" checked={amend} disabled={busy} onChange={(e) => void toggleAmend(e.target.checked)} />
            Amend last commit
          </label>
          <span className={cn('text-[11px] tabular-nums', subject.length > 72 ? 'text-warning' : 'text-muted-foreground')}>{subject.length > 0 && `subject ${subject.length}/72`}</span>
          <span className="text-muted-foreground text-xs">{stagedCount === 0 ? 'Nothing staged' : `${stagedCount} ${stagedCount === 1 ? 'file' : 'files'} staged`}</span>
          <Button type="submit" size="sm" className="ml-auto" disabled={!canCommit}>
            {ops.busy === 'Commit' ? 'Committing…' : amend ? 'Amend commit' : `Commit${stagedCount > 0 ? ` ${stagedCount} ${stagedCount === 1 ? 'file' : 'files'}` : ''}`}
          </Button>
        </div>
      </form>
    </div>
  )
}
