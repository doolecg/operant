import { useEffect, useState, type FormEvent, type ReactNode } from 'react'
import { FolderOpen } from 'lucide-react'
import type { AgentKind, Squad } from '@shared/types'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { agentLabel, defaultModel } from '@/lib/format'
import { pickFolder, useAction } from '@/lib/queries'

interface ShellProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  description: string
  submitLabel: string
  canSubmit: boolean
  pending: boolean
  error?: unknown
  onSubmit: () => void
  children: ReactNode
}

function FormDialog({ open, onOpenChange, title, description, submitLabel, canSubmit, pending, error, onSubmit, children }: ShellProps) {
  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (canSubmit && !pending) onSubmit()
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <form onSubmit={submit} className="space-y-5">
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            <DialogDescription>{description}</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">{children}</div>
          {error != null && <p className="text-destructive text-xs">{errorText(error)}</p>}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={!canSubmit || pending}>
              {submitLabel}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

const errorText = (e: unknown) => {
  const msg = e instanceof Error ? e.message : String(e)
  if (/UNIQUE/i.test(msg)) return 'That name is already taken.'
  return msg.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
}

function Field({ id, label, children }: { id: string; label: string; children: ReactNode }) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      {children}
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
      title="New crew"
      description="A crew is a team of agent operators working in one project folder."
      submitLabel="Create crew"
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

export function AddSquadDialog({ crewId, open, onOpenChange }: { crewId: number; open: boolean; onOpenChange: (o: boolean) => void }) {
  const [name, setName] = useState('')
  const create = useAction('squads:create')
  useEffect(() => {
    if (open) {
      setName('')
      create.reset()
    }
  }, [open])

  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Add squad"
      description="A squad groups operators that work together."
      submitLabel="Add squad"
      canSubmit={!!name.trim()}
      pending={create.isPending}
      error={create.error}
      onSubmit={() => create.mutate([{ crewId, name }], { onSuccess: () => onOpenChange(false) })}
    >
      <Field id="squad-name" label="Name">
        <Input id="squad-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="dev" autoFocus />
      </Field>
    </FormDialog>
  )
}

export function AddOperatorDialog({
  squads,
  squadId,
  defaultModels,
  onOpenChange,
}: {
  squads: Squad[]
  squadId: number | null
  defaultModels?: { claude: string; codex: string }
  onOpenChange: (o: boolean) => void
}) {
  const modelFor = (a: AgentKind) => (a === 'shell' ? defaultModel.shell : (defaultModels?.[a] ?? defaultModel[a]))
  const open = squadId != null
  const [squad, setSquad] = useState('')
  const [role, setRole] = useState('')
  const [agent, setAgent] = useState<AgentKind>('claude')
  const [model, setModel] = useState(defaultModel.claude)
  const create = useAction('operators:create')

  useEffect(() => {
    if (open) {
      setSquad(String(squadId))
      setRole('')
      setAgent('claude')
      setModel(modelFor('claude'))
      create.reset()
    }
  }, [open, squadId])

  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Add operator"
      description="An operator is one agent session with a stable role address."
      submitLabel="Add operator"
      canSubmit={!!role.trim() && !!squad && (agent === 'shell' || !!model.trim())}
      pending={create.isPending}
      error={create.error}
      onSubmit={() =>
        create.mutate([{ squadId: Number(squad), role, agent, model: agent === 'shell' ? '-' : model }], {
          onSuccess: () => onOpenChange(false),
        })
      }
    >
      <Field id="operator-role" label="Role">
        <Input id="operator-role" value={role} onChange={(e) => setRole(e.target.value)} placeholder="lead" autoFocus />
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field id="operator-squad" label="Squad">
          <Select value={squad} onValueChange={setSquad}>
            <SelectTrigger id="operator-squad" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {squads.map((p) => (
                <SelectItem key={p.id} value={String(p.id)}>
                  {p.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        <Field id="operator-agent" label="Agent">
          <Select
            value={agent}
            onValueChange={(v) => {
              setAgent(v as AgentKind)
              setModel(modelFor(v as AgentKind))
            }}
          >
            <SelectTrigger id="operator-agent" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {(Object.keys(agentLabel) as AgentKind[]).map((a) => (
                <SelectItem key={a} value={a}>
                  {agentLabel[a]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
      </div>
      {agent !== 'shell' && (
        <Field id="operator-model" label="Model">
          <Input id="operator-model" value={model} onChange={(e) => setModel(e.target.value)} className="font-mono" />
        </Field>
      )}
    </FormDialog>
  )
}
