import { Textarea } from '@/components/ui/textarea'
import { cn } from '@/lib/utils'

// Built-in role texts run 150 to 300 words; past that every turn's prefix grows with them.
export const ROLE_WORD_BUDGET = 300

export const countWords = (text: string) => (text.trim() === '' ? 0 : text.trim().split(/\s+/).length)

export function RoleTextEditor({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const words = countWords(value)
  const over = words > ROLE_WORD_BUDGET
  return (
    <div className="space-y-1.5">
      <Textarea
        id="preset-role"
        aria-label="Guidance text"
        aria-describedby="preset-role-count"
        aria-invalid={over || undefined}
        className="min-h-48 font-mono text-xs"
        spellCheck={false}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
      <div id="preset-role-count" className="flex items-start justify-between gap-4 text-xs">
        <p className={cn('text-muted-foreground', over && 'text-amber-500')} role={over ? 'alert' : undefined}>
          {over
            ? `Over the ${ROLE_WORD_BUDGET}-word budget. The guidance text is sent as part of every turn, so each extra word is paid for on every turn.`
            : `Under the ${ROLE_WORD_BUDGET}-word budget. Keep it to purpose, a few rules, a never line and the report format; permissions live in the launch settings.`}
        </p>
        <span className={cn('text-muted-foreground shrink-0 tabular-nums', over && 'text-amber-500')} aria-live="polite">
          {words} {words === 1 ? 'word' : 'words'}
        </span>
      </div>
    </div>
  )
}
