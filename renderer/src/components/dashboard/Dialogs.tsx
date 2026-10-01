import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react'
import { FolderOpen } from 'lucide-react'
import { decodeIpcError } from '@shared/ipc'
import type { CacheTtl, CrewTopology, McpMode, Operator, OperatorPatch, Preset, Squad } from '@shared/types'
import { effortFromValue, effortValue, EFFORTS, DEFAULT_EFFORT, hasEffort, hasModel, modelOptions } from '@/components/operators/models'
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
import { Switch } from '@/components/ui/switch'
import { usd } from '@/lib/format'
import {
  pickFolder,
  useAction,
  useApplyOperatorChange,
  useChangePlan,
  useCreateOperatorFromPreset,
  useCrewCounts,
  useDeleteCrew,
  useDeleteOperator,
  useDeleteSquad,
  useJobs,
  usePresets,
  useUnread,
  useUpdateCrew,
  useUpdateSquad,
} from '@/lib/queries'

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
      <DialogContent className={wide ? 'max-h-[90vh] overflow-y-auto sm:max-w-xl' : 'sm:max-w-md'}>
        <form onSubmit={submit} className="space-y-5">
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            <DialogDescription asChild={typeof description !== 'string'}>
              {typeof description === 'string' ? description : <div>{description}</div>}
            </DialogDescription>
          </DialogHeader>
          {children != null && <div className="space-y-4">{children}</div>}
          {error != null && <p className="text-destructive text-xs">{errorText(error)}</p>}
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

export function EditCrewDialog({
  crew,
  open,
  onOpenChange,
}: {
  crew: CrewTopology
  open: boolean
  onOpenChange: (o: boolean) => void
}) {
  const [name, setName] = useState(crew.name)
  const [folder, setFolder] = useState(crew.folder)
  const [pm, setPm] = useState(crew.pmId == null ? 'none' : String(crew.pmId))
  const update = useUpdateCrew()
  const operators = crew.squads.flatMap((s) => s.operators)

  useEffect(() => {
    if (open) {
      setName(crew.name)
      setFolder(crew.folder)
      setPm(crew.pmId == null ? 'none' : String(crew.pmId))
      update.reset()
    }
  }, [open])

  const pmId = pm === 'none' ? null : Number(pm)
  const changed = name.trim() !== crew.name || folder.trim() !== crew.folder || pmId !== crew.pmId

  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Edit crew"
      description="The folder cannot change while any operator or tile of the crew is running."
      submitLabel="Save"
      canSubmit={!!name.trim() && !!folder.trim() && changed}
      pending={update.isPending}
      error={update.error}
      onSubmit={() =>
        update.mutate(
          [crew.id, { ...(name.trim() !== crew.name && { name }), ...(folder.trim() !== crew.folder && { folder }), ...(pmId !== crew.pmId && { pmId }) }],
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
      <Field id="edit-crew-pm" label="Project manager" hint="The operator that reviews finished jobs by default.">
        <Select value={pm} onValueChange={setPm}>
          <SelectTrigger id="edit-crew-pm" className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="none">None</SelectItem>
            {operators.map((o) => (
              <SelectItem key={o.id} value={String(o.id)}>
                {o.role}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
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
  const counts = useCrewCounts(crewId, open)
  const remove = useDeleteCrew()
  const c = counts.data
  useEffect(() => {
    if (open) remove.reset()
  }, [open])

  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title={`Delete crew ${crewName}`}
      description="This cannot be undone."
      submitLabel="Delete crew"
      destructive
      canSubmit={!!c}
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
            Deleting the crew removes {plural(c.squads, 'squad')}, {plural(c.operators, 'operator')}, {plural(c.jobs, 'job')} (
            {c.openJobs} open), {plural(c.messages, 'message')} and {plural(c.scratch, 'terminal tile')}.
          </p>
          {c.running > 0 && <p>{plural(c.running, 'running session')} will be stopped.</p>}
          <p className="text-destructive">
            Its spend history ({usd(c.spendUsd)} in total) is deleted with it and no longer counts in the Cost tab or the daily budget.
          </p>
          <p className="text-muted-foreground">The project folder itself is not touched.</p>
        </div>
      ) : (
        <p className="text-muted-foreground text-sm">Counting what would be removed…</p>
      )}
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

export function EditSquadDialog({ squad, open, onOpenChange }: { squad: Squad; open: boolean; onOpenChange: (o: boolean) => void }) {
  const [name, setName] = useState(squad.name)
  const update = useUpdateSquad()
  useEffect(() => {
    if (open) {
      setName(squad.name)
      update.reset()
    }
  }, [open])

  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Rename squad"
      description="The squad name is part of how operators address each other."
      submitLabel="Save"
      canSubmit={!!name.trim() && name.trim() !== squad.name}
      pending={update.isPending}
      error={update.error}
      onSubmit={() => update.mutate([squad.id, { name }], { onSuccess: () => onOpenChange(false) })}
    >
      <Field id="edit-squad-name" label="Name">
        <Input id="edit-squad-name" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
      </Field>
    </FormDialog>
  )
}

export function DeleteSquadDialog({
  squad,
  operators,
  open,
  onOpenChange,
}: {
  squad: Squad
  operators: Operator[]
  open: boolean
  onOpenChange: (o: boolean) => void
}) {
  const remove = useDeleteSquad()
  const running = operators.filter((o) => o.status !== 'stopped').length
  useEffect(() => {
    if (open) remove.reset()
  }, [open])

  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title={`Delete squad ${squad.name}`}
      description="Its operators are deleted with it."
      submitLabel="Delete squad"
      destructive
      canSubmit
      pending={remove.isPending}
      error={remove.error}
      onSubmit={() => remove.mutate([squad.id], { onSuccess: () => onOpenChange(false) })}
    >
      <div className="space-y-2 text-sm">
        <p>
          {operators.length === 0
            ? 'This squad has no operators.'
            : `Deleting the squad deletes ${plural(operators.length, 'operator')}: ${operators.map((o) => o.role).join(', ')}.`}
        </p>
        {running > 0 && <p>{plural(running, 'running session')} will be stopped, and their jobs released.</p>}
        <p className="text-muted-foreground">Their spend history is kept until it is purged (Settings, Collaboration).</p>
      </div>
    </FormDialog>
  )
}

const presetDefault = (presets: Preset[]) => presets.find((p) => p.builtin === 'implementor') ?? presets[0]

export function AddOperatorDialog({
  squads,
  squadId,
  onOpenChange,
}: {
  squads: Squad[]
  squadId: number | null
  defaultModels?: { claude: string; codex: string }
  onOpenChange: (o: boolean) => void
}) {
  const open = squadId != null
  const presets = usePresets()
  const [squad, setSquad] = useState('')
  const [role, setRole] = useState('')
  const [presetId, setPresetId] = useState('')
  const [model, setModel] = useState('')
  const create = useCreateOperatorFromPreset()
  const list = presets.data ?? []
  const preset = list.find((p) => String(p.id) === presetId)

  useEffect(() => {
    if (open) {
      setSquad(String(squadId))
      setRole('')
      setModel('')
      create.reset()
    }
  }, [open, squadId])

  useEffect(() => {
    if (open && !preset && list.length > 0) setPresetId(String(presetDefault(list)!.id))
  }, [open, list.length, preset])

  const roleHint = preset?.builtin ? { pm: 'pm', senior: 'senior' }[preset.builtin] ?? preset.builtin : 'lead'

  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Add operator"
      description="An operator is one agent session with a stable role address. Start small: a project manager, an implementor and a reviewer."
      submitLabel="Add operator"
      canSubmit={!!role.trim() && !!squad && !!preset}
      pending={create.isPending}
      error={create.error}
      onSubmit={() =>
        create.mutate([{ squadId: Number(squad), role, presetId: preset!.id, ...(model.trim() && { model: model.trim() }) }], {
          onSuccess: () => onOpenChange(false),
        })
      }
    >
      <Field id="operator-preset" label="Preset" hint={preset ? `${preset.agent === 'shell' ? 'Shell' : preset.model}${preset.effort ? `, effort ${preset.effort}` : ''}, mode ${preset.permissionMode || 'none'}` : undefined}>
        <Select value={presetId} onValueChange={setPresetId}>
          <SelectTrigger id="operator-preset" className="w-full">
            <SelectValue placeholder="Choose a preset" />
          </SelectTrigger>
          <SelectContent>
            {list.map((p) => (
              <SelectItem key={p.id} value={String(p.id)}>
                {p.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field id="operator-role" label="Role">
          <Input id="operator-role" value={role} onChange={(e) => setRole(e.target.value)} placeholder={roleHint} autoFocus />
        </Field>
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
      </div>
      {preset && preset.agent !== 'shell' && (
        <Field id="operator-model" label="Model" hint="Leave empty to use the preset's model.">
          <Input id="operator-model" value={model} onChange={(e) => setModel(e.target.value)} placeholder={preset.model} className="font-mono" />
        </Field>
      )}
    </FormDialog>
  )
}

const MODES = ['acceptEdits', 'bypassPermissions', 'manual', 'dontAsk', 'plan']
const lines = (v: string) => v.split('\n').map((l) => l.trim()).filter(Boolean)
const sameList = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i])

const textareaClass =
  'border-input bg-transparent dark:bg-input/30 placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-ring/50 w-full rounded-md border px-3 py-2 font-mono text-xs shadow-xs outline-none focus-visible:ring-[3px]'

export function EditOperatorDialog({
  operator,
  squads,
  open,
  onOpenChange,
}: {
  operator: Operator
  squads: Squad[]
  open: boolean
  onOpenChange: (o: boolean) => void
}) {
  const presets = usePresets()
  const apply = useApplyOperatorChange()
  const preset = presets.data?.find((p) => p.id === operator.presetId)
  const [f, setF] = useState(() => formOf(operator))
  const set = <K extends keyof ReturnType<typeof formOf>>(key: K, value: ReturnType<typeof formOf>[K]) => setF((s) => ({ ...s, [key]: value }))

  useEffect(() => {
    if (open) {
      setF(formOf(operator))
      apply.reset()
    }
  }, [open])

  const { patch, invalid } = useMemo(() => patchOf(operator, f), [operator, f])
  const changed = Object.keys(patch).length > 0
  const plan = useChangePlan(open && changed && !invalid ? operator.id : null, changed && !invalid ? patch : null)
  const p = plan.data
  const running = operator.status !== 'stopped'
  const claude = operator.agent === 'claude'

  return (
    <FormDialog
      wide
      open={open}
      onOpenChange={onOpenChange}
      title={`Edit ${operator.role}`}
      description={preset ? `Copied from the ${preset.name} preset; changing a launch setting marks the operator as modified.` : 'Custom operator (no preset).'}
      submitLabel={p?.requiresRestart ? 'Restart fresh and save' : 'Save'}
      canSubmit={changed && !invalid && !!p}
      pending={apply.isPending}
      error={apply.error ?? (changed ? plan.error : undefined)}
      onSubmit={() => apply.mutate([operator.id, patch], { onSuccess: () => onOpenChange(false) })}
    >
      <div className="grid grid-cols-2 gap-3">
        <Field id="edit-operator-role" label="Role">
          <Input id="edit-operator-role" value={f.role} onChange={(e) => set('role', e.target.value)} />
        </Field>
        <Field id="edit-operator-squad" label="Squad">
          <Select value={f.squadId} onValueChange={(v) => set('squadId', v)}>
            <SelectTrigger id="edit-operator-squad" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {squads.map((s) => (
                <SelectItem key={s.id} value={String(s.id)}>
                  {s.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
      </div>
      <Field id="edit-operator-cap" label="Daily cap (USD)" hint="Empty uses the default from Settings.">
        <Input id="edit-operator-cap" inputMode="decimal" value={f.cap} onChange={(e) => set('cap', e.target.value)} placeholder="default" />
      </Field>

      {hasModel(operator) && (
        <div className="grid grid-cols-2 gap-3">
          <Field id="edit-operator-model" label="Model">
            <Select value={f.model} onValueChange={(v) => set('model', v)}>
              <SelectTrigger id="edit-operator-model" className="w-full font-mono text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {modelOptions(operator.agent, operator.model, presets.data).map((m) => (
                  <SelectItem key={m} value={m} className="font-mono text-xs">
                    {m}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          {hasEffort({ agent: operator.agent, model: f.model }) && (
            <Field id="edit-operator-effort" label="Effort">
              <Select value={effortValue(f.effort)} onValueChange={(v) => set('effort', effortFromValue(v))}>
                <SelectTrigger id="edit-operator-effort" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={DEFAULT_EFFORT}>default</SelectItem>
                  {EFFORTS.map((e) => (
                    <SelectItem key={e} value={e}>
                      {e}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
          )}
        </div>
      )}

      {claude && (
        <>
          <div className="grid grid-cols-2 gap-3">
            <Field id="edit-operator-mode" label="Permission mode">
              <Select value={f.permissionMode} onValueChange={(v) => set('permissionMode', v)}>
                <SelectTrigger id="edit-operator-mode" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {[...new Set([...MODES, f.permissionMode].filter(Boolean))].map((m) => (
                    <SelectItem key={m} value={m}>
                      {m}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <Field id="edit-operator-ttl" label="Cache TTL">
              <Select value={f.cacheTtl} onValueChange={(v) => set('cacheTtl', v as CacheTtl)}>
                <SelectTrigger id="edit-operator-ttl" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="auto">auto</SelectItem>
                  <SelectItem value="5m">5m</SelectItem>
                  <SelectItem value="1h">1h</SelectItem>
                </SelectContent>
              </Select>
            </Field>
          </div>
          <Field id="edit-operator-tools" label="Tools" hint="Comma-separated, empty for the default set.">
            <Input id="edit-operator-tools" value={f.tools} onChange={(e) => set('tools', e.target.value)} className="font-mono text-xs" />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field id="edit-operator-allow" label="Allow rules" hint="One per line.">
              <textarea id="edit-operator-allow" rows={4} value={f.allow} onChange={(e) => set('allow', e.target.value)} className={textareaClass} />
            </Field>
            <Field id="edit-operator-deny" label="Deny rules" hint="One per line.">
              <textarea id="edit-operator-deny" rows={4} value={f.deny} onChange={(e) => set('deny', e.target.value)} className={textareaClass} />
            </Field>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Field id="edit-operator-context" label="Context cap (tokens)" hint="0 uses the default.">
              <Input id="edit-operator-context" inputMode="numeric" value={f.contextCap} onChange={(e) => set('contextCap', e.target.value)} />
            </Field>
            <Field id="edit-operator-mcp" label="MCP">
              <Select value={f.mcp} onValueChange={(v) => set('mcp', v as McpMode)}>
                <SelectTrigger id="edit-operator-mcp" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="codegraph">CodeGraph</SelectItem>
                  <SelectItem value="none">None</SelectItem>
                </SelectContent>
              </Select>
            </Field>
          </div>
        </>
      )}
      <div className="flex items-center justify-between gap-3">
        <Label htmlFor="edit-operator-clear">Clear the conversation between jobs</Label>
        <Switch id="edit-operator-clear" checked={f.clearBetweenJobs} onCheckedChange={(v) => set('clearBetweenJobs', v)} />
      </div>
      {operator.agent !== 'shell' && (
        <Field
          id="edit-operator-role-text"
          label="Role text"
          hint={operator.roleText == null ? "Empty uses the preset's role text; text here is this operator's own." : "This operator's own role text; empty goes back to the preset's."}
        >
          <textarea id="edit-operator-role-text" rows={5} value={f.roleText} onChange={(e) => set('roleText', e.target.value)} className={textareaClass} />
        </Field>
      )}

      {changed && p && (
        <div className="text-muted-foreground space-y-1 text-xs">
          {p.requiresRestart ? (
            <p className="text-amber-400">
              This restarts the running operator as a fresh session: its conversation is lost
              {p.model === 'cache-lost' || p.restartFields.length > 0 ? ', and its prompt cache is dropped' : ''}
              {p.estimateColdCostUsd != null && <> (about {usd(p.estimateColdCostUsd)} to warm up again)</>}.
            </p>
          ) : (
            running === false && p.restartFields.length > 0 && <p>Applies on the next start: {p.restartFields.join(', ')}.</p>
          )}
          {p.liveFields.length > 0 && <p>Applies live: {p.liveFields.join(', ')}.</p>}
        </div>
      )}
      {invalid && <p className="text-destructive text-xs">{invalid}</p>}
    </FormDialog>
  )
}

function formOf(o: Operator) {
  return {
    role: o.role,
    squadId: String(o.squadId),
    cap: o.dailyCapUsd == null ? '' : String(o.dailyCapUsd),
    model: o.model,
    effort: o.effort,
    permissionMode: o.permissionMode,
    cacheTtl: o.cacheTtl,
    tools: o.tools,
    allow: o.allow.join('\n'),
    deny: o.deny.join('\n'),
    contextCap: String(o.contextCap),
    mcp: o.mcp,
    clearBetweenJobs: o.clearBetweenJobs,
    roleText: o.roleText ?? '',
  }
}

// The fields that differ from the operator, as the patch applyChange takes.
function patchOf(o: Operator, f: ReturnType<typeof formOf>): { patch: OperatorPatch; invalid: string } {
  const patch: OperatorPatch = {}
  let invalid = ''
  if (f.role.trim() !== o.role) patch.role = f.role.trim()
  if (!f.role.trim()) invalid = 'The role cannot be empty.'
  if (Number(f.squadId) !== o.squadId) patch.squadId = Number(f.squadId)
  const cap = f.cap.trim() === '' ? null : Number(f.cap)
  if (cap !== null && (!Number.isFinite(cap) || cap < 0)) invalid = 'The daily cap must be a number of USD, or empty.'
  else if (cap !== o.dailyCapUsd) patch.dailyCapUsd = cap
  if (hasModel(o)) {
    if (f.model !== o.model) patch.model = f.model
    if (hasEffort({ agent: o.agent, model: f.model }) && f.effort !== o.effort) patch.effort = f.effort
  }
  if (o.agent === 'claude') {
    if (f.permissionMode !== o.permissionMode) patch.permissionMode = f.permissionMode
    if (f.cacheTtl !== o.cacheTtl) patch.cacheTtl = f.cacheTtl
    if (f.tools.trim() !== o.tools) patch.tools = f.tools.trim()
    if (!sameList(lines(f.allow), o.allow)) patch.allow = lines(f.allow)
    if (!sameList(lines(f.deny), o.deny)) patch.deny = lines(f.deny)
    const ctx = Number(f.contextCap)
    if (!Number.isInteger(ctx) || ctx < 0) invalid = 'The context cap must be a whole number of tokens.'
    else if (ctx !== o.contextCap) patch.contextCap = ctx
    if (f.mcp !== o.mcp) patch.mcp = f.mcp
  }
  if (f.clearBetweenJobs !== o.clearBetweenJobs) patch.clearBetweenJobs = f.clearBetweenJobs
  if (o.agent !== 'shell') {
    const text = f.roleText.trim() === '' ? null : f.roleText
    if (text !== o.roleText) patch.roleText = text
  }
  return { patch, invalid }
}

export function DeleteOperatorDialog({
  operator,
  address,
  crewId,
  open,
  onOpenChange,
}: {
  operator: Operator
  address: string
  crewId: number
  open: boolean
  onOpenChange: (o: boolean) => void
}) {
  const jobs = useJobs(open ? crewId : null)
  const unread = useUnread(open ? crewId : null)
  const remove = useDeleteOperator()
  useEffect(() => {
    if (open) remove.reset()
  }, [open])

  const all = jobs.data ?? []
  const doing = all.filter((j) => j.assigneeId === operator.id && (j.state === 'doing' || j.state === 'todo')).length
  const reviews = all.filter((j) => j.reviewerId === operator.id && j.state === 'review').length
  const messages = unread.data?.operators[operator.id] ?? 0
  const running = operator.status !== 'stopped'

  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title={`Delete ${address}`}
      description="The operator is removed from the crew."
      submitLabel="Delete operator"
      destructive
      canSubmit
      pending={remove.isPending}
      error={remove.error}
      onSubmit={() => remove.mutate([operator.id], { onSuccess: () => onOpenChange(false) })}
    >
      <div className="space-y-2 text-sm">
        {running && (
          <p className="text-amber-400">This operator is running: its session is stopped now, mid-turn work included.</p>
        )}
        <ul className="list-disc space-y-1 pl-5">
          <li>{plural(doing, 'open job')} assigned to it will be released.</li>
          <li>{plural(reviews, 'review')} it holds move to the project manager, or to you.</li>
          <li>{plural(messages, 'unread message')} to it will be dropped, and its links removed.</li>
        </ul>
        <p className="text-muted-foreground">Its spend history is kept until it is purged (Settings, Collaboration).</p>
      </div>
    </FormDialog>
  )
}
