import { useState } from 'react'
import { Copy, Download, Eye, EyeOff, Pencil, Plus, RotateCcw, Trash2, Upload } from 'lucide-react'
import { decodeIpcError } from '@shared/ipc'
import type { Team, TeamImportPreview } from '@shared/types'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import {
  useCreateTeam,
  useDeleteTeam,
  useDuplicateTeam,
  useExportTeams,
  useHideTeam,
  useImportTeams,
  useResetTeam,
  useTeamImportPreview,
  useTeams,
  useUpdateTeam,
} from '@/lib/queries'
import { ConfirmDialog } from '../parts'

interface Form {
  name: string
  rules: string
  description: string
}

const toForm = (t: Team | null): Form => (t ? { name: t.name, rules: t.rules, description: t.description } : { name: '', rules: '', description: '' })

export function TeamDialog({ team, onClose }: { team: Team | null; onClose: () => void }) {
  const create = useCreateTeam()
  const update = useUpdateTeam()
  const [form, setForm] = useState(() => toForm(team))
  const [error, setError] = useState<string | null>(null)
  const set = (patch: Partial<Form>) => setForm((f) => ({ ...f, ...patch }))

  const save = async () => {
    setError(null)
    const name = form.name.trim()
    if (name === '') return setError('Give the team a name.')
    const body = { name, rules: form.rules, description: form.description }
    try {
      if (team) await update.mutateAsync({ id: team.id, patch: body })
      else await create.mutateAsync(body)
      onClose()
    } catch (e) {
      setError(decodeIpcError(e).message)
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent size="lg">
        <DialogHeader>
          <DialogTitle>{team ? `Edit ${team.name}` : 'New team'}</DialogTitle>
          <DialogDescription>
            A team is a name, a description and plain-text rules to hand to an agent as guidance.
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

          <div className="space-y-1.5">
            <Label htmlFor="team-rules" className="text-sm">
              Rules
            </Label>
            <Textarea id="team-rules" className="min-h-24 text-sm" value={form.rules} onChange={(e) => set({ rules: e.target.value })} />
            <p className="text-muted-foreground text-xs">Plain text guidance for this team.</p>
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

// One team in a list: built-ins carry a badge and can be hidden or reset instead of deleted.
export function TeamRow({
  team: t,
  onEdit,
  onDelete,
  onError,
}: {
  team: Team
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
                  {e.name}
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

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Teams</CardTitle>
          <CardDescription>
            Guidance for a group of terminals, as plain text. Nothing starts when a team is chosen. Duplicate a built-in team to change it, or hide it.
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
            <p className="text-muted-foreground text-sm">No teams. Create one to write down guidance for a group of agents.</p>
          ) : (
            <ul className="divide-y rounded-md border">
              {list.map((t) => (
                <TeamRow key={t.id} team={t} onEdit={setEditing} onDelete={setDeleting} onError={(m) => setError(m || null)} />
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
        {editing && <TeamDialog team={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />}
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
          <p>Its description and rules are removed. This cannot be undone.</p>
        </ConfirmDialog>
      </Card>
    </div>
  )
}
