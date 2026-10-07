import { useState } from 'react'
import { Copy, Download, Eye, EyeOff, Pencil, Plus, RotateCcw, Trash2, Upload, X } from 'lucide-react'
import { decodeIpcError } from '@shared/ipc'
import type { ModelTier, Preset, Team, TeamImportPreview, TeamSeat } from '@shared/types'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import {
  useCreateTeam,
  useDeleteTeam,
  useDuplicateTeam,
  useExportTeams,
  useHideTeam,
  useImportTeams,
  usePresets,
  useResetTeam,
  useRunLimit,
  useSetRunLimit,
  useTeamImportPreview,
  useTeams,
  useUpdateTeam,
} from '@/lib/queries'
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
  description: string
}

const toForm = (t: Team | null): Form =>
  t
    ? { name: t.name, seats: t.seats.map((s) => ({ ...s })), ...t.limits, rules: t.rules, description: t.description }
    : { name: '', seats: [], maxWorkers: 0, topTier: '', tokenBudget: 0, rules: '', description: '' }

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
      description: form.description,
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
      <DialogContent size="lg">
        <DialogHeader>
          <DialogTitle>{team ? `Edit ${team.name}` : 'New team'}</DialogTitle>
          <DialogDescription>
            A team is the seats a job's Master may start, with limits and rules. A job keeps a copy, so editing a team later changes nothing
            already sent.
          </DialogDescription>
        </DialogHeader>
        <DialogBody>
          <div className="grid gap-4">
          <div className="space-y-1.5">
            <Label htmlFor="team-name" className="text-sm">
              Name
            </Label>
            <Input id="team-name" value={form.name} maxLength={80} onChange={(e) => set({ name: e.target.value })} />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="team-description" className="text-sm">
              Description
            </Label>
            <Input id="team-description" value={form.description} maxLength={500} onChange={(e) => set({ description: e.target.value })} />
          </div>

          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label className="text-sm">Seats</Label>
              <Button variant="outline" size="sm" onClick={addSeat} disabled={presets.length === 0}>
                <Plus /> Add seat
              </Button>
            </div>
            {form.seats.length === 0 && <p className="text-muted-foreground text-xs">No seats yet.</p>}
            <div className="grid gap-2 xl:grid-cols-2">
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
            </div>
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
        </DialogBody>
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

// One team in a list: built-ins carry a badge and can be hidden or reset instead of deleted.
export function TeamRow({
  team: t,
  presets,
  onEdit,
  onDelete,
  onError,
}: {
  team: Team
  presets: Preset[]
  onEdit: (t: Team) => void
  onDelete: (t: Team) => void
  onError: (message: string) => void
}) {
  const duplicate = useDuplicateTeam()
  const reset = useResetTeam()
  const hide = useHideTeam()
  const exporter = useExportTeams()
  const run = (go: () => Promise<unknown>) => {
    onError('')
    go().catch((e: unknown) => onError(decodeIpcError(e).message))
  }
  return (
    <li className="flex items-center justify-between gap-4 px-3 py-2.5" data-team={t.name}>
      <div className="min-w-0 space-y-0.5">
        <div className="flex items-center gap-2">
          <span className="truncate text-sm font-medium">{t.name}</span>
          {t.builtin && <Badge variant="secondary">Built-in</Badge>}
          {t.builtin && t.modified && <Badge variant="outline">Modified</Badge>}
          {t.hidden && <Badge variant="outline">Hidden</Badge>}
        </div>
        {t.description && <div className="text-muted-foreground truncate text-xs">{t.description}</div>}
        <div className="flex flex-wrap gap-1 pt-0.5">
          {t.seats.length === 0 ? (
            <span className="text-muted-foreground text-xs">No seats</span>
          ) : (
            t.seats.map((s, i) => (
              <Badge key={i} variant="outline" title={`${s.model || 'default model'}${s.effort ? `, ${s.effort}` : ''}`}>
                {s.count} × {presets.find((p) => p.id === s.presetId)?.name ?? 'deleted preset'}
              </Badge>
            ))
          )}
        </div>
        <div className="text-muted-foreground truncate text-xs">{limitText(t)}</div>
      </div>
      <div className="flex shrink-0 gap-1">
        <Button variant="ghost" size="icon-sm" aria-label={`Edit ${t.name}`} title="Edit" onClick={() => onEdit(t)}>
          <Pencil />
        </Button>
        <Button variant="ghost" size="icon-sm" aria-label={`Duplicate ${t.name}`} title="Duplicate" onClick={() => run(() => duplicate.mutateAsync([t.id]))}>
          <Copy />
        </Button>
        <Button variant="ghost" size="icon-sm" aria-label={`Export ${t.name}`} title="Export" onClick={() => run(() => exporter.mutateAsync([t.id]))}>
          <Download />
        </Button>
        {t.builtin && t.modified && (
          <Button variant="ghost" size="icon-sm" aria-label={`Reset ${t.name}`} title="Reset to default" onClick={() => run(() => reset.mutateAsync([t.id]))}>
            <RotateCcw />
          </Button>
        )}
        {t.builtin ? (
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={`${t.hidden ? 'Show' : 'Hide'} ${t.name}`}
            title={t.hidden ? 'Show' : 'Hide'}
            onClick={() => run(() => hide.mutateAsync([t.id, !t.hidden]))}
          >
            {t.hidden ? <Eye /> : <EyeOff />}
          </Button>
        ) : (
          <Button variant="ghost" size="icon-sm" aria-label={`Delete ${t.name}`} title="Delete" onClick={() => onDelete(t)}>
            <Trash2 />
          </Button>
        )}
      </div>
    </li>
  )
}

function ImportDialog({ preview, onClose }: { preview: TeamImportPreview; onClose: () => void }) {
  const run = useImportTeams()
  const [error, setError] = useState<string | null>(null)
  const adds = preview.entries.filter((e) => e.action === 'add').length
  const label = { add: 'Will add', skip: 'Skipped', invalid: 'Refused' } as const
  const go = async () => {
    setError(null)
    try {
      await run.mutateAsync([preview.path])
      onClose()
    } catch (e) {
      setError(decodeIpcError(e).message)
    }
  }
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent size="md">
        <DialogHeader>
          <DialogTitle>Import teams</DialogTitle>
          <DialogDescription>{adds === 0 ? 'Nothing in this file would be added.' : `${adds} team${adds === 1 ? '' : 's'} will be added to yours.`}</DialogDescription>
        </DialogHeader>
        <DialogBody>
          <ul className="divide-y rounded-md border text-sm">
            {preview.entries.map((e, i) => (
              <li key={i} className="flex items-center justify-between gap-3 px-3 py-2">
                <span className="min-w-0 truncate">
                  {e.name} <span className="text-muted-foreground text-xs">{e.seats} seat{e.seats === 1 ? '' : 's'}</span>
                </span>
                <span className={e.action === 'invalid' ? 'text-destructive text-xs' : 'text-muted-foreground text-xs'}>
                  {label[e.action]}
                  {e.reason ? `: ${e.reason}` : ''}
                </span>
              </li>
            ))}
          </ul>
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
          <Button onClick={() => void go()} disabled={adds === 0 || run.isPending}>
            Import {adds} team{adds === 1 ? '' : 's'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export function TeamsSection() {
  const teams = useTeams()
  const presets = usePresets()
  const remove = useDeleteTeam()
  const [editing, setEditing] = useState<Team | 'new' | null>(null)
  const [deleting, setDeleting] = useState<Team | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [showHidden, setShowHidden] = useState(false)
  const [importing, setImporting] = useState<TeamImportPreview | null>(null)
  const exporter = useExportTeams()
  const picker = useTeamImportPreview()

  const pick = async () => {
    setError(null)
    try {
      setImporting((await picker.mutateAsync([])) ?? null)
    } catch (e) {
      setError(decodeIpcError(e).message)
    }
  }

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

  const all = teams.data ?? []
  const hiddenCount = all.filter((t) => t.hidden).length
  const list = showHidden ? all : all.filter((t) => !t.hidden)
  const presetList = presets.data ?? []

  return (
    <div className="space-y-6">
      <QueueCard />
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Teams</CardTitle>
          <CardDescription>
            The seats, limits and rules a job runs with. Built-in teams ship with Operant: duplicate one to make your own, or hide it. Deleting a team leaves jobs
            already sent untouched.
          </CardDescription>
          <CardAction className="flex flex-wrap justify-end gap-2">
            {hiddenCount > 0 && (
              <Button variant="ghost" size="sm" aria-pressed={showHidden} onClick={() => setShowHidden((v) => !v)}>
                {showHidden ? <EyeOff /> : <Eye />} {showHidden ? 'Hide hidden' : `Show hidden (${hiddenCount})`}
              </Button>
            )}
            <Button variant="outline" size="sm" onClick={() => void pick()} disabled={picker.isPending}>
              <Upload /> Import
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setError(null)
                exporter.mutateAsync([]).catch((e: unknown) => setError(decodeIpcError(e).message))
              }}
            >
              <Download /> Export all
            </Button>
            <Button size="sm" onClick={() => setEditing('new')}>
              <Plus /> New team
            </Button>
          </CardAction>
        </CardHeader>
        <CardContent className="space-y-3">
          {teams.isLoading ? (
            <p className="text-muted-foreground text-sm">Loading…</p>
          ) : list.length === 0 ? (
            <p className="text-muted-foreground text-sm">No teams. Create one to give jobs a set of seats.</p>
          ) : (
            <ul className="divide-y rounded-md border">
              {list.map((t) => (
                <TeamRow key={t.id} team={t} presets={presetList} onEdit={setEditing} onDelete={setDeleting} onError={(m) => setError(m || null)} />
              ))}
            </ul>
          )}
          {error && !deleting && (
            <p role="alert" className="text-destructive text-sm">
              {error}
            </p>
          )}
        </CardContent>
        {importing && <ImportDialog preview={importing} onClose={() => setImporting(null)} />}
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
