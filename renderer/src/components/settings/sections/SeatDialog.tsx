import { useState } from 'react'
import { decodeIpcError } from '@shared/ipc'
import type { AgentKind, Preset, PresetPatch } from '@shared/types'
import { Button } from '@/components/ui/button'
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { ModelEffortSelect } from '@/components/jobs/ModelEffortSelect'
import { useMcpServers, useUpdatePreset } from '@/lib/queries'
import { MCP_STATE_LABEL } from './McpSection'

const lines = (text: string) =>
  text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)

const BUILTIN_SERVERS = ['codegraph', 'hindsight']

const AGENT_LABEL: Partial<Record<AgentKind, string>> = { codex: 'Codex', shell: 'Plain shell' }

// What a preset does as a seat on a team: which CLI runs it, its skills, and whether it uses Hindsight and CodeGraph.
export function SeatDialog({ preset, onClose }: { preset: Preset; onClose: () => void }) {
  const update = useUpdatePreset()
  const servers = useMcpServers(null)
  const [agent, setAgent] = useState<AgentKind>(preset.agent)
  const [model, setModel] = useState(preset.model)
  const [effort, setEffort] = useState(preset.effort)
  const [skills, setSkills] = useState(preset.skills.join('\n'))
  const [hindsight, setHindsight] = useState(preset.hindsight)
  const [codegraph, setCodegraph] = useState(preset.codegraph)
  const [picked, setPicked] = useState<string[]>(preset.mcpServers.filter((n) => !BUILTIN_SERVERS.includes(n)))
  const [error, setError] = useState<string | null>(null)

  const configured = (servers.data?.servers ?? []).filter((s) => (s.editable || s.builtin) && !BUILTIN_SERVERS.includes(s.name))
  const options = [
    ...new Map(configured.map((s) => [s.name, { name: s.name, note: MCP_STATE_LABEL[s.state] }])).values(),
    ...picked.filter((n) => !configured.some((s) => s.name === n)).map((name) => ({ name, note: 'not configured' })),
  ]

  const save = async () => {
    setError(null)
    const patch: PresetPatch = {}
    const list = lines(skills)
    if (agent !== preset.agent) patch.agent = agent
    if (model !== preset.model) patch.model = model
    if (effort !== preset.effort) patch.effort = effort
    if (list.join('\n') !== preset.skills.join('\n')) patch.skills = list
    const chosen = [...(hindsight ? ['hindsight'] : []), ...(codegraph ? ['codegraph'] : []), ...picked]
    if (chosen.length !== preset.mcpServers.length || chosen.some((n) => !preset.mcpServers.includes(n))) patch.mcpServers = chosen
    try {
      if (Object.keys(patch).length > 0) await update.mutateAsync([preset.id, patch, false])
      onClose()
    } catch (e) {
      setError(decodeIpcError(e).message)
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent size="lg">
        <DialogHeader>
          <DialogTitle>Seat settings: {preset.name}</DialogTitle>
          <DialogDescription>How this preset behaves when a team seats it on a job.</DialogDescription>
        </DialogHeader>
        <DialogBody>
          <div className="grid items-start gap-4 lg:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="seat-agent" className="text-sm">
              Agent
            </Label>
            <Select value={agent} onValueChange={(v) => setAgent(v as AgentKind)}>
              <SelectTrigger id="seat-agent" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="claude">Claude Code</SelectItem>
                <SelectItem value="opencode">opencode</SelectItem>
                {agent !== 'claude' && agent !== 'opencode' && <SelectItem value={agent}>{AGENT_LABEL[agent] ?? agent}</SelectItem>}
              </SelectContent>
            </Select>
          </div>
          {(agent === 'claude' || agent === 'opencode') && (
            <div className="space-y-1.5">
              <Label className="text-sm">Default model and effort</Label>
              <ModelEffortSelect
                cli={agent}
                model={model}
                onModelChange={setModel}
                effort={effort}
                onEffortChange={setEffort}
              />
              <p className="text-muted-foreground text-xs">What a team seat on this preset runs unless the team overrides it.</p>
            </div>
          )}
          <div className="space-y-1.5">
            <Label htmlFor="seat-skills" className="text-sm">
              Skills
            </Label>
            <Textarea
              id="seat-skills"
              className="min-h-24 font-mono text-xs"
              spellCheck={false}
              value={skills}
              onChange={(e) => setSkills(e.target.value)}
            />
            <p className="text-muted-foreground text-xs">One local skill per line. The seat may use only these.</p>
          </div>
          <div className="flex items-center justify-between gap-4">
            <div>
              <Label htmlFor="seat-hindsight" className="text-sm">
                Hindsight memory
              </Label>
              <p className="text-muted-foreground text-xs">Lets the seat read and write the project's Hindsight memory.</p>
            </div>
            <Switch id="seat-hindsight" checked={hindsight} onCheckedChange={setHindsight} />
          </div>
          <div className="flex items-center justify-between gap-4">
            <div>
              <Label htmlFor="seat-codegraph" className="text-sm">
                CodeGraph
              </Label>
              <p className="text-muted-foreground text-xs">Gives the seat the CodeGraph tool for code questions.</p>
            </div>
            <Switch id="seat-codegraph" checked={codegraph} onCheckedChange={setCodegraph} />
          </div>
          <div className="space-y-1.5">
            <Label className="text-sm">Other MCP servers</Label>
            <ul aria-label="MCP servers" className="max-h-64 space-y-1 overflow-y-auto rounded-md border p-2">
              {options.length === 0 && <li className="text-muted-foreground text-xs">No other servers are configured.</li>}
              {options.map((o) => (
                <li key={o.name}>
                  <label className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={picked.includes(o.name)}
                      onChange={(e) => setPicked(e.target.checked ? [...picked, o.name] : picked.filter((n) => n !== o.name))}
                    />
                    <span className="font-mono text-xs">{o.name}</span>
                    <span className="text-muted-foreground text-[11px]">{o.note}</span>
                  </label>
                </li>
              ))}
            </ul>
            <p className="text-muted-foreground text-xs">
              A job starts even when one of these is down; its brief names the server that is.
            </p>
          </div>
        </div>
        {error && (
          <p role="alert" className="text-destructive text-sm">
            {error}
          </p>
        )}
        </DialogBody>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={() => void save()} disabled={update.isPending}>
            Save seat
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
