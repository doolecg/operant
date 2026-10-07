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
import { Switch } from '@/components/ui/switch'
import { usd } from '@/lib/format'
import { pickFolder, useAction, useCrewCounts, useDeleteCrew, useRuns, useUpdateCrew } from '@/lib/queries'

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

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

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
      description="A project is one folder you give jobs to."
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
  const [tracker, setTracker] = useState(crew.trackerFile)
  const [trackerJobs, setTrackerJobs] = useState(crew.trackerJobs)
  const update = useUpdateCrew()

  useEffect(() => {
    if (open) {
      setName(crew.name)
      setFolder(crew.folder)
      setTracker(crew.trackerFile)
      setTrackerJobs(crew.trackerJobs)
      update.reset()
    }
  }, [open])

  const changed = name.trim() !== crew.name || folder.trim() !== crew.folder || tracker.trim() !== crew.trackerFile || trackerJobs !== crew.trackerJobs

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
              ...(tracker.trim() !== crew.trackerFile && { trackerFile: tracker }),
              ...(trackerJobs !== crew.trackerJobs && { trackerJobs }),
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
      <Field
        id="edit-crew-tracker"
        label="Tracker file"
        hint="Optional, relative to the project folder (for example docs/specs/tracker.html). Leave empty for none."
      >
        <Input id="edit-crew-tracker" value={tracker} onChange={(e) => setTracker(e.target.value)} placeholder="docs/specs/tracker.html" className="font-mono text-xs" />
      </Field>
      <div className="flex items-center justify-between gap-4">
        <Label htmlFor="edit-crew-tracker-jobs" className="text-sm font-normal">
          Open an “Update tracker” job when a job finishes
        </Label>
        <Switch id="edit-crew-tracker-jobs" checked={trackerJobs} onCheckedChange={setTrackerJobs} />
      </div>
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
  const counts = useCrewCounts(crewId, open)
  const remove = useDeleteCrew()
  const runCount = useRuns(open ? crewId : null).data?.length
  const c = counts.data
  useEffect(() => {
    if (open) remove.reset()
  }, [open])

  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title={`Delete project ${crewName}`}
      description="This cannot be undone."
      submitLabel="Delete project"
      destructive
      canSubmit={!!c && runCount != null}
      pending={remove.isPending}
      error={remove.error ?? counts.error}
      onSubmit={() =>
        remove.mutate([crewId], {
          onSuccess: () => {
            onOpenChange(false)
            onDeleted?.()
          },
        })
      }
    >
      {c ? (
        <div className="space-y-2 text-sm">
          <p>
            Deleting the project removes {plural(runCount ?? 0, 'run')}, {plural(c.jobs, 'job')} ({c.openJobs} open),{' '}
            {plural(c.messages, 'message')} and {plural(c.scratch, 'terminal tile')}.
          </p>
          {c.running > 0 && <p>{plural(c.running, 'running session')} will be stopped.</p>}
          <p>
            Its lessons ({c.lessons}) are deleted too. Anything already saved outside Operant (Hindsight, CodeGraph notes, memory files) stays.
          </p>
          <p className="text-destructive">
            Its spend history ({usd(c.spendUsd)} in total) is deleted with it and no longer counts in the Cost tab or the daily budget.
          </p>
          <p className="text-muted-foreground">
            The project folder and every file in it are not touched. If the project is in a group, the group stays.
          </p>
        </div>
      ) : (
        <p className="text-muted-foreground text-sm">Counting what would be removed…</p>
      )}
    </FormDialog>
  )
}
