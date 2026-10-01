import { useEffect, useRef, useState } from 'react'
import { Columns2, Pencil, RotateCw, Rows2, Settings2, Trash2, X } from 'lucide-react'
import { decodeIpcError } from '@shared/ipc'
import type { ScratchTerminal } from '@shared/types'
import { OperatorTerminal } from '@/components/dashboard/OperatorTerminal'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { DropdownMenuItem, DropdownMenuSeparator } from '@/components/ui/dropdown-menu'
import { bridge } from '@/lib/bridge'
import { agentLabel, usd } from '@/lib/format'
import { useDeleteScratch, useScratchSpends, useStartScratch, useStopScratch } from '@/lib/queries'
import type { SplitDir } from './layout'
import { TileFrame } from './TileFrame'

export interface FrameHandlers {
  focused: boolean
  fullscreen: boolean
  onFocus: () => void
  onToggleFullscreen: () => void
  onExitFullscreen: () => void
  onDropTile: (fromId: string) => void
}

interface Props extends FrameHandlers {
  tileId: string
  scratch: ScratchTerminal
  // Takes the tile out of the layout (its session is already stopped).
  onClosed: () => void
  onEdit: () => void
  onSplit: (dir: SplitDir) => void
}

type Confirm = 'close' | 'delete' | null

export function ScratchTile({ tileId, scratch, onClosed, onEdit, onSplit, ...frame }: Props) {
  const start = useStartScratch()
  const stop = useStopScratch()
  const del = useDeleteScratch()
  const spent = useScratchSpends(scratch.crewId).data?.find((s) => s.scratchId === scratch.id)
  const [exitCode, setExitCode] = useState<number | null>(null)
  const [generation, setGeneration] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [confirm, setConfirm] = useState<Confirm>(null)
  const restarting = useRef<boolean | null>(null)
  const resumeNext = useRef(false)

  const run = (resume: boolean) => {
    setError(null)
    start.mutate([scratch.id, resume], {
      onSuccess: () => {
        setExitCode(null)
        setGeneration((g) => g + 1)
      },
      onError: (e) => setError(decodeIpcError(e).message),
    })
  }

  // An open tile owns a running session: starting never restarts one that runs, and the terminal replays its buffer.
  useEffect(() => {
    setExitCode(null)
    start.mutate([scratch.id, false], { onError: (e) => setError(decodeIpcError(e).message) })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scratch.id])

  useEffect(
    () =>
      bridge().on('scratch:exit', ({ scratchId, exitCode: code }) => {
        if (scratchId !== scratch.id) return
        if (restarting.current) {
          restarting.current = null
          run(resumeNext.current)
        } else setExitCode(code)
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [scratch.id],
  )

  const restart = (resume: boolean) => {
    resumeNext.current = resume
    if (exitCode != null) return run(resume)
    restarting.current = true
    stop.mutate([scratch.id], { onError: (e) => setError(decodeIpcError(e).message) })
  }

  const close = () => {
    setConfirm(null)
    stop.mutate([scratch.id], { onSettled: onClosed })
  }

  const remove = () => {
    del.mutate([scratch.id], {
      onSuccess: () => {
        setConfirm(null)
        onClosed()
      },
      onError: (e) => setError(decodeIpcError(e).message),
    })
  }

  const isAgent = scratch.agent !== 'shell'
  const canResume = scratch.agent === 'claude' && scratch.sessionId != null

  return (
    <>
      <TileFrame
        tileId={tileId}
        title={scratch.title}
        draggable
        indicator={
          <span
            aria-hidden
            className={exitCode != null ? 'bg-muted-foreground size-2 shrink-0 rounded-full' : 'size-2 shrink-0 rounded-full bg-emerald-400'}
          />
        }
        badges={
          <>
            <Badge variant="outline" className="font-normal">
              {agentLabel[scratch.agent]}
            </Badge>
            {spent && (
              <Badge variant="outline" className="font-normal tabular-nums" title="This terminal's spend over the last 24 hours">
                {usd(spent.costUsd)}
              </Badge>
            )}
            {exitCode != null && <Badge variant="secondary">Exited</Badge>}
          </>
        }
        menu={
          <>
            <DropdownMenuItem onSelect={onEdit}>
              <Pencil /> Rename
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={onEdit}>
              <Settings2 /> Edit settings
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => restart(false)}>
              <RotateCw /> Restart
            </DropdownMenuItem>
            {canResume && (
              <DropdownMenuItem onSelect={() => restart(true)}>
                <RotateCw /> Restart and resume session
              </DropdownMenuItem>
            )}
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => onSplit('row')}>
              <Columns2 /> New terminal to the right
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => onSplit('col')}>
              <Rows2 /> New terminal below
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => (isAgent ? setConfirm('close') : close())}>
              <X /> Close
            </DropdownMenuItem>
            <DropdownMenuItem variant="destructive" onSelect={() => setConfirm('delete')}>
              <Trash2 /> Delete
            </DropdownMenuItem>
          </>
        }
        {...frame}
      >
        <OperatorTerminal key={generation} sessionKey={`scratch:${scratch.id}`} autoFocus={frame.focused} />
        {(exitCode != null || error) && (
          <div className="absolute inset-x-0 bottom-0 flex items-center gap-3 border-t bg-zinc-950/95 px-3 py-2 text-xs">
            <span role={error ? 'alert' : 'status'} className={error ? 'text-destructive' : 'text-muted-foreground'}>
              {error ?? `Session ended${exitCode ? ` (exit ${exitCode})` : ''}.`}
            </span>
            <Button size="sm" variant="outline" className="ml-auto" onClick={() => restart(false)}>
              Restart
            </Button>
          </div>
        )}
      </TileFrame>

      <Dialog open={confirm === 'close'} onOpenChange={(o) => !o && setConfirm(null)}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Close {scratch.title}?</DialogTitle>
            <DialogDescription>
              This ends the {agentLabel[scratch.agent]} session, including a turn that is still running. The tile stays in the closed list and can
              be reopened.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setConfirm(null)}>
              Cancel
            </Button>
            <Button onClick={close}>Close terminal</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={confirm === 'delete'} onOpenChange={(o) => !o && setConfirm(null)}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Delete {scratch.title}?</DialogTitle>
            <DialogDescription>
              The session ends and the terminal is removed (1 tile). Spend it already recorded stays in the Cost tab.
            </DialogDescription>
          </DialogHeader>
          {error && (
            <p role="alert" className="text-destructive text-xs">
              {error}
            </p>
          )}
          <DialogFooter>
            <Button variant="ghost" onClick={() => setConfirm(null)}>
              Cancel
            </Button>
            <Button variant="destructive" disabled={del.isPending} onClick={remove}>
              Delete terminal
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
