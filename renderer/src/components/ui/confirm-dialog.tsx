import { useRef, useState, type ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'

interface Props {
  open: boolean
  title: string
  // Plain text, or a list of lines (one paragraph each).
  description: ReactNode
  confirmLabel: string
  // Shows a "Don't ask again" checkbox; onConfirm gets its state.
  dontAskLabel?: string
  danger?: boolean
  testId?: string
  onConfirm: (dontAsk: boolean) => void
  onCancel: () => void
}

// The app's own confirmation: Cancel has the focus, Enter confirms, Esc cancels.
export function ConfirmDialog({ open, title, description, confirmLabel, dontAskLabel, danger, testId, onConfirm, onCancel }: Props) {
  const [dontAsk, setDontAsk] = useState(false)
  const cancelRef = useRef<HTMLButtonElement>(null)
  const confirm = () => {
    onConfirm(dontAsk)
    setDontAsk(false)
  }
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onCancel()}>
      <DialogContent
        size="sm"
        data-testid={testId}
        onOpenAutoFocus={(e) => {
          e.preventDefault()
          cancelRef.current?.focus()
        }}
        onKeyDown={(e) => {
          if (e.key !== 'Enter' || e.nativeEvent.isComposing) return
          e.preventDefault()
          confirm()
        }}
      >
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription asChild>
            <div className="space-y-1.5 whitespace-pre-line">{description}</div>
          </DialogDescription>
        </DialogHeader>
        {dontAskLabel && (
          <label className="text-muted-foreground flex items-center gap-2 px-6 text-sm">
            <input type="checkbox" className="accent-primary size-4" checked={dontAsk} onChange={(e) => setDontAsk(e.target.checked)} />
            {dontAskLabel}
          </label>
        )}
        <DialogFooter>
          <Button ref={cancelRef} variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
          <Button variant={danger ? 'destructive' : 'default'} onClick={confirm}>
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
