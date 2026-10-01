import { useEffect, useRef } from 'react'
import { cn } from '@/lib/utils'

export interface MenuItem {
  label: string
  onSelect: () => void
  destructive?: boolean
  separatorBefore?: boolean
}

// A context menu at viewport coordinates; the backdrop closes it on any outside click or right click.
export function ContextMenu({ x, y, label, items, onClose }: { x: number; y: number; label: string; items: MenuItem[]; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    el.style.left = `${Math.max(4, Math.min(x, window.innerWidth - el.offsetWidth - 4))}px`
    el.style.top = `${Math.max(4, Math.min(y, window.innerHeight - el.offsetHeight - 4))}px`
    el.querySelector<HTMLElement>('[role="menuitem"]')?.focus()
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [x, y, onClose])

  const move = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
    e.preventDefault()
    const all = Array.from(e.currentTarget.querySelectorAll<HTMLElement>('[role="menuitem"]'))
    const at = all.indexOf(document.activeElement as HTMLElement)
    all[(at + (e.key === 'ArrowDown' ? 1 : -1) + all.length) % all.length]?.focus()
  }

  return (
    <>
      <div
        className="fixed inset-0 z-40"
        onClick={onClose}
        onContextMenu={(e) => {
          e.preventDefault()
          onClose()
        }}
      />
      <div
        ref={ref}
        role="menu"
        aria-label={label}
        onKeyDown={move}
        style={{ left: x, top: y }}
        className="bg-popover text-popover-foreground fixed z-50 min-w-48 rounded-md border p-1 shadow-md"
      >
        {items.map((item) => (
          <div key={item.label}>
            {item.separatorBefore && <div className="bg-border -mx-1 my-1 h-px" role="separator" />}
            <button
              role="menuitem"
              onClick={() => {
                onClose()
                item.onSelect()
              }}
              className={cn(
                'hover:bg-accent focus:bg-accent flex w-full items-center rounded-sm px-2 py-1.5 text-left text-sm outline-none',
                item.destructive && 'text-destructive',
              )}
            >
              {item.label}
            </button>
          </div>
        ))}
      </div>
    </>
  )
}
