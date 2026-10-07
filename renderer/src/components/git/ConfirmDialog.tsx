import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'

export interface Confirm {
  title: string
  detail: string
  action: string
  danger?: boolean
  run: () => void
}

export function ConfirmDialog({ confirm, onClose }: { confirm: Confirm | null; onClose: () => void }) {
  return (
    <Dialog open={confirm != null} onOpenChange={(o) => !o && onClose()}>
      <DialogContent size="sm" data-testid="git-confirm">
        <DialogHeader>
          <DialogTitle>{confirm?.title}</DialogTitle>
          <DialogDescription className="whitespace-pre-line">{confirm?.detail}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant={confirm?.danger ? 'destructive' : 'default'}
            onClick={() => {
              confirm?.run()
              onClose()
            }}
          >
            {confirm?.action}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
