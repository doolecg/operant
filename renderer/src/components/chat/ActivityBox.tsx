import { useState } from 'react'
import { Brain, ChevronDown, ChevronUp, Code2, Loader2 } from 'lucide-react'
import { useLearnStatus } from '@/lib/queries'
import { cn } from '@/lib/utils'
import { useActivity } from './activityStore'

const SHOWN = 5

function Section({ icon, title, note, items }: { icon: React.ReactNode; title: string; note?: string; items: string[] }) {
  return (
    <div className="space-y-0.5">
      <div className="text-foreground flex items-center gap-1.5 font-medium">
        {icon}
        {title}
        <span className="text-muted-foreground/70 font-normal">{items.length || ''}</span>
      </div>
      {items.length === 0 ? (
        <div className="text-muted-foreground/70 pl-5">{note || 'none'}</div>
      ) : (
        <ul className="text-muted-foreground space-y-0.5 pl-5">
          {items.slice(0, SHOWN).map((t, i) => (
            <li key={i} className="truncate" title={t}>
              {t}
            </li>
          ))}
          {items.length > SHOWN && <li className="text-muted-foreground/70">+{items.length - SHOWN} more</li>}
        </ul>
      )}
    </div>
  )
}

// A small box in the chat's bottom-left corner: what Operant is doing around this chat (learning, enhancing) and what
// Hindsight and CodeGraph gave the last prompt enhance. Hidden until there is something to say.
export function ActivityBox({ scratchId }: { scratchId: number }) {
  const { phase, context } = useActivity(scratchId)
  const learning = useLearnStatus().data?.running ?? false
  const [open, setOpen] = useState(true)
  const busy = learning || phase !== 'idle'
  if (!busy && !context) return null

  const lines = [learning && 'Learning from a finished session', phase === 'context' && 'Gathering context', phase === 'rewrite' && 'Enhancing the prompt'].filter(Boolean) as string[]
  return (
    <aside aria-label="Activity" className="bg-popover/95 border-border absolute bottom-2 left-2 z-10 w-64 rounded-xl border text-[12px] shadow-md backdrop-blur">
      <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} className="text-muted-foreground hover:text-foreground flex w-full items-center gap-1.5 px-3 py-1.5 text-left">
        {busy ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : <Brain className="size-3.5" aria-hidden />}
        <span className="min-w-0 flex-1 truncate">{lines[0] ?? 'Last enhance'}</span>
        {open ? <ChevronDown className="size-3.5" aria-hidden /> : <ChevronUp className="size-3.5" aria-hidden />}
      </button>
      {open && (
        <div className={cn('space-y-2 border-t px-3 py-2')}>
          {lines.slice(1).map((l) => (
            <div key={l} className="text-muted-foreground">
              {l}
            </div>
          ))}
          {context && (
            <>
              <Section icon={<Brain className="size-3.5" aria-hidden />} title="Hindsight memories" note={context.memoryNote} items={context.memories} />
              <Section icon={<Code2 className="size-3.5" aria-hidden />} title="CodeGraph symbols" note={context.codeNote} items={context.symbols} />
            </>
          )}
        </div>
      )}
    </aside>
  )
}
