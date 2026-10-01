import { useState, type ReactNode } from 'react'
import { decodeIpcError } from '@shared/ipc'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useCreateJob, useSendMessage, useUpdateCrew, useUpdateSquad } from '@/lib/queries'

const textareaClass =
  'border-input bg-background placeholder:text-muted-foreground focus-visible:ring-ring/50 min-h-24 w-full rounded-md border px-3 py-2 text-sm outline-none focus-visible:ring-[3px]'

// A dialog that runs one async action and shows a typed IPC error inline instead of closing.
function ActionDialog({
  title,
  description,
  submitLabel,
  destructive,
  canSubmit = true,
  run,
  onClose,
  children,
}: {
  title: string
  description?: ReactNode
  submitLabel: string
  destructive?: boolean
  canSubmit?: boolean
  run: () => Promise<unknown>
  onClose: () => void
  children?: ReactNode
}) {
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const submit = async () => {
    setPending(true)
    setError(null)
    try {
      await run()
      onClose()
    } catch (e) {
      setError(decodeIpcError(e).message)
      setPending(false)
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && !pending && onClose()}>
      <DialogContent className="sm:max-w-md">
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault()
            if (canSubmit && !pending) void submit()
          }}
        >
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            {description && <DialogDescription>{description}</DialogDescription>}
          </DialogHeader>
          {children}
          {error && (
            <p role="alert" className="text-destructive text-sm">
              {error}
            </p>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose} disabled={pending}>
              Cancel
            </Button>
            <Button type="submit" variant={destructive ? 'destructive' : 'default'} disabled={!canSubmit || pending}>
              {submitLabel}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

export function ConfirmDialog(props: {
  title: string
  description: ReactNode
  confirmLabel: string
  run: () => Promise<unknown>
  onClose: () => void
}) {
  return (
    <ActionDialog
      title={props.title}
      description={props.description}
      submitLabel={props.confirmLabel}
      destructive
      run={props.run}
      onClose={props.onClose}
    />
  )
}

export function RenameDialog({
  kind,
  id,
  name,
  onClose,
}: {
  kind: 'crew' | 'squad'
  id: number
  name: string
  onClose: () => void
}) {
  const [value, setValue] = useState(name)
  const updateCrew = useUpdateCrew()
  const updateSquad = useUpdateSquad()
  return (
    <ActionDialog
      title={kind === 'crew' ? 'Rename crew' : 'Rename squad'}
      submitLabel="Save"
      canSubmit={!!value.trim() && value.trim() !== name}
      run={() =>
        kind === 'crew' ? updateCrew.mutateAsync([id, { name: value.trim() }]) : updateSquad.mutateAsync([id, { name: value.trim() }])
      }
      onClose={onClose}
    >
      <div className="space-y-2">
        <Label htmlFor="graph-rename">Name</Label>
        <Input id="graph-rename" value={value} onChange={(e) => setValue(e.target.value)} maxLength={80} autoFocus />
      </div>
    </ActionDialog>
  )
}

// `to` is an operator id or 'master'.
export function MessageDialog({ crewId, to, label, onClose }: { crewId: number; to: number | 'master'; label: string; onClose: () => void }) {
  const [body, setBody] = useState('')
  const send = useSendMessage()
  return (
    <ActionDialog
      title={`Message ${label}`}
      description="Sent as a message from you."
      submitLabel="Send"
      canSubmit={!!body.trim()}
      run={() => send.mutateAsync([{ crewId, to, body: body.trim() }])}
      onClose={onClose}
    >
      <div className="space-y-2">
        <Label htmlFor="graph-message">Message</Label>
        <textarea id="graph-message" className={textareaClass} value={body} onChange={(e) => setBody(e.target.value)} autoFocus />
      </div>
    </ActionDialog>
  )
}

export function NewJobDialog({ crewId, operatorId, label, onClose }: { crewId: number; operatorId: number; label: string; onClose: () => void }) {
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const create = useCreateJob()
  return (
    <ActionDialog
      title={`New job for ${label}`}
      submitLabel="Create job"
      canSubmit={!!title.trim()}
      run={() => create.mutateAsync([{ crewId, title: title.trim(), body: body.trim() || undefined, for: operatorId }])}
      onClose={onClose}
    >
      <div className="space-y-2">
        <Label htmlFor="graph-job-title">Title</Label>
        <Input id="graph-job-title" value={title} onChange={(e) => setTitle(e.target.value)} autoFocus />
      </div>
      <div className="space-y-2">
        <Label htmlFor="graph-job-body">Details</Label>
        <textarea id="graph-job-body" className={textareaClass} value={body} onChange={(e) => setBody(e.target.value)} />
      </div>
    </ActionDialog>
  )
}
