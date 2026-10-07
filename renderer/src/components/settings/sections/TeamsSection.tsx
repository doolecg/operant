import { useState } from 'react'
import { Pencil, Plus, Trash2, X } from 'lucide-react'
import { decodeIpcError } from '@shared/ipc'
import type { ModelTier, Preset, Team, TeamSeat } from '@shared/types'
import { Button } from '@/components/ui/button'
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { useCreateTeam, useDeleteTeam, usePresets, useRunLimit, useSetRunLimit, useTeams, useUpdateTeam } from '@/lib/queries'
import { ModelEffortSelect } from '@/components/jobs/ModelEffortSelect'
import { ConfirmDialog, NumberField, Row } from '../parts'

const TIERS: Array<{ id: ModelTier | 'any'; label: string }> = [
  { id: 'any', label: 'Any model' },
  { id: 'haiku', label: 'Haiku' },
  { id: 'sonnet', label: 'Sonnet' },
  { id: 'opus', label: 'Opus' },
]

function QueueCard() {
  const limit = useRunLimit()
  const save = useSetRunLimit()
  const [error, setError] = useState<string | null>(null)
  const commit = async (n: number) => {
    setError(null)
    try {
      await save.mutateAsync(n)
    } catch (e) {
      setError(decodeIpcError(e).message)
    }
  }
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Job queue</CardTitle>
        <CardDescription>Jobs beyond the limit wait in the queue until one finishes.</CardDescription>
      </CardHeader>
      <CardContent>
        <Row label="Jobs running at once" hint="From 1 to 10." htmlFor="run-limit">
          {limit.data == null ? (
            <span className="text-muted-foreground text-sm">Loading…</span>
          ) : (
            <NumberField id="run-limit" value={limit.data} min={1} max={10} onCommit={(n) => void commit(n)} />
          )}
        </Row>
        {error && (
          <p role="alert" className="text-destructive text-sm">
            {error}
          </p>
        )}
      </CardContent>
    </Card>
  )
}

interface Form {
  name: string
  seats: TeamSeat[]
  maxWorkers: number
  topTier: ModelTier | ''
  tokenBudget: number
  rules: string
}

const toForm = (t: Team | null): Form =>
  t
    ? { name: t.name, seats: t.seats.map((s) => ({ ...s })), ...t.limits, rules: t.rules }
    : { name: '', seats: [], maxWorkers: 0, topTier: '', tokenBudget: 0, rules: '' }

const whole = (v: string, min: number) => Math.max(min, Math.round(Number(v) || 0))

export function TeamDialog({ team, presets, onClose }: { team: Team | null; presets: Preset[]; onClose: () => void }) {
  const create = useCreateTeam()
  const update = useUpdateTeam()
  const [form, setForm] = useState(() => toForm(team))
  const [error, setError] = useState<string | null>(null)
  const set = (patch: Partial<Form>) => setForm((f) => ({ ...f, ...patch }))
  const setSeat = (i: number, patch: Partial<TeamSeat>) => set({ seats: form.seats.map((s, j) => (j === i ? { ...s, ...patch } : s)) })

  const save = async () => {
    setError(null)
    const name = form.name.trim()
    if (name === '') return setError('Give the team a name.')
    const body = {
      name,
      seats: form.seats.map((s) => ({ ...s, model: s.model.trim() })),
      limits: { maxWorkers: form.maxWorkers, topTier: form.topTier, tokenBudget: form.tokenBudget },
      rules: form.rules,
    }
    try {
      if (team) await update.mutateAsync({ id: team.id, patch: body })
      else await create.mutateAsync(body)
      onClose()
    } catch (e) {
      setError(decodeIpcError(e).message)
    }
  }

  const addSeat = () => {
    const first = presets[0]
    if (first) set({ seats: [...form.seats, { presetId: first.id, count: 1, model: first.model, effort: first.effort }] })
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{team ? `Edit ${team.name}` : 'New team'}</DialogTitle>
          <DialogDescription>
            A team is the seats a job's Master may start, with limits and rules. A job keeps a copy, so editing a team later changes nothing
            already sent.
          </DialogDescription>
        </DialogHeader>
        <div className="grid max-h-[62vh] gap-4 overflow-y-auto py-1 pr-2">
          <div className="space-y-1.5">
            <Label htmlFor="team-name" className="text-sm">
              Name
            </Label>
            <Input id="team-name" value={form.name} maxLength={80} onChange={(e) => set({ name: e.target.value })} />
          </div>

          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label className="text-sm">Seats</Label>
              <Button variant="outline" size="sm" onClick={addSeat} disabled={presets.length === 0}>
                <Plus /> Add seat
              </Button>
            </div>
            {form.seats.length === 0 && <p className="text-muted-foreground text-xs">No seats yet.</p>}
            {form.seats.map((s, i) => (
              <div key={i} className="space-y-1.5 rounded-md border p-2">
              <div className="flex items-center gap-2">
                <Select
                  value={String(s.presetId)}
                  onValueChange={(v) => setSeat(i, { presetId: Number(v), model: presets.find((p) => p.id === Number(v))?.model ?? s.model, effort: presets.find((p) => p.id === Number(v))?.effort ?? '' })}
                >
                  <SelectTrigger aria-label={`Seat ${i + 1} preset`} className="min-w-0 flex-1">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {presets.map((p) => (
                      <SelectItem key={p.id} value={String(p.id)}>
                        {p.name}
                      </SelectItem>
                    ))}
                    {!presets.some((p) => p.id === s.presetId) && <SelectItem value={String(s.presetId)}>Deleted preset</SelectItem>}
                  </SelectContent>
                </Select>
                <Input
                  aria-label={`Seat ${i + 1} count`}
                  type="number"
                  min={1}
                  max={100}
                  className="w-20 tabular-nums"
                  value={s.count}
                  onChange={(e) => setSeat(i, { count: whole(e.target.value, 1) })}
                />
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`Remove seat ${i + 1}`}
                  title="Remove seat"
                  onClick={() => set({ seats: form.seats.filter((_, j) => j !== i) })}
                >
                  <X />
                </Button>
              </div>
              <ModelEffortSelect
                label={`Seat ${i + 1}`}
                cli={presets.find((p) => p.id === s.presetId)?.agent === 'opencode' ? 'opencode' : 'claude'}
                model={s.model}
                onModelChange={(model) => setSeat(i, { model })}
                effort={s.effort ?? ''}
                onEffortChange={(effort) => setSeat(i, { effort })}
              />
              </div>
            ))}
            {form.seats.length > 0 && <p className="text-muted-foreground text-xs">Preset, how many, and the model each runs.</p>}
          </div>

          <div className="grid gap-4 sm:grid-cols-3">
            <div className="space-y-1.5">
              <Label htmlFor="team-max" className="text-sm">
                Max workers
              </Label>
              <Input
                id="team-max"
                type="number"
                min={0}
                max={1000}
                className="tabular-nums"
                value={form.maxWorkers}
                onChange={(e) => set({ maxWorkers: whole(e.target.value, 0) })}
              />
              <p className="text-muted-foreground text-xs">0 = no limit.</p>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="team-tier" className="text-sm">
                Top model tier
              </Label>
              <Select value={form.topTier || 'any'} onValueChange={(v) => set({ topTier: v === 'any' ? '' : (v as ModelTier) })}>
                <SelectTrigger id="team-tier" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {TIERS.map((t) => (
                    <SelectItem key={t.id} value={t.id}>
                      {t.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="team-budget" className="text-sm">
                Token budget
              </Label>
              <Input
                id="team-budget"
                type="number"
                min={0}
                step={10000}
                className="tabular-nums"
                value={form.tokenBudget}
                onChange={(e) => set({ tokenBudget: whole(e.target.value, 0) })}
              />
              <p className="text-muted-foreground text-xs">Per job; 0 = no limit.</p>
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="team-rules" className="text-sm">
              Rules
            </Label>
            <Textarea id="team-rules" className="min-h-24 text-sm" value={form.rules} onChange={(e) => set({ rules: e.target.value })} />
            <p className="text-muted-foreground text-xs">Plain text added to the Master's brief for every job on this team.</p>
          </div>
        </div>
        {error && (
          <p role="alert" className="text-destructive text-sm">
            {error}
          </p>
        )}
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={() => void save()} disabled={create.isPending || update.isPending}>
            {team ? 'Save team' : 'Create team'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export const seatText = (t: Team, presets: Preset[]) =>
  t.seats.length === 0
    ? 'No seats'
    : t.seats.map((s) => `${s.count} × ${presets.find((p) => p.id === s.presetId)?.name ?? 'deleted preset'} (${s.model}${s.effort ? `, ${s.effort}` : ''})`).join(', ')

export const limitText = (t: Team) =>
  [
    t.limits.maxWorkers > 0 && `max ${t.limits.maxWorkers} workers`,
    t.limits.topTier && `up to ${t.limits.topTier}`,
    t.limits.tokenBudget > 0 && `${t.limits.tokenBudget.toLocaleString()} tokens`,
  ]
    .filter(Boolean)
    .join(' · ') || 'No limits'

export function TeamsSection() {
  const teams = useTeams()
  const presets = usePresets()
  const remove = useDeleteTeam()
  const [editing, setEditing] = useState<Team | 'new' | null>(null)
  const [deleting, setDeleting] = useState<Team | null>(null)
  const [error, setError] = useState<string | null>(null)

  const doDelete = async () => {
    if (!deleting) return
    setError(null)
    try {
      await remove.mutateAsync(deleting.id)
      setDeleting(null)
    } catch (e) {
      setError(decodeIpcError(e).message)
    }
  }

  const list = teams.data ?? []
  const presetList = presets.data ?? []

  return (
    <div className="space-y-6">
      <QueueCard />
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Teams</CardTitle>
          <CardDescription>The seats, limits and rules a job runs with. Deleting a team leaves jobs already sent untouched.</CardDescription>
          <CardAction>
            <Button size="sm" onClick={() => setEditing('new')}>
              <Plus /> New team
            </Button>
          </CardAction>
        </CardHeader>
        <CardContent className="space-y-3">
          {teams.isLoading ? (
            <p className="text-muted-foreground text-sm">Loading…</p>
          ) : list.length === 0 ? (
            <p className="text-muted-foreground text-sm">No teams. Create one to give jobs a crew of seats.</p>
          ) : (
            <ul className="divide-y rounded-md border">
              {list.map((t) => (
                <li key={t.id} className="flex items-center justify-between gap-4 px-3 py-2.5">
                  <div className="min-w-0">
                    <div className="truncate text-sm font-medium">{t.name}</div>
                    <div className="text-muted-foreground truncate text-xs">{seatText(t, presetList)}</div>
                    <div className="text-muted-foreground truncate text-xs">{limitText(t)}</div>
                  </div>
                  <div className="flex shrink-0 gap-1">
                    <Button variant="ghost" size="icon-sm" aria-label={`Edit ${t.name}`} title="Edit" onClick={() => setEditing(t)}>
                      <Pencil />
                    </Button>
                    <Button variant="ghost" size="icon-sm" aria-label={`Delete ${t.name}`} title="Delete" onClick={() => setDeleting(t)}>
                      <Trash2 />
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
        {editing && <TeamDialog team={editing === 'new' ? null : editing} presets={presetList} onClose={() => setEditing(null)} />}
        <ConfirmDialog
          open={deleting != null}
          title={`Delete ${deleting?.name}?`}
          confirmLabel="Delete team"
          busy={remove.isPending}
          error={error}
          onConfirm={() => void doDelete()}
          onClose={() => {
            setDeleting(null)
            setError(null)
          }}
        >
          <p>Its seats, limits and rules are removed. Jobs already sent keep their own copy. This cannot be undone.</p>
        </ConfirmDialog>
      </Card>
    </div>
  )
}
