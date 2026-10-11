import { useEffect, useRef, type ReactNode } from 'react'
import { Code2, Globe, Maximize2, Minimize2, Sparkle, SquareTerminal, X } from 'lucide-react'
import { cn } from '@/lib/utils'

interface Props {
  id: string
  title: string
  // Shown beside the title, e.g. a status dot.
  badge?: ReactNode
  // The header's parts: an icon chip, the visible heading (defaults to the title), a muted subtitle and a status pill.
  icon?: ReactNode
  heading?: string
  subtitle?: string
  status?: ReactNode
  focused: boolean
  fullscreen: boolean
  style: React.CSSProperties
  hidden: boolean
  onClose?: () => void
  onFocus: () => void
  onFullscreen: () => void
  // 'hide' = no header, 'compact' = a thin one.
  strip?: 'compact' | 'normal' | 'hide'
  // A thin row under the header (the info bar).
  info?: ReactNode
  children: ReactNode
}

// One tile of the Terminal view: a positioned frame with a small header. A click or a focus change moves the focus; the
// terminal inside takes keyboard focus when its tile is the focused one.
export function TileIcon({ kind, compact }: { kind: string; compact?: boolean }) {
  const chip = compact ? 'size-5' : 'size-6'
  const ic = compact ? 'size-3' : 'size-3.5'
  if (kind === 'claude')
    return (
      <span aria-hidden className={cn('grid shrink-0 place-items-center rounded-md bg-[#d97757]/15', chip)}>
        <Sparkle className={cn('fill-[#d97757] text-[#d97757]', ic)} />
      </span>
    )
  return (
    <span aria-hidden className={cn('bg-foreground/[0.08] grid shrink-0 place-items-center rounded-md', chip)}>
      {kind === 'opencode' ? (
        <Code2 className={cn('text-foreground', ic)} />
      ) : kind === 'browser' ? (
        <Globe className={cn('text-foreground', ic)} />
      ) : (
        <SquareTerminal className={cn('text-muted-foreground', ic)} />
      )}
    </span>
  )
}

export function TileFrame({ id, title, badge, icon, heading, subtitle, status, focused, fullscreen, style, hidden, onClose, onFocus, onFullscreen, strip = 'normal', info, children }: Props) {
  const root = useRef<HTMLElement>(null)
  useEffect(() => {
    if (focused) root.current?.querySelector<HTMLElement>('textarea.xterm-helper-textarea, textarea[data-chat-composer]')?.focus()
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
        'bg-card absolute flex flex-col overflow-hidden rounded-2xl border shadow-xs transition-[left,top,width,height,border-color] duration-150 dark:shadow-none',
        focused && 'border-primary/60',
        hidden && 'invisible',
      )}
    >
      {strip !== 'hide' && (
        <div className={cn('flex shrink-0 items-center text-xs', strip === 'compact' ? 'h-7 gap-1.5 pr-1.5 pl-2' : 'h-10 gap-2 pr-2 pl-3')}>
          {icon}
          <h2 title={title} className="min-w-0 shrink-0 truncate text-[13px] font-semibold">
            {heading ?? title}
          </h2>
          {strip !== 'compact' && subtitle && <span className="text-muted-foreground min-w-0 truncate text-xs">· {subtitle}</span>}
          {badge}
          <span className="flex-1" />
          {status}
          <button
            type="button"
            aria-label={fullscreen ? `Leave fullscreen for ${title}` : `Fullscreen ${title}`}
            onClick={onFullscreen}
            className="text-muted-foreground hover:bg-accent hover:text-foreground grid size-7 place-items-center rounded-full"
          >
            {fullscreen ? <Minimize2 className="size-3.5" /> : <Maximize2 className="size-3.5" />}
          </button>
          {onClose && (
            <button
              type="button"
              aria-label={`Close ${title}`}
              title="Close this tile"
              onClick={onClose}
              className="text-muted-foreground hover:bg-accent hover:text-foreground grid size-7 place-items-center rounded-full"
            >
              <X className="size-3.5" />
            </button>
          )}
        </div>
      )}
      {info}
      <div className="min-h-0 flex-1">{children}</div>
    </section>
  )
}
