import { useState } from 'react'
import { ArrowDown, ArrowUp, Check, ChevronDown, GitBranch, Maximize2, Minimize2, RefreshCw, X } from 'lucide-react'
import { useQueryClient } from '@tanstack/react-query'
import { decodeIpcError } from '@shared/ipc'
import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { refreshGit, useRepoBranches, useRepoStatus } from '@/lib/queries'
import { cn } from '@/lib/utils'
import { ChangesView } from './ChangesView'
import { ConfirmDialog, type Confirm } from './ConfirmDialog'
import { HistoryView } from './HistoryView'
import { useGitOps } from './useGitOps'

type View = 'changes' | 'history'

// The project's Git page: changes (stage, diff, commit), history, branches, and pull/push. Nothing is committed or
// pushed except by a click here.
export function GitPage({ crewId, wide, onToggleWide }: { crewId: number; wide: boolean; onToggleWide?: () => void }) {
  const qc = useQueryClient()
  const status = useRepoStatus(crewId)
  const branches = useRepoBranches(crewId)
  const ops = useGitOps(crewId)
  const [view, setView] = useState<View>('changes')
  const [confirm, setConfirm] = useState<Confirm | null>(null)
  const [creating, setCreating] = useState(false)
  const [newName, setNewName] = useState('')
  const st = status.data
  const busy = ops.busy != null

  if (status.error) return <p role="alert" className="text-destructive p-4 text-sm">{decodeIpcError(status.error).message}</p>
  if (status.isLoading) return <p className="text-muted-foreground p-4 text-sm">Reading git status…</p>
  if (!st) return <p className="text-muted-foreground p-4 text-sm">This folder is not a git repository.</p>

  const pull = () =>
    setConfirm({
      title: `Pull into ${st.branch}?`,
      detail: st.upstream ? `Fast-forwards ${st.branch} to ${st.upstream}${st.behind ? ` (${st.behind} new ${st.behind === 1 ? 'commit' : 'commits'})` : ''}. A branch that has diverged is not merged for you.` : `${st.branch} has no upstream branch yet.`,
      action: 'Pull',
      run: () => void ops.pull(),
    })
  const push = () =>
    setConfirm({
      title: st.upstream ? `Push to ${st.upstream}?` : `Publish ${st.branch} to origin?`,
      detail: st.upstream
        ? `${st.ahead} ${st.ahead === 1 ? 'commit goes' : 'commits go'} to the remote. Git cannot ask for a password here: if it fails, sign in once from a terminal.`
        : `${st.branch} has no upstream yet: it is pushed to origin and set to track it.`,
      action: 'Push',
      run: () => void ops.push(),
    })

  const create = async () => {
    const name = newName.trim()
    if (!name) return
    const r = await ops.createBranch(name)
    if (r?.ok) {
      setCreating(false)
      setNewName('')
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="git-page">
      <div className="flex shrink-0 flex-wrap items-center gap-x-2 gap-y-1 border-b px-3 py-1.5">
        <h2 className="text-sm font-semibold">Git</h2>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button size="xs" variant="outline" aria-label={`Branch ${st.branch}. Switch branch`} disabled={busy}>
              <GitBranch /> <span className="max-w-48 truncate font-mono">{st.detached ? `detached at ${st.branch}` : st.branch}</span> <ChevronDown />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="max-h-80 min-w-56 overflow-y-auto">
            <DropdownMenuLabel>Switch to a branch</DropdownMenuLabel>
            {(branches.data?.branches ?? []).map((b) => (
              <DropdownMenuItem key={b.name} onSelect={() => !b.current && void ops.checkout(b.name)}>
                {b.current ? <Check className="size-3.5" /> : <span className="size-3.5" />}
                <span className="font-mono text-xs">{b.name}</span>
                {b.upstream && <span className="text-muted-foreground ml-auto text-[10px]">{b.upstream}</span>}
              </DropdownMenuItem>
            ))}
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => setCreating(true)}>New branch…</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <span className="text-muted-foreground text-[11px]">{st.upstream ? `tracks ${st.upstream}` : 'no upstream'}</span>
        <div className="ml-auto flex items-center gap-1">
          <Button size="xs" variant="outline" aria-label={`Pull, ${st.behind} behind`} disabled={busy || !st.upstream} onClick={pull}>
            <ArrowDown /> Pull{st.behind > 0 && <span className="tabular-nums">{st.behind}</span>}
          </Button>
          <Button size="xs" variant="outline" aria-label={`Push, ${st.ahead} ahead`} disabled={busy || st.detached || (!!st.upstream && st.ahead === 0)} onClick={push}>
            <ArrowUp /> Push{st.ahead > 0 && <span className="tabular-nums">{st.ahead}</span>}
          </Button>
          <Button size="xs" variant="ghost" disabled={busy} onClick={() => void ops.fetch()}>
            Fetch
          </Button>
          <Button size="icon-xs" variant="ghost" aria-label="Refresh" onClick={() => void refreshGit(qc)}>
            <RefreshCw className={cn(status.isFetching && 'animate-spin')} />
          </Button>
          {onToggleWide && (
            <Button size="icon-xs" variant="ghost" aria-label={wide ? 'Narrow the Git panel' : 'Widen the Git panel'} onClick={onToggleWide}>
              {wide ? <Minimize2 /> : <Maximize2 />}
            </Button>
          )}
        </div>
      </div>

      {creating && (
        <form
          className="flex shrink-0 items-center gap-2 border-b px-3 py-1.5"
          onSubmit={(e) => {
            e.preventDefault()
            void create()
          }}
        >
          <Input autoFocus aria-label="New branch name" placeholder={`New branch from ${st.branch}`} className="h-7 max-w-80 font-mono text-xs" value={newName} onChange={(e) => setNewName(e.target.value)} />
          <Button type="submit" size="xs" disabled={busy || !newName.trim()}>
            Create and switch
          </Button>
          <Button type="button" size="xs" variant="ghost" onClick={() => setCreating(false)}>
            Cancel
          </Button>
        </form>
      )}

      {ops.notice && (
        <div role={ops.notice.ok ? 'status' : 'alert'} data-testid="git-notice" className={cn('flex shrink-0 items-start gap-2 border-b px-3 py-1.5 text-xs', ops.notice.ok ? 'bg-success/10' : 'bg-destructive/10')}>
          <div className="max-h-32 min-w-0 flex-1 overflow-y-auto">
            <p className="font-semibold">{ops.notice.title}</p>
            {ops.notice.text && <pre className="font-mono break-words whitespace-pre-wrap">{ops.notice.text}</pre>}
          </div>
          <Button size="icon-xs" variant="ghost" aria-label="Dismiss" onClick={() => ops.setNotice(null)}>
            <X />
          </Button>
        </div>
      )}

      <div role="tablist" aria-label="Git views" className="flex h-8 shrink-0 items-stretch gap-0.5 border-b px-2">
        {(['changes', 'history'] as const).map((v) => (
          <button
            key={v}
            type="button"
            role="tab"
            aria-selected={view === v}
            onClick={() => setView(v)}
            className={cn('flex items-center gap-1.5 border-b-2 px-2.5 text-xs font-medium', view === v ? 'border-primary text-foreground' : 'text-muted-foreground hover:text-foreground border-transparent')}
          >
            {v === 'changes' ? 'Changes' : 'History'}
            {v === 'changes' && st.files.length + st.more > 0 && <span className="bg-muted rounded-full px-1.5 text-[10px] tabular-nums">{st.files.length + st.more}</span>}
          </button>
        ))}
        <span className="text-muted-foreground ml-auto self-center truncate font-mono text-[10px]" title={st.root}>
          {st.root}
        </span>
      </div>

      {view === 'changes' ? <ChangesView crewId={crewId} status={st} ops={ops} wide={wide} ask={setConfirm} /> : <HistoryView crewId={crewId} wide={wide} />}
      <ConfirmDialog confirm={confirm} onClose={() => setConfirm(null)} />
    </div>
  )
}
