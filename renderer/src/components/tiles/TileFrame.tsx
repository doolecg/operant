import { useState, type ReactNode } from 'react'
import { GripVertical, Maximize2, Minimize2, MoreHorizontal } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { cn } from '@/lib/utils'

export const TILE_MIME = 'application/x-operant-tile'

interface Props {
  tileId: string
  title: string
  focused: boolean
  fullscreen: boolean
  // The Master Terminal is pinned: it can be a drop target but not dragged.
  draggable: boolean
  indicator?: ReactNode
  badges?: ReactNode
  menu: ReactNode
  onFocus: () => void
  onToggleFullscreen: () => void
  onExitFullscreen: () => void
  onDropTile: (fromId: string) => void
  children: ReactNode
}

// Title bar (drag handle, name, badges, fullscreen, menu) around a tile's body.
export function TileFrame({
  tileId,
  title,
  focused,
  fullscreen,
  draggable,
  indicator,
  badges,
  menu,
  onFocus,
  onToggleFullscreen,
  onExitFullscreen,
  onDropTile,
  children,
}: Props) {
  const [over, setOver] = useState(false)
  return (
    <section
      aria-label={`Terminal tile ${title}`}
      data-tile={tileId}
      onMouseDownCapture={onFocus}
      onFocusCapture={onFocus}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes(TILE_MIME)) {
          e.preventDefault()
          setOver(true)
        }
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        setOver(false)
        const from = e.dataTransfer.getData(TILE_MIME)
        if (from && from !== tileId) {
          e.preventDefault()
          onDropTile(from)
        }
      }}
      className={cn(
        'bg-card flex h-full min-h-0 min-w-0 flex-col overflow-hidden rounded-lg border',
        focused && 'border-primary/60',
        over && 'ring-primary ring-2',
      )}
    >
      <header
        className="flex h-9 shrink-0 items-center gap-1.5 border-b px-1.5"
        onKeyDown={(e) => {
          if (e.key === 'Escape' && fullscreen) onExitFullscreen()
        }}
      >
        {draggable ? (
          <span
            draggable
            aria-label={`Drag ${title} to reorder`}
            title="Drag to reorder"
            onDragStart={(e) => {
              e.dataTransfer.setData(TILE_MIME, tileId)
              e.dataTransfer.effectAllowed = 'move'
            }}
            className="text-muted-foreground flex size-6 shrink-0 cursor-grab items-center justify-center"
          >
            <GripVertical className="size-3.5" />
          </span>
        ) : (
          <span className="size-1" />
        )}
        {indicator}
        <span className="min-w-0 flex-1 truncate text-sm font-medium">{title}</span>
        {badges}
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={fullscreen ? `Exit fullscreen for ${title}` : `Fullscreen ${title}`}
          onClick={onToggleFullscreen}
        >
          {fullscreen ? <Minimize2 /> : <Maximize2 />}
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon-sm" aria-label={`Menu for ${title}`}>
              <MoreHorizontal />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">{menu}</DropdownMenuContent>
        </DropdownMenu>
      </header>
      <div className="relative min-h-0 flex-1">{children}</div>
    </section>
  )
}
