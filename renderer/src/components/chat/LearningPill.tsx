import { useEffect, useState } from 'react'
import { Brain, ChevronUp, Loader2 } from 'lucide-react'
import { useLearnStatus } from '@/lib/queries'
import { STORE_LABEL } from '@/components/memory/ui'

// Top right of a terminal tile: a small pill for memory learning that opens by itself when a learn run starts and
// folds back when it ends. Click it to open or close it by hand.
export function LearningPill() {
  const s = useLearnStatus().data
  const running = s?.running ?? false
  const [open, setOpen] = useState(false)
  useEffect(() => setOpen(running), [running])
  if (!s?.enabled) return null

  return (
    <aside aria-label="Memory learning" className="bg-popover/95 border-border absolute top-2 right-2 z-10 w-56 rounded-xl border text-[12px] shadow-md backdrop-blur">
      <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} className="text-muted-foreground hover:text-foreground flex w-full items-center gap-1.5 px-3 py-1.5 text-left">
        {running ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : <Brain className="size-3.5" aria-hidden />}
        <span className="min-w-0 flex-1 truncate">{running ? 'Learning…' : 'Memory'}</span>
        <ChevronUp className={open ? 'size-3.5 rotate-180' : 'size-3.5'} aria-hidden />
      </button>
      {open && (
        <ul className="space-y-0.5 border-t px-3 py-2" aria-label="Learning stores">
          {s.stores.map((st) => (
            <li key={st.store} className="text-muted-foreground flex justify-between gap-2">
              <span>{STORE_LABEL[st.store]}</span>
              <span>{!st.enabled ? 'Off' : st.up ? 'Up' : 'Down'}</span>
            </li>
          ))}
        </ul>
      )}
    </aside>
  )
}
