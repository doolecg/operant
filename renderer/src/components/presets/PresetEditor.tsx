import { useState, type ReactNode } from 'react'
import { decodeIpcError } from '@shared/ipc'
import type { AgentKind, CacheTtl, LaunchSettings, McpMode, Preset, PresetPatch } from '@shared/types'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { useCreatePreset, useShippedRole, useUpdatePreset } from '@/lib/queries'
import { RoleTextEditor } from './RoleTextEditor'

const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max']
const MODES: Array<{ id: string; label: string; hint: string }> = [
  { id: 'acceptEdits', label: 'Accept edits', hint: 'Edits go through; other tools follow the allow and deny rules.' },
  { id: 'dontAsk', label: "Don't ask", hint: 'Anything not allowed in advance is denied, so the operator cannot drift into editing.' },
  { id: 'plan', label: 'Plan', hint: 'Reads and plans only.' },
  { id: 'manual', label: 'Manual', hint: 'Asks you in its terminal for each action.' },
  { id: 'bypassPermissions', label: 'Bypass permissions', hint: 'Runs everything without asking. Only for a sandbox you trust.' },
]

interface Form {
  name: string
  agent: AgentKind
  model: string
  effort: string
  permissionMode: string
  tools: string
  allow: string
  deny: string
  cacheTtl: CacheTtl
  contextCap: string
  clearBetweenJobs: boolean
  mcp: McpMode
  roleText: string
}

const lines = (text: string) =>
  text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)

const sameList = (a: string[], b: string[]) => a.length === b.length && a.every((v, i) => v === b[i])

function toForm(p: Preset | null, role: string, defaultModel: string): Form {
  if (!p)
    return {
      name: '',
      agent: 'claude',
      model: defaultModel,
      effort: '',
      permissionMode: 'acceptEdits',
      tools: '',
      allow: '',
      deny: '',
      cacheTtl: 'auto',
      contextCap: '0',
      clearBetweenJobs: false,
      mcp: 'codegraph',
      roleText: role,
    }
  return {
    name: p.name,
    agent: p.agent,
    model: p.model,
    effort: p.effort,
    permissionMode: p.permissionMode,
    tools: p.tools,
    allow: p.allow.join('\n'),
    deny: p.deny.join('\n'),
    cacheTtl: p.cacheTtl,
    contextCap: String(p.contextCap),
    clearBetweenJobs: p.clearBetweenJobs,
    mcp: p.mcp,
    roleText: role,
  }
}

function launchOf(f: Form): LaunchSettings {
  return {
    agent: f.agent,
    model: f.model.trim(),
    effort: f.effort,
    permissionMode: f.permissionMode,
    tools: f.tools.trim(),
    allow: lines(f.allow),
    deny: lines(f.deny),
    cacheTtl: f.cacheTtl,
    contextCap: Number(f.contextCap.trim() === '' ? 0 : f.contextCap),
    clearBetweenJobs: f.clearBetweenJobs,
    mcp: f.mcp,
  }
}

function Field({ id, label, hint, children }: { id: string; label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id} className="text-sm">
        {label}
      </Label>
      {children}
      {hint && <p className="text-muted-foreground text-xs">{hint}</p>}
    </div>
  )
}

interface Props {
  // null creates a new preset.
  preset: Preset | null
  // Operators on this preset, and how many of them still match it.
  operators: number
  unmodified: number
  defaultModel: string
  onClose: () => void
}

function EditorForm({ preset, operators, unmodified, defaultModel, shipped, onClose }: Props & { shipped?: string }) {
  const create = useCreatePreset()
  const update = useUpdatePreset()
  const initialRole = preset ? (preset.roleText ?? shipped ?? '') : ''
  const [form, setForm] = useState(() => toForm(preset, initialRole, defaultModel))
  const [error, setError] = useState<string | null>(null)
  const [asking, setAsking] = useState(false)
  const busy = create.isPending || update.isPending
  const set = (patch: Partial<Form>) => setForm((f) => ({ ...f, ...patch }))

  const claude = form.agent === 'claude'
  const shell = form.agent === 'shell'
  const haiku = form.model.startsWith('claude-haiku')

  const patchOf = (): PresetPatch => {
    const p = preset!
    const next = launchOf(form)
    const patch: PresetPatch = {}
    if (form.name.trim() !== p.name) patch.name = form.name.trim()
    if (next.agent !== p.agent) patch.agent = next.agent
    if (next.model !== p.model) patch.model = next.model
    if (next.effort !== p.effort) patch.effort = next.effort
    if (next.permissionMode !== p.permissionMode) patch.permissionMode = next.permissionMode
    if (next.tools !== p.tools) patch.tools = next.tools
    if (!sameList(next.allow, p.allow)) patch.allow = next.allow
    if (!sameList(next.deny, p.deny)) patch.deny = next.deny
    if (next.cacheTtl !== p.cacheTtl) patch.cacheTtl = next.cacheTtl
    if (next.contextCap !== p.contextCap) patch.contextCap = next.contextCap
    if (next.clearBetweenJobs !== p.clearBetweenJobs) patch.clearBetweenJobs = next.clearBetweenJobs
    if (next.mcp !== p.mcp) patch.mcp = next.mcp
    if (form.roleText !== initialRole) patch.roleText = p.builtin && form.roleText === shipped ? null : form.roleText
    return patch
  }

  const run = async (apply: boolean) => {
    setError(null)
    if (form.name.trim() === '') return setError('Give the preset a name.')
    try {
      if (!preset) {
        await create.mutateAsync([{ ...launchOf(form), name: form.name.trim(), roleText: form.roleText }])
      } else {
        const patch = patchOf()
        if (Object.keys(patch).length > 0) await update.mutateAsync([preset.id, patch, apply])
      }
      onClose()
    } catch (e) {
      setAsking(false)
      setError(decodeIpcError(e).message)
    }
  }

  const save = () => {
    if (!preset) return void run(false)
    const { name: _name, ...rest } = patchOf()
    if (Object.keys(rest).length > 0 && unmodified > 0) {
      setError(null)
      if (form.name.trim() === '') return setError('Give the preset a name.')
      return setAsking(true)
    }
    void run(false)
  }

  const mode = MODES.find((m) => m.id === form.permissionMode)

  return (
    <>
      <div className="grid max-h-[62vh] gap-4 overflow-y-auto py-1 pr-2 sm:grid-cols-2">
        <Field id="preset-name" label="Name">
          <Input id="preset-name" value={form.name} onChange={(e) => set({ name: e.target.value })} maxLength={80} />
        </Field>
        <Field id="preset-agent" label="Agent">
          <Select value={form.agent} onValueChange={(v) => set({ agent: v as AgentKind })}>
            <SelectTrigger id="preset-agent" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="claude">Claude Code</SelectItem>
              <SelectItem value="codex">Codex</SelectItem>
              <SelectItem value="shell">Plain shell</SelectItem>
            </SelectContent>
          </Select>
        </Field>

        {!shell && (
          <Field
            id="preset-model"
            label="Model"
            hint="Opus costs several times what Sonnet does per token and Haiku far less. Changing it on a running operator restarts it and loses its cache."
          >
            <Input id="preset-model" className="font-mono" value={form.model} onChange={(e) => set({ model: e.target.value })} />
          </Field>
        )}
        {claude && !haiku && (
          <Field
            id="preset-effort"
            label="Effort"
            hint="Higher effort thinks longer and writes more output tokens. Changing it on a running operator relaunches it fresh."
          >
            <Select value={form.effort || 'default'} onValueChange={(v) => set({ effort: v === 'default' ? '' : v })}>
              <SelectTrigger id="preset-effort" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="default">Model default</SelectItem>
                {EFFORTS.map((e) => (
                  <SelectItem key={e} value={e}>
                    {e}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
        )}

        {!shell && (
          <Field
            id="preset-mode"
            label="Permission mode"
            hint={
              <>
                {mode?.hint} Auto mode is not offered: its classifier makes an extra model call for each action.
              </>
            }
          >
            <Select value={form.permissionMode} onValueChange={(v) => set({ permissionMode: v })}>
              <SelectTrigger id="preset-mode" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {MODES.map((m) => (
                  <SelectItem key={m.id} value={m.id}>
                    {m.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
        )}

        {claude && (
          <>
            <Field
              id="preset-cache"
              label="Cache lifetime"
              hint="1 hour costs more to write but survives long idle gaps (good for a PM or reviewer that waits). Auto uses the Tokens setting."
            >
              <Select value={form.cacheTtl} onValueChange={(v) => set({ cacheTtl: v as CacheTtl })}>
                <SelectTrigger id="preset-cache" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="auto">Auto</SelectItem>
                  <SelectItem value="5m">5 minutes</SelectItem>
                  <SelectItem value="1h">1 hour</SelectItem>
                </SelectContent>
              </Select>
            </Field>
            <Field
              id="preset-cap"
              label="Context cap (tokens)"
              hint="Compacts earlier, so each turn reads a smaller context. 0 uses Claude Code's default (about 967k on 1M models); otherwise 100000 to 1000000."
            >
              <Input
                id="preset-cap"
                type="number"
                min={0}
                max={1000000}
                step={10000}
                className="tabular-nums"
                value={form.contextCap}
                onChange={(e) => set({ contextCap: e.target.value })}
              />
            </Field>
            <Field
              id="preset-tools"
              label="Tools"
              hint="Comma-separated, like Read,Grep,Bash. Fewer tools mean a smaller fixed prefix on every turn. Empty keeps Claude Code's default set."
            >
              <Input id="preset-tools" className="font-mono" value={form.tools} onChange={(e) => set({ tools: e.target.value })} />
            </Field>
            <Field
              id="preset-mcp"
              label="MCP servers"
              hint="CodeGraph adds its tool list to the prefix (and answers code questions in one call). None leaves it out."
            >
              <Select value={form.mcp} onValueChange={(v) => set({ mcp: v as McpMode })}>
                <SelectTrigger id="preset-mcp" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="codegraph">CodeGraph</SelectItem>
                  <SelectItem value="none">None</SelectItem>
                </SelectContent>
              </Select>
            </Field>
            <Field id="preset-allow" label="Allowed without asking" hint="One rule per line, like Bash(npm test*) or Edit(docs/**).">
              <Textarea
                id="preset-allow"
                className="min-h-24 font-mono text-xs"
                spellCheck={false}
                value={form.allow}
                onChange={(e) => set({ allow: e.target.value })}
              />
            </Field>
            <Field id="preset-deny" label="Always denied" hint="One rule per line, like Bash(git push*).">
              <Textarea
                id="preset-deny"
                className="min-h-24 font-mono text-xs"
                spellCheck={false}
                value={form.deny}
                onChange={(e) => set({ deny: e.target.value })}
              />
            </Field>
          </>
        )}

        {!shell && (
          <div className="flex items-start justify-between gap-4 sm:col-span-2">
            <div className="space-y-1">
              <Label htmlFor="preset-clear" className="text-sm">
                Clear the conversation between jobs
              </Label>
              <p className="text-muted-foreground text-xs">
                When the operator is idle with no job in progress, Operant clears its context so the next job starts small instead of carrying the
                last one. Turn off for roles that need continuity, like the PM.
              </p>
            </div>
            <Switch id="preset-clear" checked={form.clearBetweenJobs} onCheckedChange={(v) => set({ clearBetweenJobs: v })} />
          </div>
        )}

        {!shell && (
          <div className="space-y-1.5 sm:col-span-2">
            <Label htmlFor="preset-role" className="text-sm">
              Role text
            </Label>
            <RoleTextEditor value={form.roleText} onChange={(v) => set({ roleText: v })} shipped={shipped} isBuiltin={!!preset?.builtin} />
          </div>
        )}
      </div>

      {error && (
        <p role="alert" className="text-destructive text-sm">
          {error}
        </p>
      )}

      {asking ? (
        <div className="space-y-3 rounded-md border p-3">
          <p className="text-sm">
            {operators} operator{operators === 1 ? '' : 's'} use this preset; {unmodified} {unmodified === 1 ? 'is' : 'are'} unmodified. Apply
            this change to {unmodified === 1 ? 'it' : 'them'}? Running operators take it on their next restart.
          </p>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setAsking(false)} disabled={busy}>
              Back
            </Button>
            <Button variant="outline" onClick={() => void run(false)} disabled={busy}>
              Save preset only
            </Button>
            <Button onClick={() => void run(true)} disabled={busy}>
              Save and apply to {unmodified}
            </Button>
          </DialogFooter>
        </div>
      ) : (
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={save} disabled={busy}>
            {preset ? 'Save preset' : 'Create preset'}
          </Button>
        </DialogFooter>
      )}
    </>
  )
}

export function PresetEditor({ open, ...props }: Props & { open: boolean }) {
  const { preset } = props
  const needsShipped = !!preset?.builtin && preset.roleText == null
  const shipped = useShippedRole(preset?.builtin ? preset.id : null)
  const ready = !needsShipped || shipped.data !== undefined
  return (
    <Dialog open={open} onOpenChange={(o) => !o && props.onClose()}>
      <DialogContent className="sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>{preset ? `Edit ${preset.name}` : 'New preset'}</DialogTitle>
          <DialogDescription>
            A preset is launch settings plus one role text. New operators copy it; editing it later can update the operators that still match.
          </DialogDescription>
        </DialogHeader>
        {ready ? (
          <EditorForm key={preset?.id ?? 'new'} {...props} shipped={shipped.data} />
        ) : (
          <p className="text-muted-foreground py-8 text-center text-sm">Loading…</p>
        )}
      </DialogContent>
    </Dialog>
  )
}
