import { useEffect, useMemo, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { Pencil, Plus, SquareTerminal, Trash2 } from 'lucide-react'
import { decodeIpcError } from '@shared/ipc'
import type { ScratchTerminal } from '@shared/types'
import { MasterTile } from '@/components/tiles/MasterTile'
import { ScratchDialog } from '@/components/tiles/ScratchDialog'
import { ScratchTile } from '@/components/tiles/ScratchTile'
import { SplitTree } from '@/components/tiles/SplitTree'
import {
  MASTER,
  addTile,
  leaves,
  normalizeLayout,
  removeTile,
  scratchIdOf,
  scratchTile,
  setSizes,
  swapTiles,
  type SplitDir,
  type TileLayout,
} from '@/components/tiles/layout'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { agentLabel, usd } from '@/lib/format'
import { keys, useDeleteScratch, useSaveTileLayout, useScratch, useScratchSpend, useTileLayout } from '@/lib/queries'
import type { ViewProps } from '@/registry'

export function TilesView({ crewId, crew }: ViewProps) {
  const scratch = useScratch(crewId)
  const saved = useTileLayout(crewId)
  if (!scratch.data || saved.isLoading) {
    return <div className="text-muted-foreground grid h-full place-items-center text-sm">Loading tiles</div>
  }
  return <TilesBody key={crewId} crewId={crewId} crewFolder={crew.folder} scratch={scratch.data} savedLayout={saved.data} />
}

type DialogState = { mode: 'create'; target: string | null; dir: SplitDir } | { mode: 'edit'; scratch: ScratchTerminal } | null

function TilesBody({
  crewId,
  crewFolder,
  scratch,
  savedLayout,
}: {
  crewId: number
  crewFolder: string
  scratch: ScratchTerminal[]
  savedLayout: unknown
}) {
  const qc = useQueryClient()
  const save = useSaveTileLayout()
  const spend = useScratchSpend(crewId)
  const [raw, setRaw] = useState<unknown>(savedLayout)
  const [focused, setFocused] = useState<string>(MASTER)
  const [fullscreen, setFullscreen] = useState<string | null>(null)
  const [dialog, setDialog] = useState<DialogState>(null)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [deleting, setDeleting] = useState<ScratchTerminal | null>(null)

  const byId = useMemo(() => new Map(scratch.map((s) => [s.id, s])), [scratch])
  const layout = useMemo(() => normalizeLayout(raw, new Set(byId.keys())), [raw, byId])
  const open = useMemo(() => new Set(leaves(layout.root)), [layout])
  const closed = scratch.filter((s) => !open.has(scratchTile(s.id)))
  const openScratch = open.size - 1

  const commit = (root: TileLayout['root']) => {
    const next: TileLayout = { version: 1, root, fullscreen: null }
    setRaw(next)
    setSaveError(null)
    save.mutate([crewId, next], { onError: (e) => setSaveError(decodeIpcError(e).message) })
  }

  const place = (id: string, target: string | null, dir: SplitDir) => {
    commit(addTile(layout.root, id, target, dir))
    setFocused(id)
  }

  const autoDir = (): SplitDir => (open.size % 2 === 1 ? 'row' : 'col')
  const openCreate = (target: string | null, dir: SplitDir) => setDialog({ mode: 'create', target, dir })

  const close = (id: string) => {
    const next = removeTile(layout.root, id)
    if (next) commit(next)
    if (fullscreen === id) setFullscreen(null)
    if (focused === id) setFocused(MASTER)
  }

  const frame = (id: string) => ({
    focused: focused === id,
    fullscreen: fullscreen === id,
    onFocus: () => setFocused(id),
    onToggleFullscreen: () => setFullscreen((f) => (f === id ? null : id)),
    onExitFullscreen: () => setFullscreen(null),
    onDropTile: (from: string) => commit(swapTiles(layout.root, from, id)),
  })

  const renderTile = (id: string) => {
    if (id === MASTER) {
      return <MasterTile tileId={id} crewId={crewId} onSplit={(dir) => openCreate(id, dir)} {...frame(id)} />
    }
    const s = byId.get(scratchIdOf(id) ?? -1)
    if (!s) return null
    return (
      <ScratchTile
        key={id}
        tileId={id}
        scratch={s}
        onClosed={() => close(id)}
        onEdit={() => setDialog({ mode: 'edit', scratch: s })}
        onSplit={(dir) => openCreate(id, dir)}
        {...frame(id)}
      />
    )
  }

  const scratchSpend = spend.data

  return (
    <div className="flex h-full min-h-0 flex-col gap-3 p-4">
      <div className="flex items-center gap-2">
        <h2 className="text-sm font-medium">Terminals</h2>
        <Badge variant="outline" className="font-normal" title="Scratch terminal spend over the last 24 hours">
          Scratch spend {scratchSpend ? `${usd(scratchSpend.costUsd)} (24h)` : 'unavailable'}
        </Badge>
        {saveError && (
          <span role="alert" className="text-destructive text-xs">
            {saveError}
          </span>
        )}
        <Button className="ml-auto" size="sm" onClick={() => openCreate(focused, autoDir())}>
          <Plus /> New terminal
        </Button>
      </div>

      {closed.length > 0 && (
        <ul aria-label="Closed terminals" className="flex flex-wrap items-center gap-2">
          <li className="text-muted-foreground text-xs">Closed</li>
          {closed.map((s) => (
            <li key={s.id} className="bg-card flex items-center gap-1 rounded-md border py-0.5 pr-0.5 pl-2 text-xs">
              <span className="max-w-40 truncate">{s.title}</span>
              <span className="text-muted-foreground">{agentLabel[s.agent]}</span>
              <Button size="xs" variant="ghost" aria-label={`Open ${s.title}`} onClick={() => place(scratchTile(s.id), focused, autoDir())}>
                Open
              </Button>
              <Button size="icon-xs" variant="ghost" aria-label={`Edit ${s.title}`} onClick={() => setDialog({ mode: 'edit', scratch: s })}>
                <Pencil />
              </Button>
              <Button size="icon-xs" variant="ghost" aria-label={`Delete ${s.title}`} onClick={() => setDeleting(s)}>
                <Trash2 />
              </Button>
            </li>
          ))}
        </ul>
      )}

      <div className="flex min-h-0 flex-1 gap-3">
        <div className="min-w-0 flex-1">
          {fullscreen ? (
            <div className="h-full">{renderTile(fullscreen)}</div>
          ) : (
            <SplitTree node={layout.root} renderTile={renderTile} onSizes={(path, sizes) => commit(setSizes(layout.root, path, sizes))} />
          )}
        </div>
        {openScratch === 0 && !fullscreen && (
          <div className="bg-card/40 grid min-w-0 flex-1 place-items-center rounded-lg border border-dashed p-6 text-center">
            <div className="max-w-xs space-y-3">
              <SquareTerminal className="text-muted-foreground mx-auto size-8" />
              <h3 className="text-sm font-medium">No scratch terminals open</h3>
              <p className="text-muted-foreground text-xs">
                Open a shell, Claude or Codex for quick work that belongs to no squad or job. A closed terminal runs nothing and costs nothing.
              </p>
              <Button size="sm" onClick={() => openCreate(MASTER, 'row')}>
                <Plus /> New terminal
              </Button>
            </div>
          </div>
        )}
      </div>

      <ScratchDialog
        crewId={crewId}
        crewFolder={crewFolder}
        editing={dialog?.mode === 'edit' ? dialog.scratch : null}
        open={dialog != null}
        onOpenChange={(o) => !o && setDialog(null)}
        onCreated={(s) => {
          if (dialog?.mode === 'create') place(scratchTile(s.id), dialog.target, dialog.dir)
          void qc.invalidateQueries({ queryKey: keys.scratch(crewId) })
        }}
      />
      <DeleteClosedDialog scratch={deleting} onOpenChange={(o) => !o && setDeleting(null)} />
    </div>
  )
}

function DeleteClosedDialog({ scratch, onOpenChange }: { scratch: ScratchTerminal | null; onOpenChange: (o: boolean) => void }) {
  const del = useDeleteScratch()
  const [error, setError] = useState<string | null>(null)
  useEffect(() => setError(null), [scratch])
  return (
    <Dialog open={scratch != null} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>Delete {scratch?.title}?</DialogTitle>
          <DialogDescription>
            The terminal is removed (1 terminal). Spend it already recorded stays in the Cost tab.
          </DialogDescription>
        </DialogHeader>
        {error && (
          <p role="alert" className="text-destructive text-xs">
            {error}
          </p>
        )}
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            disabled={del.isPending}
            onClick={() =>
              scratch && del.mutate([scratch.id], { onSuccess: () => onOpenChange(false), onError: (e) => setError(decodeIpcError(e).message) })
            }
          >
            Delete terminal
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
