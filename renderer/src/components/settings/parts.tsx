import { useEffect, useState, type ReactNode } from 'react'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { eventToAccel, formatAccel } from '@/lib/keys'
import { cn } from '@/lib/utils'

// Shared building blocks for the settings sections.
export function Row({ label, hint, htmlFor, children }: { label: string; hint?: string; htmlFor?: string; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-6 py-3">
      <div className="min-w-0">
        <Label htmlFor={htmlFor} className="text-sm">
          {label}
        </Label>
        {hint && <p className="text-muted-foreground mt-0.5 text-xs">{hint}</p>}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  )
}

// A text field that saves when it loses focus or on Enter, so typing doesn't save every keystroke.
export function CommitInput({
  id,
  value,
  onCommit,
  className,
  ...rest
}: { id: string; value: string; onCommit: (v: string) => void } & Omit<React.ComponentProps<typeof Input>, 'value' | 'onChange'>) {
  const [draft, setDraft] = useState(value)
  useEffect(() => setDraft(value), [value])
  const commit = () => draft !== value && onCommit(draft)
  return (
    <Input
      id={id}
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => e.key === 'Enter' && (e.currentTarget.blur(), commit())}
      className={className}
      {...rest}
    />
  )
}

// A whole-number or decimal field that clamps to its range when it commits and shows the saved value again.
export function NumberField({
  id,
  value,
  min,
  max,
  step,
  onCommit,
  className,
  ...rest
}: {
  id: string
  value: number
  min: number
  max: number
  step?: string
  onCommit: (v: number) => void
} & Omit<React.ComponentProps<typeof Input>, 'value' | 'onChange' | 'min' | 'max' | 'step'>) {
  const [draft, setDraft] = useState(String(value))
  useEffect(() => setDraft(String(value)), [value])
  const commit = () => {
    const n = Number(draft)
    if (draft.trim() === '' || !Number.isFinite(n)) return setDraft(String(value))
    const clamped = Math.min(max, Math.max(min, step ? n : Math.round(n)))
    setDraft(String(clamped))
    if (clamped !== value) onCommit(clamped)
  }
  return (
    <Input
      id={id}
      type="number"
      min={min}
      max={max}
      step={step}
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
      className={cn('w-28 text-right tabular-nums', className)}
      {...rest}
    />
  )
}

// The confirmation every delete goes through: says what goes, with counts in `children`.
export function ConfirmDialog({
  open,
  title,
  confirmLabel,
  destructive = true,
  busy,
  error,
  onConfirm,
  onClose,
  children,
}: {
  open: boolean
  title: string
  confirmLabel: string
  destructive?: boolean
  busy?: boolean
  error?: string | null
  onConfirm: () => void
  onClose: () => void
  children: ReactNode
}) {
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription asChild>
            <div className="space-y-2">{children}</div>
          </DialogDescription>
        </DialogHeader>
        {error && (
          <p role="alert" className="text-destructive text-sm">
            {error}
          </p>
        )}
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant={destructive ? 'destructive' : 'default'} onClick={onConfirm} disabled={busy}>
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export function KeyRecorder({ value, label, onChange }: { value: string; label?: string; onChange: (accel: string) => void }) {
  const [recording, setRecording] = useState(false)
  useEffect(() => {
    if (!recording) return
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault()
      e.stopPropagation()
      if (e.key === 'Escape') return setRecording(false)
      if (e.key === 'Backspace' || e.key === 'Delete') {
        onChange('')
        return setRecording(false)
      }
      const accel = eventToAccel(e)
      if (!accel) return
      onChange(accel)
      setRecording(false)
    }
    // Capture phase, so the app's own shortcuts don't fire while recording.
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [recording, onChange])

  return (
    <Button
      variant="outline"
      size="sm"
      className={cn('min-w-36 justify-center font-mono text-xs', recording && 'border-primary text-primary')}
      onClick={() => setRecording((r) => !r)}
      onBlur={() => setRecording(false)}
    >
      {label && <span className="sr-only">{label}: </span>}
      {recording ? 'Press keys…' : formatAccel(value)}
    </Button>
  )
}
