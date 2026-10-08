import { useEffect, useRef, type ReactNode } from 'react'
import { Maximize2, Minimize2, Pin, X } from 'lucide-react'
import { cn } from '@/lib/utils'

interface Props {
  id: string
  title: string
  // Shown beside the title, e.g. "read-only", a status dot or the Master's controls.
  badge?: ReactNode
  focused: boolean
  fullscreen: boolean
  style: React.CSSProperties
  hidden: boolean
  // Undefined = the tile cannot be closed (the Master).
  onClose?: () => void
  onFocus: () => void
  onFullscreen: () => void
  pinned?: boolean
  onPin?: () => void
  // 'hide' = no header, 'compact' = a thin one.
  strip?: 'compact' | 'normal' | 'hide'
  children: ReactNode
}

// One tile of the Terminal view: a positioned frame with a small header. A click or a focus change moves the focus; the
// terminal inside takes keyboard focus when its tile is the focused one.
export function TileFrame({ id, title, badge, focused, fullscreen, style, hidden, onClose, onFocus, onFullscreen, pinned, onPin, strip = 'normal', children }: Props) {
  const root = useRef<HTMLElement>(null)
  useEffect(() => {
    if (focused) root.current?.querySelector<HTMLElement>('textarea.xterm-helper-textarea')?.focus()
  }, [focused, hidden])
  return (
    <section
      ref={root}
      aria-label={title}
      data-tile={id}
      data-focused={focused}
      data-fullscreen={fullscreen}
      onPointerDown={onFocus}
      style={style}
      className={cn(
        'bg-card absolute flex flex-col overflow-hidden rounded-md border transition-[left,top,width,height] duration-150',
        focused && 'ring-primary/60 ring-1',
        hidden && 'invisible',
      )}
    >
      {strip !== 'hide' && (
        <div className={cn('flex shrink-0 items-center gap-2 border-b px-2 text-xs', strip === 'compact' ? 'h-6' : 'h-8')}>
          <h2 className="min-w-0 truncate font-medium">{title}</h2>
          {badge}
          <span className="flex-1" />
          {onPin && (
            <button type="button" aria-label={`Keep ${title} open`} aria-pressed={!!pinned} title="Keep open when it finishes" onClick={onPin} className={cn('hover:bg-accent rounded p-1', pinned && 'text-primary')}>
              <Pin className="size-3" />
            </button>
          )}
          <button type="button" aria-label={fullscreen ? `Leave fullscreen for ${title}` : `Fullscreen ${title}`} onClick={onFullscreen} className="hover:bg-accent rounded p-1">
            {fullscreen ? <Minimize2 className="size-3" /> : <Maximize2 className="size-3" />}
          </button>
          {onClose && (
            <button type="button" aria-label={`Close ${title}`} title="Close this tile" onClick={onClose} className="hover:bg-accent rounded p-1">
              <X className="size-3" />
            </button>
          )}
        </div>
      )}
      <div className="min-h-0 flex-1">{children}</div>
    </section>
  )
}
