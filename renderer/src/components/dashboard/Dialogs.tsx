import { useEffect, useState, type FormEvent, type ReactNode } from 'react'
import { FolderOpen } from 'lucide-react'
import { decodeIpcError } from '@shared/ipc'
import type { Crew } from '@shared/types'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { pickFolder, useAction, useDeleteCrew, useUpdateCrew } from '@/lib/queries'

interface ShellProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  description: ReactNode
  submitLabel: string
  canSubmit: boolean
  pending: boolean
  error?: unknown
  onSubmit: () => void
  destructive?: boolean
  wide?: boolean
  children?: ReactNode
}

// Every dialog shows typed IPC errors inline.
export const errorText = (e: unknown) => decodeIpcError(e).message

export function FormDialog({
  open,
  onOpenChange,
  title,
  description,
  submitLabel,
  canSubmit,
  pending,
  error,
  onSubmit,
  destructive,
  wide,
  children,
}: ShellProps) {
  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (canSubmit && !pending) onSubmit()
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size={wide ? 'lg' : 'md'}>
        <form onSubmit={submit}>
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            <DialogDescription asChild={typeof description !== 'string'}>
              {typeof description === 'string' ? description : <div>{description}</div>}
            </DialogDescription>
          </DialogHeader>
          <DialogBody>
            {children != null && <div className="space-y-4">{children}</div>}
          {error != null && <p className="text-destructive text-xs">{errorText(error)}</p>}
          </DialogBody>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
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

export function Field({ id, label, hint, children }: { id: string; label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      {children}
      {hint && <p className="text-muted-foreground text-xs">{hint}</p>}
    </div>
  )
}

export function NewCrewDialog({ open, onOpenChange, onCreated }: { open: boolean; onOpenChange: (o: boolean) => void; onCreated: (id: number) => void }) {
  const [name, setName] = useState('')
  const [folder, setFolder] = useState('')
  const create = useAction('crews:create')

  useEffect(() => {
    if (open) {
      setName('')
      setFolder('')
      create.reset()
    }
  }, [open])

  const browse = async () => {
    const picked = await pickFolder()
    if (!picked) return
    setFolder(picked)
    if (!name) setName(picked.split(/[\\/]/).filter(Boolean).pop() ?? '')
  }

  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title="New project"
      description="A project is one folder you open terminals in."
      submitLabel="Create project"
      canSubmit={!!name.trim() && !!folder}
      pending={create.isPending}
      error={create.error}
      onSubmit={() =>
        create.mutate([{ name, folder }], {
          onSuccess: (crew) => {
            onOpenChange(false)
            onCreated(crew.id)
          },
        })
      }
    >
      <Field id="crew-folder" label="Project folder">
        <div className="flex gap-2">
          <Input id="crew-folder" value={folder} readOnly placeholder="Choose a folder…" className="font-mono text-xs" />
          <Button type="button" variant="outline" onClick={browse}>
            <FolderOpen /> Browse
          </Button>
        </div>
      </Field>
      <Field id="crew-name" label="Name">
        <Input id="crew-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="shop" />
      </Field>
    </FormDialog>
  )
}

export function EditCrewDialog({
  crew,
  open,
  onOpenChange,
}: {
  crew: Crew
  open: boolean
  onOpenChange: (o: boolean) => void
}) {
  const [name, setName] = useState(crew.name)
  const [folder, setFolder] = useState(crew.folder)
  const update = useUpdateCrew()

  useEffect(() => {
    if (open) {
      setName(crew.name)
      setFolder(crew.folder)
      update.reset()
    }
  }, [open])

  const changed = name.trim() !== crew.name || folder.trim() !== crew.folder

  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Edit project"
      description="The folder cannot change while the project has a running session."
      submitLabel="Save"
      canSubmit={!!name.trim() && !!folder.trim() && changed}
      pending={update.isPending}
      error={update.error}
      onSubmit={() =>
        update.mutate(
          [
            crew.id,
            {
              ...(name.trim() !== crew.name && { name }),
              ...(folder.trim() !== crew.folder && { folder }),
            },
          ],
          { onSuccess: () => onOpenChange(false) },
        )
      }
    >
      <Field id="edit-crew-name" label="Name">
        <Input id="edit-crew-name" value={name} onChange={(e) => setName(e.target.value)} />
      </Field>
      <Field id="edit-crew-folder" label="Project folder">
        <div className="flex gap-2">
          <Input id="edit-crew-folder" value={folder} readOnly className="font-mono text-xs" />
          <Button
            type="button"
            variant="outline"
            onClick={async () => {
              const picked = await pickFolder()
              if (picked) setFolder(picked)
            }}
          >
            <FolderOpen /> Browse
          </Button>
        </div>
      </Field>
    </FormDialog>
  )
}

export function DeleteCrewDialog({
  crewId,
  crewName,
  open,
  onOpenChange,
  onDeleted,
}: {
  crewId: number
  crewName: string
  open: boolean
  onOpenChange: (o: boolean) => void
  onDeleted?: () => void
}) {
  const del = useDeleteCrew()
  useEffect(() => {
    if (open) del.reset()
  }, [open])

  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title={`Delete project ${crewName}`}
      description="This cannot be undone."
      submitLabel="Delete project"
      destructive
      canSubmit
      pending={del.isPending}
      error={del.error}
      onSubmit={() =>
        del.mutate([crewId], {
          onSuccess: () => {
            onOpenChange(false)
            onDeleted?.()
          },
        })
      }
    >
      <div className="space-y-2 text-sm">
        <p>Deleting the project stops its running sessions and removes its terminal tiles, lessons and spend history.</p>
        <p className="text-muted-foreground">
          Anything already saved outside Operant (Hindsight, CodeGraph notes, memory files) stays. The project folder and every file in it are not touched. If the project is in a group, the group stays.
        </p>
      </div>
    </FormDialog>
  )
}
