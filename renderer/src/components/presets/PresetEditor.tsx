import { useState, type ReactNode } from 'react'
import { decodeIpcError } from '@shared/ipc'
import { OPTIONAL_MCP_IDS, type AgentKind, type CacheTtl, type LaunchSettings, type McpMode, type Preset, type PresetPatch } from '@shared/types'
import { Button } from '@/components/ui/button'
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { useCreatePreset, useOptionalMcp, useUpdatePreset } from '@/lib/queries'
import { useOpenSettingsSection } from '../settings/nav-context'
import { ModelEffortSelect } from '@/components/settings/ModelEffortSelect'
import { STAGES, canEditFiles } from '@shared/presets'
import { RoleTextEditor } from './RoleTextEditor'

const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max']
const MODES: Array<{ id: string; label: string; hint: string }> = [
  { id: 'acceptEdits', label: 'Accept edits', hint: 'Edits go through; other tools follow the allow and deny rules.' },
  { id: 'dontAsk', label: "Don't ask", hint: 'Anything not allowed in advance is refused, so the terminal cannot drift into editing.' },
  { id: 'plan', label: 'Plan', hint: 'Reads and plans only.' },
  { id: 'manual', label: 'Manual', hint: 'Asks you in its terminal before each action.' },
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
  mcp: McpMode
  // Optional servers ticked (recommended, never required).
  optional: string[]
  roleText: string
}

const lines = (text: string) =>
  text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)

const sameList = (a: string[], b: string[]) => a.length === b.length && a.every((v, i) => v === b[i])
// CodeGraph has its own select above, so it is not one of the optional ticks.
const isOptional = (s: string) => s !== 'codegraph' && (OPTIONAL_MCP_IDS as readonly string[]).includes(s)

// The servers a preset names: CodeGraph from its select, the others kept as they are, the optional ones as ticked.
const serversOf = (f: Form, base: string[]): string[] => [...(f.mcp === 'codegraph' ? ['codegraph'] : []), ...base.filter((s) => s !== 'codegraph' && !isOptional(s)), ...f.optional]

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
      mcp: 'codegraph',
      optional: [],
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
    mcp: p.mcp,
    optional: p.mcpServers.filter(isOptional),
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
  defaultModel: string
  onClose: () => void
}

function EditorForm({ preset, defaultModel, onClose }: Props) {
  const create = useCreatePreset()
  const update = useUpdatePreset()
  const initialRole = preset?.roleText ?? ''
  const [form, setForm] = useState(() => toForm(preset, initialRole, defaultModel))
  const optional = useOptionalMcp(null)
  const openSettings = useOpenSettingsSection()
  const [error, setError] = useState<string | null>(null)
  const busy = create.isPending || update.isPending
  const set = (patch: Partial<Form>) => setForm((f) => ({ ...f, ...patch }))

  const stage = preset?.builtin ? STAGES[preset.builtin.replace(/-opencode$/, '')] : undefined
  const shell = form.agent === 'shell'
  const claude = form.agent === 'claude'
  const noEffort = /haiku-4/.test(form.model)

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
    if (next.mcp !== p.mcp) patch.mcp = next.mcp
    const servers = serversOf(form, p.mcpServers)
    if (!sameList(servers, p.mcpServers)) patch.mcpServers = servers
    if (form.roleText !== initialRole) patch.roleText = form.roleText
    return patch
  }

  const run = async () => {
    setError(null)
    if (form.name.trim() === '') return setError('Give the preset a name.')
    try {
      if (!preset) {
        await create.mutateAsync([{ ...launchOf(form), name: form.name.trim(), roleText: form.roleText, mcpServers: serversOf(form, ['hindsight']) }])
      } else {
        const patch = patchOf()
        if (Object.keys(patch).length > 0) await update.mutateAsync([preset.id, patch])
      }
      onClose()
    } catch (e) {
      setError(decodeIpcError(e).message)
    }
  }

  const mode = MODES.find((m) => m.id === form.permissionMode)

  return (
    <>
      <DialogBody className="sm:grid-cols-2">
        {stage && (
          <p className="text-sm sm:col-span-2">
            <span className="font-medium">
              Stage {stage.stage}: {stage.name}.
            </span>{' '}
            <span className="text-muted-foreground">Use it when: {stage.whenToUse}</span>
          </p>
        )}
        {!shell && (
          <p className="text-sm sm:col-span-2">
            {canEditFiles({ tools: form.tools, deny: lines(form.deny) })
              ? 'This preset can edit files.'
              : 'Read-only: its tools and deny rules stop it editing files.'}
          </p>
        )}
        <Field id="preset-name" label="Name">
          <Input id="preset-name" value={form.name} onChange={(e) => set({ name: e.target.value })} maxLength={80} />
        </Field>
        <Field id="preset-agent" label="Runs in">
          <Select value={form.agent} onValueChange={(v) => set({ agent: v as AgentKind })}>
            <SelectTrigger id="preset-agent" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="claude">Claude Code</SelectItem>
              <SelectItem value="opencode">OpenCode</SelectItem>
              <SelectItem value="codex">Codex</SelectItem>
              <SelectItem value="shell">Plain shell</SelectItem>
            </SelectContent>
          </Select>
        </Field>

        {form.agent === 'opencode' && (
          <Field id="preset-model" label="Model" hint="Only the models OpenCode lists. Changing it on a running terminal restarts it.">
            <ModelEffortSelect cli="opencode" label="Preset" model={form.model} effort={form.effort} onChange={(model, effort) => set({ model, effort })} />
          </Field>
        )}
        {!shell && form.agent !== 'opencode' && (
          <Field id="preset-model" label="Model" hint="Opus costs more per token than Sonnet, and Haiku far less.">
            <Input id="preset-model" className="font-mono" value={form.model} onChange={(e) => set({ model: e.target.value })} />
          </Field>
        )}
        {claude && !noEffort && (
          <Field id="preset-effort" label="Effort" hint="Higher effort thinks longer and writes more.">
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
          <Field id="preset-mode" label="Permissions" hint={<>{mode?.hint} Auto mode is not offered: its classifier makes an extra model call for each action.</>}>
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
          <details className="group space-y-3 sm:col-span-2">
            <summary className="cursor-pointer text-sm font-medium select-none">Advanced</summary>
            <div className="grid gap-4 pt-1 sm:grid-cols-2">
              <Field id="preset-cache" label="Cache lifetime" hint="1 hour costs more to write but survives long idle gaps. Auto uses the Tokens setting.">
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
              <Field id="preset-cap" label="Context cap (tokens)" hint="Compacts earlier. 0 uses Claude Code's default; otherwise 100000 to 1000000.">
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
              <Field id="preset-tools" label="Tools" hint="Comma-separated, like Read,Grep,Bash. Empty keeps Claude Code's default set.">
                <Input id="preset-tools" className="font-mono" value={form.tools} onChange={(e) => set({ tools: e.target.value })} />
              </Field>
              <Field id="preset-mcp" label="MCP servers" hint="CodeGraph answers code questions in one call. None leaves it out.">
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
              <Field id="preset-optional" label="Optional servers" hint="Recommended, never required. The preset records the choice; tile launches do not attach MCP servers yet.">
                <div id="preset-optional" className="space-y-2">
                  {(optional.data ?? []).filter((e) => isOptional(e.id)).map((e) => (
                    <div key={e.id} className="space-y-1">
                      <label className="flex items-center gap-2 text-sm">
                        <input
                          type="checkbox"
                          aria-label={e.name}
                          className="size-4"
                          checked={form.optional.includes(e.id)}
                          onChange={(ev) => set({ optional: ev.target.checked ? [...form.optional, e.id] : form.optional.filter((x) => x !== e.id) })}
                        />
                        {e.name}
                      </label>
                      {form.optional.includes(e.id) && e.status === 'not-added' && (
                        <p className="text-muted-foreground flex flex-wrap items-center gap-2 text-xs">
                          {e.hint}
                          <Button variant="link" size="sm" className="h-auto p-0" onClick={() => openSettings('mcp')}>
                            Open MCP servers
                          </Button>
                        </p>
                      )}
                    </div>
                  ))}
                </div>
              </Field>
              <Field id="preset-allow" label="Allowed without asking" hint="One rule per line, like Bash(npm test*).">
                <Textarea id="preset-allow" className="min-h-24 font-mono text-xs" spellCheck={false} value={form.allow} onChange={(e) => set({ allow: e.target.value })} />
              </Field>
              <Field id="preset-deny" label="Always refused" hint="One rule per line, like Bash(git push*).">
                <Textarea id="preset-deny" className="min-h-24 font-mono text-xs" spellCheck={false} value={form.deny} onChange={(e) => set({ deny: e.target.value })} />
              </Field>
            </div>
          </details>
        )}

        {!shell && (
          <div className="space-y-1.5 sm:col-span-2">
            <Label htmlFor="preset-role" className="text-sm">
              Instructions
            </Label>
            <RoleTextEditor value={form.roleText} onChange={(v) => set({ roleText: v })} />
            <p className="text-muted-foreground text-xs">Sent to the terminal with every turn.</p>
          </div>
        )}

        {error && (
          <p role="alert" className="text-destructive text-sm sm:col-span-2">
            {error}
          </p>
        )}
      </DialogBody>

      <DialogFooter>
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button onClick={() => void run()} disabled={busy}>
          {preset ? 'Save preset' : 'Create preset'}
        </Button>
      </DialogFooter>
    </>
  )
}

export function PresetEditor({ open, ...props }: Props & { open: boolean }) {
  const { preset } = props
  return (
    <Dialog open={open} onOpenChange={(o) => !o && props.onClose()}>
      <DialogContent size="lg">
        <DialogHeader>
          <DialogTitle>{preset ? `Edit ${preset.name}` : 'New preset'}</DialogTitle>
          <DialogDescription>A preset is settings plus instructions for a terminal. Applying it starts nothing.</DialogDescription>
        </DialogHeader>
        <EditorForm key={preset?.id ?? 'new'} {...props} />
      </DialogContent>
    </Dialog>
  )
}
