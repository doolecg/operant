import { useEffect, useState, type FormEvent } from 'react'
import { FolderOpen } from 'lucide-react'
import { decodeIpcError } from '@shared/ipc'
import type { AgentKind, ScratchTerminal } from '@shared/types'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { agentLabel, defaultModel } from '@/lib/format'
import { pickFolder, useCreateScratch, usePresets, useSettings, useUpdateScratch } from '@/lib/queries'

const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max']
const NONE = 'none'
const DEFAULT_EFFORT = 'default'

export interface ScratchDialogProps {
  crewId: number
  crewFolder: string
  // null = create; a terminal = edit it (changes apply the next time it opens).
  editing: ScratchTerminal | null
  open: boolean
  onOpenChange: (open: boolean) => void
  onCreated?: (scratch: ScratchTerminal) => void
}

export function ScratchDialog({ crewId, crewFolder, editing, open, onOpenChange, onCreated }: ScratchDialogProps) {
  const { data: settings } = useSettings()
  const { data: presets } = usePresets()
  const create = useCreateScratch()
  const update = useUpdateScratch()
  const [agent, setAgent] = useState<AgentKind>('shell')
  const [title, setTitle] = useState('')
  const [model, setModel] = useState('')
  const [effort, setEffort] = useState(DEFAULT_EFFORT)
  const [presetId, setPresetId] = useState(NONE)
  const [cwd, setCwd] = useState('')
  const [error, setError] = useState<string | null>(null)

  const modelFor = (a: AgentKind) => (a === 'shell' ? '' : (settings?.defaultModels?.[a] ?? defaultModel[a]))

  useEffect(() => {
    if (!open) return
    setError(null)
    if (editing) {
      setAgent(editing.agent)
      setTitle(editing.title)
      setModel(editing.model)
      setEffort(editing.effort || DEFAULT_EFFORT)
      setPresetId(editing.presetId != null ? String(editing.presetId) : NONE)
      setCwd(editing.cwd)
    } else {
      setAgent('shell')
      setTitle('')
      setModel('')
      setEffort(DEFAULT_EFFORT)
      setPresetId(NONE)
      setCwd(crewFolder)
    }
  }, [open, editing, crewFolder])

  const claudePresets = (presets ?? []).filter((p) => p.agent === 'claude')
  const pending = create.isPending || update.isPending
  const canSubmit = !!title.trim() && !!cwd.trim() && (agent === 'shell' || !!model.trim())

  const changeAgent = (a: AgentKind) => {
    setAgent(a)
    setModel(modelFor(a))
    setPresetId(NONE)
    setEffort(DEFAULT_EFFORT)
  }

  const choosePreset = (v: string) => {
    setPresetId(v)
    const p = claudePresets.find((x) => String(x.id) === v)
    if (p) {
      setModel(p.model)
      setEffort(p.effort || DEFAULT_EFFORT)
    }
  }

  const browse = async () => {
    const picked = await pickFolder()
    if (picked) setCwd(picked)
  }

  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (!canSubmit || pending) return
    const fields = {
      title: title.trim(),
      agent,
      model: agent === 'shell' ? '' : model.trim(),
      effort: agent === 'claude' && effort !== DEFAULT_EFFORT ? effort : '',
      presetId: agent === 'claude' && presetId !== NONE ? Number(presetId) : null,
      cwd: cwd.trim(),
    }
    const opts = {
      onSuccess: (s: ScratchTerminal) => {
        onOpenChange(false)
        if (!editing) onCreated?.(s)
      },
      onError: (err: unknown) => setError(decodeIpcError(err).message),
    }
    if (editing) update.mutate([editing.id, fields], opts)
    else create.mutate([{ crewId, ...fields }], opts)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <form onSubmit={submit} className="space-y-5">
          <DialogHeader>
            <DialogTitle>{editing ? 'Edit terminal' : 'New scratch terminal'}</DialogTitle>
            <DialogDescription>
              {editing
                ? 'Changes apply the next time the terminal opens.'
                : 'A quick terminal that belongs to no squad or job. It costs nothing while closed.'}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="scratch-title">Name</Label>
              <Input id="scratch-title" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="scratch" autoFocus />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="scratch-agent">Type</Label>
              <Select value={agent} onValueChange={(v) => changeAgent(v as AgentKind)}>
                <SelectTrigger id="scratch-agent" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {(Object.keys(agentLabel) as AgentKind[]).map((a) => (
                    <SelectItem key={a} value={a}>
                      {a === 'shell' ? 'Shell' : `${agentLabel[a]} agent`}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            {agent === 'claude' && claudePresets.length > 0 && (
              <div className="space-y-1.5">
                <Label htmlFor="scratch-preset">Preset</Label>
                <Select value={presetId} onValueChange={choosePreset}>
                  <SelectTrigger id="scratch-preset" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={NONE}>None</SelectItem>
                    {claudePresets.map((p) => (
                      <SelectItem key={p.id} value={String(p.id)}>
                        {p.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}
            {agent !== 'shell' && (
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label htmlFor="scratch-model">Model</Label>
                  <Input id="scratch-model" value={model} onChange={(e) => setModel(e.target.value)} className="font-mono" />
                </div>
                {agent === 'claude' && (
                  <div className="space-y-1.5">
                    <Label htmlFor="scratch-effort">Effort</Label>
                    <Select value={effort} onValueChange={setEffort}>
                      <SelectTrigger id="scratch-effort" className="w-full">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value={DEFAULT_EFFORT}>Model default</SelectItem>
                        {EFFORTS.map((e) => (
                          <SelectItem key={e} value={e}>
                            {e}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                )}
              </div>
            )}
            <div className="space-y-1.5">
              <Label htmlFor="scratch-cwd">Folder</Label>
              <div className="flex gap-2">
                <Input id="scratch-cwd" value={cwd} onChange={(e) => setCwd(e.target.value)} className="font-mono text-xs" />
                <Button type="button" variant="outline" size="icon" aria-label="Browse for a folder" onClick={() => void browse()}>
                  <FolderOpen />
                </Button>
              </div>
            </div>
          </div>
          {error && (
            <p role="alert" className="text-destructive text-xs">
              {error}
            </p>
          )}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={!canSubmit || pending}>
              {editing ? 'Save' : 'Create terminal'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
