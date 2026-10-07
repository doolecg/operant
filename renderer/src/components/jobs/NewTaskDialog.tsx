import { useEffect, useState, type FormEvent } from 'react'
import { Plus, Save, Trash2 } from 'lucide-react'
import { decodeIpcError } from '@shared/ipc'
import type { MasterCli, Run, TeamSeat } from '@shared/types'
import { Button } from '@/components/ui/button'
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { useCreateRun, useCreateTeam, usePresets, useSettings, useTeams } from '@/lib/queries'
import { cn } from '@/lib/utils'
import { ModelEffortSelect } from './ModelEffortSelect'

const CUSTOM = 'custom'

interface Props {
  crewId: number
  open: boolean
  onOpenChange: (open: boolean) => void
  onCreated?: (run: Run) => void
}

// The Plus menu: a task for the project's Master, alone or with a team of seats, then Send.
export function NewTaskDialog({ crewId, open, onOpenChange, onCreated }: Props) {
  const teamsQuery = useTeams()
  const presetsQuery = usePresets()
  const teams = teamsQuery.data ?? []
  const shown = teams.filter((t) => !t.hidden)
  const presets = presetsQuery.data ?? []
  const main = useSettings().data
  const create = useCreateRun()
  const saveTeam = useCreateTeam()
  const [mode, setMode] = useState<'solo' | 'team'>('solo')
  const [background, setBackground] = useState(false)
  const [task, setTask] = useState('')
  const [cli, setCli] = useState<MasterCli>('claude')
  const [masterModel, setMasterModel] = useState('')
  const [masterEffort, setMasterEffort] = useState('')
  const [teamId, setTeamId] = useState<string>(CUSTOM)
  const [seats, setSeats] = useState<TeamSeat[]>([])
  const [error, setError] = useState<string | null>(null)
  const [teamName, setTeamName] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    setMode('solo')
    setBackground(false)
    setTask('')
    setCli(main?.mainCli ?? 'claude')
    setMasterModel(main?.mainModel ?? '')
    setMasterEffort(main?.mainEffort ?? '')
    setTeamId(CUSTOM)
    setSeats([])
    setError(null)
    setTeamName(null)
    // Teams and presets are edited elsewhere, so each opening reads them fresh.
    void teamsQuery.refetch()
    void presetsQuery.refetch()
  }, [open])

  const pickTeam = (value: string) => {
    setTeamId(value)
    const team = teams.find((t) => String(t.id) === value)
    setSeats(team ? team.seats.map((s) => ({ ...s })) : [])
  }

  const patchSeat = (i: number, patch: Partial<TeamSeat>) => setSeats((all) => all.map((s, j) => (j === i ? { ...s, ...patch } : s)))
  const addSeat = () => {
    const first = presets.find((p) => p.agent === main?.mainCli) ?? presets[0]
    if (first) setSeats((all) => [...all, { presetId: first.id, count: 1, model: first.model, effort: first.effort }])
  }

  // The seats chosen here become a team of the user's own, picked straight away.
  const saveAsTeam = () => {
    const name = (teamName ?? '').trim()
    if (!name) return setError('Give the team a name.')
    setError(null)
    saveTeam.mutate(
      { name, seats: seats.map((s) => ({ ...s, model: s.model.trim() })) },
      {
        onSuccess: (team) => {
          setTeamId(String(team.id))
          setTeamName(null)
        },
        onError: (err) => setError(decodeIpcError(err).message),
      },
    )
  }

  const submit = (e: FormEvent) => {
    e.preventDefault()
    setError(null)
    if (mode === 'team' && seats.length === 0) return setError('Add at least one seat, or choose Solo.')
    create.mutate(
      [
        {
          crewId,
          task: task.trim(),
          masterCli: cli,
          ...(masterModel ? { masterModel } : {}),
          ...(masterEffort ? { masterEffort } : {}),
          mode: background ? ('background' as const) : ('master' as const),
          ...(mode === 'team' ? { teamId: teamId === CUSTOM ? null : Number(teamId), seats } : {}),
        },
      ],
      {
        onSuccess: (run) => {
          onOpenChange(false)
          onCreated?.(run)
        },
        onError: (err) => setError(decodeIpcError(err).message),
      },
    )
  }

  const presetCli = (id: number) => (presets.find((p) => p.id === id)?.agent === 'opencode' ? 'opencode' : 'claude')
  const presetName = (id: number) => presets.find((p) => p.id === id)?.name ?? `Preset ${id}`

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="lg">
        <form onSubmit={submit}>
          <DialogHeader>
            <DialogTitle>Start new task</DialogTitle>
            <DialogDescription>
              {background
                ? "The headless runner does this task without the Master Terminal."
                : `This project's Master Terminal (${cli === 'opencode' ? 'OpenCode' : 'Claude Code'}) gets the task and runs it alone, or with a team of seats as its own subagents.`}
            </DialogDescription>
          </DialogHeader>

          <DialogBody>
            <div role="group" aria-label="Run type" className="bg-muted flex w-fit rounded-md p-0.5">
            {(['solo', 'team'] as const).map((m) => (
              <button
                key={m}
                type="button"
                aria-pressed={mode === m}
                onClick={() => setMode(m)}
                className={cn(
                  'rounded px-3 py-1 text-xs transition-colors',
                  mode === m ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground',
                )}
              >
                {m === 'solo' ? 'Solo' : 'Team'}
              </button>
            ))}
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="run-task">Task</Label>
            <Textarea id="run-task" value={task} onChange={(e) => setTask(e.target.value)} rows={4} placeholder="What should the Master do?" autoFocus />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="run-cli">Master CLI</Label>
            <Select value={cli} onValueChange={(v) => setCli(v as MasterCli)}>
              <SelectTrigger id="run-cli" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="claude">Claude Code</SelectItem>
                <SelectItem value="opencode">OpenCode</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="flex items-start justify-between gap-4 rounded-md border p-3">
            <div className="space-y-0.5">
              <Label htmlFor="run-background">Run in background</Label>
              <p className="text-muted-foreground text-xs">Runs without the Master Terminal, no review step.</p>
            </div>
            <Switch id="run-background" checked={background} onCheckedChange={setBackground} />
          </div>

          <ModelEffortSelect
            label="Master"
            cli={cli}
            model={masterModel}
            onModelChange={setMasterModel}
            effort={masterEffort}
            onEffortChange={setMasterEffort}
          />

          {mode === 'team' && (
            <div className="space-y-3">
              <div className="space-y-1.5">
                <Label htmlFor="run-team">Team</Label>
                <Select value={teamId} onValueChange={pickTeam}>
                  <SelectTrigger id="run-team" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={CUSTOM}>Custom seats</SelectItem>
                    {[
                      { label: 'Built-in', list: shown.filter((t) => t.builtin) },
                      { label: 'Yours', list: shown.filter((t) => !t.builtin) },
                    ].map(
                      (g) =>
                        g.list.length > 0 && (
                          <SelectGroup key={g.label}>
                            <SelectLabel>{g.label}</SelectLabel>
                            {g.list.map((t) => (
                              <SelectItem key={t.id} value={String(t.id)}>
                                {t.name}
                              </SelectItem>
                            ))}
                          </SelectGroup>
                        ),
                    )}
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium">Seats</span>
                  <div className="flex gap-2">
                    {seats.length > 0 && teamName === null && (
                      <Button type="button" variant="ghost" size="sm" onClick={() => setTeamName('')}>
                        <Save /> Save as team
                      </Button>
                    )}
                    <Button type="button" variant="outline" size="sm" onClick={addSeat} disabled={presets.length === 0}>
                      <Plus /> Add seat
                    </Button>
                  </div>
                </div>
                {teamName !== null && (
                  <div className="flex items-center gap-2">
                    <Input
                      aria-label="Team name"
                      placeholder="Team name"
                      maxLength={80}
                      value={teamName}
                      autoFocus
                      onChange={(e) => setTeamName(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          e.preventDefault()
                          saveAsTeam()
                        }
                      }}
                    />
                    <Button type="button" size="sm" onClick={saveAsTeam} disabled={saveTeam.isPending}>
                      Save team
                    </Button>
                    <Button type="button" variant="ghost" size="sm" onClick={() => setTeamName(null)}>
                      Cancel
                    </Button>
                  </div>
                )}
                {seats.length === 0 && <p className="text-muted-foreground text-xs">No seats yet.</p>}
                <div className="grid gap-2 xl:grid-cols-2">
                {seats.map((s, i) => (
                  <div key={i} className="space-y-1.5 rounded-md border p-2">
                    <div className="flex items-center gap-2">
                      <Select
                        value={String(s.presetId)}
                        onValueChange={(v) => {
                          const p = presets.find((x) => x.id === Number(v))
                          patchSeat(i, { presetId: Number(v), model: p?.model ?? s.model, effort: p?.effort ?? '' })
                        }}
                      >
                        <SelectTrigger aria-label={`Seat ${i + 1} preset`} className="min-w-0 flex-1">
                          <SelectValue>{presetName(s.presetId)}</SelectValue>
                        </SelectTrigger>
                        <SelectContent>
                          {presets.map((p) => (
                            <SelectItem key={p.id} value={String(p.id)}>
                              {p.name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <Input
                        type="number"
                        min={1}
                        aria-label={`Seat ${i + 1} count`}
                        value={s.count}
                        onChange={(e) => patchSeat(i, { count: Number(e.target.value) })}
                        className="w-16"
                      />
                      <Button type="button" variant="ghost" size="icon" aria-label={`Remove seat ${i + 1}`} onClick={() => setSeats((all) => all.filter((_, j) => j !== i))}>
                        <Trash2 className="size-4" />
                      </Button>
                    </div>
                    <ModelEffortSelect
                      label={`Seat ${i + 1}`}
                      cli={presetCli(s.presetId)}
                      model={s.model}
                      onModelChange={(model) => patchSeat(i, { model })}
                      effort={s.effort ?? ''}
                      onEffortChange={(effort) => patchSeat(i, { effort })}
                    />
                  </div>
                ))}
                </div>
              </div>
            </div>
          )}

          {error && (
            <p role="alert" className="text-destructive text-xs">
              {error}
            </p>
          )}

          </DialogBody>

          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={!task.trim() || create.isPending}>
              Send
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
