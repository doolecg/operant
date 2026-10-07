import { useMemo, useState } from 'react'
import { Check, ChevronDown } from 'lucide-react'
import { Popover as PopoverPrimitive } from 'radix-ui'
import { cn } from '@/lib/utils'

export interface SearchOption {
  value: string
  label: string
}

interface Props {
  options: SearchOption[]
  value: string
  onValueChange: (v: string) => void
  // Shown on the trigger when nothing matches `value`.
  placeholder?: string
  'aria-label': string
  className?: string
}

// A select with a type-to-filter box, for lists too long to scan (OpenCode lists hundreds of models). Arrow keys move,
// Enter picks, Esc closes; the list scrolls inside the room the window leaves.
export function SearchSelect({ options, value, onValueChange, placeholder, className, ...rest }: Props) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase()
    return q ? options.filter((o) => o.label.toLowerCase().includes(q)) : options
  }, [options, query])
  const current = options.find((o) => o.value === value)
  const pick = (o: SearchOption) => {
    onValueChange(o.value)
    setOpen(false)
  }

  return (
    <PopoverPrimitive.Root
      open={open}
      onOpenChange={(o) => {
        setOpen(o)
        if (o) (setQuery(''), setActive(Math.max(0, options.findIndex((x) => x.value === value))))
      }}
    >
      <PopoverPrimitive.Trigger
        aria-label={rest['aria-label']}
        className={cn(
          'border-input dark:bg-input/30 focus-visible:border-ring focus-visible:ring-ring/50 flex h-9 w-fit items-center justify-between gap-2 rounded-md border bg-transparent px-3 py-2 text-sm whitespace-nowrap shadow-xs outline-none focus-visible:ring-[3px]',
          className,
        )}
      >
        <span className="min-w-0 truncate">{current?.label ?? placeholder ?? ''}</span>
        <ChevronDown className="size-4 shrink-0 opacity-50" />
      </PopoverPrimitive.Trigger>
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Content
          align="start"
          sideOffset={4}
          collisionPadding={8}
          className="bg-popover text-popover-foreground z-50 flex max-h-(--radix-popover-content-available-height) w-80 max-w-[calc(100vw-1rem)] flex-col overflow-hidden rounded-md border shadow-md"
        >
          <input
            autoFocus
            role="combobox"
            aria-expanded
            aria-controls="search-select-list"
            aria-label="Filter"
            placeholder={`Filter ${options.length} options`}
            value={query}
            onChange={(e) => (setQuery(e.target.value), setActive(0))}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') (e.preventDefault(), setActive((a) => Math.min(shown.length - 1, a + 1)))
              else if (e.key === 'ArrowUp') (e.preventDefault(), setActive((a) => Math.max(0, a - 1)))
              else if (e.key === 'Enter') (e.preventDefault(), shown[active] && pick(shown[active]))
            }}
            className="shrink-0 border-b bg-transparent px-3 py-2 text-sm outline-none"
          />
          <ul id="search-select-list" role="listbox" aria-label="Options" className="min-h-0 flex-1 overflow-y-auto p-1">
            {shown.length === 0 && <li className="text-muted-foreground px-2 py-1.5 text-xs">No match.</li>}
            {shown.map((o, i) => (
              <li
                key={o.value}
                role="option"
                aria-selected={o.value === value}
                ref={(el) => {
                  if (el && i === active) el.scrollIntoView({ block: 'nearest' })
                }}
                onMouseMove={() => setActive(i)}
                onClick={() => pick(o)}
                className={cn(
                  'flex cursor-default items-center gap-2 rounded-sm px-2 py-1.5 font-mono text-xs select-none',
                  i === active && 'bg-accent text-accent-foreground',
                )}
              >
                <span className="min-w-0 flex-1 truncate">{o.label}</span>
                {o.value === value && <Check className="size-3.5 shrink-0" />}
              </li>
            ))}
          </ul>
        </PopoverPrimitive.Content>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  )
}
