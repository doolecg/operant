import { useRef, useState, type KeyboardEvent, type PointerEvent, type RefObject } from 'react'
import { cn } from '@/lib/utils'

const KEY_STEP = 24

interface Props {
  // The panel this handle sizes; its current size is measured when a drag or key press starts.
  target: RefObject<HTMLElement | null>
  // x resizes the width, y the height.
  axis: 'x' | 'y'
  // 1 when dragging toward +x/+y grows the panel (a left panel, a top panel), -1 when it shrinks it.
  grow: 1 | -1
  min: number | (() => number)
  max: number | (() => number)
  label: string
  onResize: (px: number) => void
  onCommit: (px: number) => void
  onReset: () => void
  className?: string
}

const at = (v: number | (() => number)) => (typeof v === 'function' ? v() : v)

// A thin strip on a panel's edge: drag it, or focus it and use the arrow keys (Shift for bigger steps); Home or a double click resets.
export function ResizeHandle({ target, axis, grow, min, max, label, onResize, onCommit, onReset, className }: Props) {
  const [active, setActive] = useState(false)
  const drag = useRef<{ from: number; size: number; last: number } | null>(null)
  const size = () => {
    const r = target.current?.getBoundingClientRect()
    return r ? (axis === 'x' ? r.width : r.height) : 0
  }
  const clamp = (v: number) => Math.round(Math.min(at(max), Math.max(at(min), v)))
  const pos = (e: PointerEvent) => (axis === 'x' ? e.clientX : e.clientY)

  const down = (e: PointerEvent) => {
    if (e.button !== 0) return
    e.preventDefault()
    e.currentTarget.setPointerCapture(e.pointerId)
    drag.current = { from: pos(e), size: size(), last: size() }
    setActive(true)
  }
  const move = (e: PointerEvent) => {
    const d = drag.current
    if (!d) return
    d.last = clamp(d.size + grow * (pos(e) - d.from))
    onResize(d.last)
  }
  const up = () => {
    const d = drag.current
    drag.current = null
    setActive(false)
    if (d) onCommit(d.last)
  }
  const key = (e: KeyboardEvent) => {
    const dir = axis === 'x' ? { ArrowRight: 1, ArrowLeft: -1 }[e.key] : { ArrowDown: 1, ArrowUp: -1 }[e.key]
    if (e.key === 'Home') {
      e.preventDefault()
      onReset()
    } else if (dir) {
      e.preventDefault()
      const next = clamp(size() + grow * dir * (e.shiftKey ? KEY_STEP * 4 : KEY_STEP))
      onResize(next)
      onCommit(next)
    }
  }

  return (
    <div
      role="separator"
      aria-orientation={axis === 'x' ? 'vertical' : 'horizontal'}
      aria-label={label}
      aria-valuemin={Math.round(at(min))}
      aria-valuemax={Math.round(at(max))}
      aria-valuenow={Math.round(size())}
      tabIndex={0}
      title={`${label}: drag, arrow keys, double click or Home to reset`}
      onPointerDown={down}
      onPointerMove={move}
      onPointerUp={up}
      onPointerCancel={up}
      onDoubleClick={onReset}
      onKeyDown={key}
      data-active={active || undefined}
      className={cn(
        'group/resize absolute z-30 touch-none outline-none',
        axis === 'x' ? 'inset-y-0 w-2 cursor-col-resize' : 'inset-x-0 h-2 cursor-row-resize',
        className,
      )}
    >
      <span
        aria-hidden
        className={cn(
          'bg-primary/0 group-hover/resize:bg-primary/50 group-focus-visible/resize:bg-primary group-data-[active]/resize:bg-primary absolute transition-colors',
          axis === 'x' ? 'inset-y-0 left-1/2 w-0.5 -translate-x-1/2' : 'inset-x-0 top-1/2 h-0.5 -translate-y-1/2',
        )}
      />
    </div>
  )
}

// The top edge of a bottom drawer whose height is a percentage of its parent (15 to 80), remembered in localStorage.
export function DrawerResizeHandle({ root, label, storageKey, onHeight }: { root: RefObject<HTMLElement | null>; label: string; storageKey: string; onHeight: (pct: number) => void }) {
  const total = () => root.current?.parentElement?.getBoundingClientRect().height || 1
  const pct = (px: number) => Math.min(80, Math.max(15, (px / total()) * 100))
  const save = (p: number) => {
    try {
      localStorage.setItem(storageKey, String(Math.round(p)))
    } catch {
      /* storage unavailable */
    }
  }
  return (
    <ResizeHandle
      target={root}
      axis="y"
      grow={-1}
      min={() => total() * 0.15}
      max={() => total() * 0.8}
      label={label}
      className="-top-1"
      onResize={(px) => onHeight(pct(px))}
      onCommit={(px) => save(pct(px))}
      onReset={() => (onHeight(35), save(35))}
    />
  )
}
