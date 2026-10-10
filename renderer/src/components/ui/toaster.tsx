import { X } from 'lucide-react'
import { dismissToast, useToasts } from '@/lib/toast'
import { cn } from '@/lib/utils'

export function Toaster() {
  const toasts = useToasts()
  if (toasts.length === 0) return null
  return (
    <div className="pointer-events-none fixed right-4 bottom-4 z-[100] flex w-80 flex-col gap-2" data-testid="toaster">
      {toasts.map((t) => (
        <div
          key={t.id}
          role={t.error ? 'alert' : 'status'}
          className={cn(
            'bg-popover text-popover-foreground pointer-events-auto flex items-start gap-2 rounded-xl border p-3 text-sm shadow-lg',
            t.error && 'border-destructive/60',
          )}
        >
          <span className="min-w-0 flex-1 break-words">{t.text}</span>
          <button type="button" aria-label="Dismiss" className="text-muted-foreground hover:text-foreground" onClick={() => dismissToast(t.id)}>
            <X className="size-4" />
          </button>
        </div>
      ))}
    </div>
  )
}
