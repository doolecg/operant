import { Fragment, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from 'react'
import { cn } from '@/lib/utils'
import { dragHandle, type LayoutNode } from './layout'

interface Props {
  node: LayoutNode
  path?: number[]
  renderTile: (id: string) => ReactNode
  // Called when a resize ends or a handle moves with the keyboard: the new sizes of the split at `path`.
  onSizes: (path: number[], sizes: number[]) => void
}

const STEP = 0.03

export function SplitTree({ node, path = [], renderTile, onSizes }: Props) {
  if (node.type === 'leaf') return <>{renderTile(node.id)}</>
  return <Split node={node} path={path} renderTile={renderTile} onSizes={onSizes} />
}

function Split({ node, path, renderTile, onSizes }: Props & { node: Extract<LayoutNode, { type: 'split' }>; path: number[] }) {
  const box = useRef<HTMLDivElement>(null)
  const [live, setLive] = useState<number[] | null>(null)
  const sizes = live ?? node.sizes
  const row = node.dir === 'row'

  const onPointerDown = (e: PointerEvent<HTMLDivElement>, index: number) => {
    const el = box.current
    if (!el) return
    e.preventDefault()
    const handle = e.currentTarget
    handle.setPointerCapture(e.pointerId)
    const total = row ? el.clientWidth : el.clientHeight
    const start = row ? e.clientX : e.clientY
    const base = node.sizes
    let latest = base
    const move = (ev: globalThis.PointerEvent) => {
      latest = dragHandle(base, index, ((row ? ev.clientX : ev.clientY) - start) / Math.max(1, total))
      setLive(latest)
    }
    const up = () => {
      handle.removeEventListener('pointermove', move)
      handle.removeEventListener('pointerup', up)
      handle.removeEventListener('pointercancel', up)
      setLive(null)
      if (latest !== base) onSizes(path, latest)
    }
    handle.addEventListener('pointermove', move)
    handle.addEventListener('pointerup', up)
    handle.addEventListener('pointercancel', up)
  }

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>, index: number) => {
    const back = row ? 'ArrowLeft' : 'ArrowUp'
    const forward = row ? 'ArrowRight' : 'ArrowDown'
    if (e.key !== back && e.key !== forward) return
    e.preventDefault()
    onSizes(path, dragHandle(node.sizes, index, e.key === back ? -STEP : STEP))
  }

  return (
    <div ref={box} className={cn('flex h-full min-h-0 w-full min-w-0', row ? 'flex-row' : 'flex-col')}>
      {node.children.map((child, i) => (
        <Fragment key={childKey(child, i)}>
          <div className="relative min-h-0 min-w-0" style={{ flex: `${sizes[i]} 1 0%` }}>
            <div className="absolute inset-0">
              <SplitTree node={child} path={[...path, i]} renderTile={renderTile} onSizes={onSizes} />
            </div>
          </div>
          {i < node.children.length - 1 && (
            <div
              role="separator"
              tabIndex={0}
              aria-orientation={row ? 'vertical' : 'horizontal'}
              aria-label={`Resize ${row ? 'columns' : 'rows'} ${i + 1} and ${i + 2}`}
              aria-valuenow={Math.round((sizes[i] ?? 0) * 100)}
              aria-valuemin={0}
              aria-valuemax={100}
              onPointerDown={(e) => onPointerDown(e, i)}
              onKeyDown={(e) => onKeyDown(e, i)}
              className={cn(
                'hover:bg-primary/40 focus-visible:bg-primary/60 shrink-0 touch-none rounded-full outline-none transition-colors',
                row ? 'mx-0.5 w-1 cursor-col-resize' : 'my-0.5 h-1 cursor-row-resize',
              )}
            />
          )}
        </Fragment>
      ))}
    </div>
  )
}

const childKey = (n: LayoutNode, i: number) => (n.type === 'leaf' ? n.id : `split-${i}`)
