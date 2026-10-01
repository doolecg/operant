import { useEffect, useState } from 'react'
import { Columns2, Play, Rows2, Square } from 'lucide-react'
import { decodeIpcError } from '@shared/ipc'
import { OperatorTerminal } from '@/components/dashboard/OperatorTerminal'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { DropdownMenuItem, DropdownMenuSeparator } from '@/components/ui/dropdown-menu'
import { useMaster, useStartMaster, useStopMaster } from '@/lib/queries'
import type { SplitDir } from './layout'
import type { FrameHandlers } from './ScratchTile'
import { TileFrame } from './TileFrame'

interface Props extends FrameHandlers {
  tileId: string
  crewId: number
  onSplit: (dir: SplitDir) => void
}

// The Master Terminal is pinned in every layout: it cannot be closed or deleted, only started and stopped.
export function MasterTile({ tileId, crewId, onSplit, ...frame }: Props) {
  const { data: master } = useMaster(crewId)
  const start = useStartMaster()
  const stop = useStopMaster()
  const [error, setError] = useState<string | null>(null)
  const running = master != null && master.status !== 'stopped' && master.status !== 'error'

  useEffect(() => setError(null), [crewId])

  const run = () => {
    setError(null)
    start.mutate([crewId], { onError: (e) => setError(decodeIpcError(e).message) })
  }
  const halt = () => {
    setError(null)
    stop.mutate([crewId], { onError: (e) => setError(decodeIpcError(e).message) })
  }

  return (
    <TileFrame
      tileId={tileId}
      title="Master Terminal"
      draggable={false}
      indicator={<span aria-hidden className={running ? 'size-2 shrink-0 rounded-full bg-emerald-400' : 'bg-muted-foreground size-2 shrink-0 rounded-full'} />}
      badges={
        <>
          <Badge variant="outline" className="font-normal">
            Pinned
          </Badge>
          {running ? (
            <Button variant="ghost" size="sm" aria-label="Stop the Master Terminal" disabled={stop.isPending} onClick={halt}>
              <Square /> Stop
            </Button>
          ) : (
            <Button variant="ghost" size="sm" aria-label="Start the Master Terminal" disabled={start.isPending} onClick={run}>
              <Play /> Start
            </Button>
          )}
        </>
      }
      menu={
        <>
          {running ? (
            <DropdownMenuItem onSelect={halt}>
              <Square /> Stop
            </DropdownMenuItem>
          ) : (
            <DropdownMenuItem onSelect={run}>
              <Play /> Start
            </DropdownMenuItem>
          )}
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => onSplit('row')}>
            <Columns2 /> New terminal to the right
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => onSplit('col')}>
            <Rows2 /> New terminal below
          </DropdownMenuItem>
        </>
      }
      {...frame}
    >
      {running && master ? (
        <OperatorTerminal operatorId={master.id} autoFocus={frame.focused} />
      ) : (
        <div className="text-muted-foreground grid h-full place-items-center p-4 text-center text-sm">
          <div className="space-y-3">
            <p>Your own Claude Code for this crew, with elevated rights over its jobs and messages.</p>
            {error && (
              <p role="alert" className="text-destructive text-xs">
                {error}
              </p>
            )}
            <Button size="sm" disabled={start.isPending} onClick={run}>
              <Play /> Start Master Terminal
            </Button>
          </div>
        </div>
      )}
    </TileFrame>
  )
}
