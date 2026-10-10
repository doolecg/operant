import { useState } from 'react'
import { Pencil } from 'lucide-react'
import type { SkillDraft } from '@shared/learn'
import type { Crew } from '@shared/types'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { timeAgo } from '@/lib/format'
import { useApproveDraft, useDeleteDraft, useDrafts, useEditDraft, useRejectDraft } from '@/lib/queries'
import { Empty, ErrorLine } from './ui'

function EditDraftDialog({ draft, onClose }: { draft: SkillDraft; onClose: () => void }) {
  const edit = useEditDraft()
  const [name, setName] = useState(draft.name)
  const [body, setBody] = useState(draft.body)
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent size="lg">
        <DialogHeader>
          <DialogTitle>Edit skill draft {draft.id}</DialogTitle>
          <DialogDescription>Nothing is installed until you approve the draft.</DialogDescription>
        </DialogHeader>
        <DialogBody>
          <div className="space-y-3">
          <div className="space-y-1">
            <Label htmlFor="draft-name">Skill name</Label>
            <Input id="draft-name" value={name} onChange={(e) => setName(e.target.value)} className="font-mono" />
            <p className="text-muted-foreground text-xs">Lowercase letters, digits and dashes.</p>
          </div>
          <div className="space-y-1">
            <Label htmlFor="draft-body">SKILL.md</Label>
            <Textarea id="draft-body" rows={12} value={body} onChange={(e) => setBody(e.target.value)} className="font-mono text-xs" />
          </div>
        </div>
        <ErrorLine error={edit.error} />
        </DialogBody>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={edit.isPending} onClick={() => edit.mutate([draft.id, { name, body }], { onSuccess: onClose })}>
            Save draft
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function DeleteDraftDialog({ draft, onClose }: { draft: SkillDraft; onClose: () => void }) {
  const del = useDeleteDraft()
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent size="sm">
        <DialogHeader>
          <DialogTitle>Delete skill draft {draft.id}</DialogTitle>
          <DialogDescription>
            Delete the draft &quot;{draft.name}&quot; ({draft.status})?
            {draft.installedPath ? ' The installed skill file is not touched.' : ''}
          </DialogDescription>
        </DialogHeader>
        <DialogBody>
          <ErrorLine error={del.error} />
        </DialogBody>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="destructive" disabled={del.isPending} onClick={() => del.mutate([draft.id], { onSuccess: onClose })}>
            Delete draft
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function DraftRow({ draft, crewName, onEdit, onDelete }: { draft: SkillDraft; crewName: string; onEdit: () => void; onDelete: () => void }) {
  const approve = useApproveDraft()
  const reject = useRejectDraft()
  const pending = draft.status === 'pending'
  return (
    <li className="space-y-2 rounded-md border p-3" data-draft={draft.id}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-sm">{draft.name}</span>
        <Badge variant={pending ? 'secondary' : 'outline'}>{draft.status}</Badge>
        <span className="text-muted-foreground text-xs">
          {crewName} · {draft.sourceJobs.length > 0 ? `${draft.sourceJobs.length} source${draft.sourceJobs.length === 1 ? '' : 's'} · ` : ''}{timeAgo(draft.updatedAt)}
        </span>
      </div>
      <pre className="bg-muted/40 max-h-40 overflow-auto rounded-md p-2 font-mono text-[11px] whitespace-pre-wrap">{draft.body}</pre>
      {draft.installedPath && <p className="text-muted-foreground font-mono text-[11px]">Installed at {draft.installedPath}</p>}
      <div className="flex flex-wrap items-center justify-end gap-1.5">
        {pending && (
          <>
            <Button size="sm" aria-label={`Approve skill draft ${draft.id}`} disabled={approve.isPending} onClick={() => approve.mutate([draft.id])}>
              Approve and install
            </Button>
            <Button size="sm" variant="outline" aria-label={`Reject skill draft ${draft.id}`} disabled={reject.isPending} onClick={() => reject.mutate([draft.id])}>
              Reject
            </Button>
            <Button size="sm" variant="ghost" aria-label={`Edit skill draft ${draft.id}`} onClick={onEdit}>
              <Pencil /> Edit
            </Button>
          </>
        )}
        <Button size="sm" variant="ghost" className="text-destructive" aria-label={`Delete skill draft ${draft.id}`} onClick={onDelete}>
          Delete
        </Button>
      </div>
      <ErrorLine error={approve.error ?? reject.error} />
    </li>
  )
}

export function DraftsList({ crewId, crews }: { crewId?: number; crews: Crew[] }) {
  const drafts = useDrafts(crewId)
  const [editing, setEditing] = useState<SkillDraft | null>(null)
  const [deleting, setDeleting] = useState<SkillDraft | null>(null)
  const list = drafts.data ?? []
  return (
    <div className="space-y-3">
      <p className="text-muted-foreground text-xs">
        Drafted from procedures that repeated. A skill is installed into the project only when you click Approve and install.
      </p>
      <ErrorLine error={drafts.error} />
      {list.length === 0 && !drafts.isPending ? (
        <Empty>No skill drafts yet. One appears when a procedure repeats across sessions.</Empty>
      ) : (
        <ul className="space-y-2" aria-label="Skill drafts">
          {list.map((d) => (
            <DraftRow
              key={d.id}
              draft={d}
              crewName={crews.find((c) => c.id === d.crewId)?.name ?? `project ${d.crewId}`}
              onEdit={() => setEditing(d)}
              onDelete={() => setDeleting(d)}
            />
          ))}
        </ul>
      )}
      {editing && <EditDraftDialog key={editing.id} draft={editing} onClose={() => setEditing(null)} />}
      {deleting && <DeleteDraftDialog draft={deleting} onClose={() => setDeleting(null)} />}
    </div>
  )
}
