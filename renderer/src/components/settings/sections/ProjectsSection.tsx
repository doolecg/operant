import { useState } from 'react'
import { FolderPlus, Pencil, Trash2 } from 'lucide-react'
import { decodeIpcError } from '@shared/ipc'
import type { IdeId } from '@shared/projects'
import type { Crew } from '@shared/types'
import { DeleteCrewDialog, EditCrewDialog } from '@/components/dashboard/Dialogs'
import { Button } from '@/components/ui/button'
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { toast } from '@/lib/toast'
import { useCreateGroup, useCrews, useDeleteGroup, useGroups, useIdes, useMoveToGroup, useRenameGroup, useSaveSettings, useSettings } from '@/lib/queries'
import { CommitInput, Row } from '../parts'

const NONE = 'none'
const failed = (e: unknown) => toast(decodeIpcError(e).message, true)

export function ProjectsSection() {
  const settings = useSettings()
  const save = useSaveSettings()
  const ides = useIdes().data ?? []
  const crews = useCrews().data ?? []
  const groups = useGroups().data ?? []
  const createGroup = useCreateGroup()
  const renameGroup = useRenameGroup()
  const deleteGroup = useDeleteGroup()
  const moveTo = useMoveToGroup()
  const [edit, setEdit] = useState<Crew | null>(null)
  const [remove, setRemove] = useState<Crew | null>(null)
  const s = settings.data
  if (!s) return null

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Open in IDE</CardTitle>
          <CardDescription>The IDE the project menu, the row button and its shortcut open. Detected on this computer.</CardDescription>
        </CardHeader>
        <CardContent className="divide-y">
          <Row label="IDE" htmlFor="ide-default">
            <Select value={s.ide.default} onValueChange={(v) => save.mutate({ ide: { default: v as IdeId } })}>
              <SelectTrigger id="ide-default" className="w-56">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {ides.map((i) => (
                  <SelectItem key={i.id} value={i.id}>
                    {i.name}
                    {i.available ? '' : i.id === 'custom' ? ' (no command set)' : ' (not found)'}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Row>
          <Row label="Custom command" hint="Used when the IDE above is Custom command. The project folder is added at the end." htmlFor="ide-custom">
            <CommitInput
              id="ide-custom"
              className="w-64 font-mono text-xs"
              placeholder="myide --new-window"
              value={s.ide.custom}
              onCommit={(v) => save.mutate({ ide: { custom: v } })}
            />
          </Row>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Groups</CardTitle>
          <CardDescription>Groups only organise the project list. Removing one puts its projects back in the list.</CardDescription>
          <CardAction>
            <Button variant="outline" size="sm" onClick={() => createGroup.mutate([], { onError: failed })}>
              <FolderPlus /> New group
            </Button>
          </CardAction>
        </CardHeader>
        <CardContent className="divide-y">
          {groups.length === 0 && <p className="text-muted-foreground py-3 text-sm">No groups yet.</p>}
          {groups.map((g) => (
            <Row key={g.id} label={`${crews.filter((c) => c.groupId === g.id).length} projects`}>
              <div className="flex items-center gap-2">
                <CommitInput
                  id={`group-${g.id}`}
                  aria-label={`Name of group ${g.name}`}
                  className="w-56"
                  value={g.name}
                  onCommit={(v) => renameGroup.mutate([g.id, v], { onError: failed })}
                />
                <Button variant="ghost" size="icon-sm" aria-label={`Remove group ${g.name}`} onClick={() => deleteGroup.mutate([g.id], { onError: failed })}>
                  <Trash2 />
                </Button>
              </div>
            </Row>
          ))}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Projects</CardTitle>
          <CardDescription>Change a project's name, folder or group, or delete it. Deleting never touches the folder on disk.</CardDescription>
        </CardHeader>
        <CardContent className="divide-y">
          {crews.length === 0 && <p className="text-muted-foreground py-3 text-sm">No projects yet.</p>}
          {crews.map((c) => (
            <div key={c.id} data-testid={`project-row-${c.id}`} className="flex items-center justify-between gap-4 py-3">
              <div className="min-w-0">
                <div className="truncate text-sm">
                  {c.kind !== 'playground' && <span className="text-muted-foreground mr-2 font-mono text-[10px]">PRJ#{c.prjNumber}</span>}
                  {c.name}
                </div>
                <p className="text-muted-foreground truncate font-mono text-xs">{c.folder}</p>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                {c.kind !== 'playground' && <Select value={c.groupId == null ? NONE : String(c.groupId)} onValueChange={(v) => moveTo.mutate([c.id, v === NONE ? null : Number(v)], { onError: failed })}>
                  <SelectTrigger aria-label={`Group of ${c.name}`} className="w-40">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={NONE}>No group</SelectItem>
                    {groups.map((g) => (
                      <SelectItem key={g.id} value={String(g.id)}>
                        {g.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>}
                <Button variant="ghost" size="icon-sm" aria-label={`Edit ${c.name}`} onClick={() => setEdit(c)}>
                  <Pencil />
                </Button>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`Delete ${c.name}`}
                  onClick={() => setRemove(c)}
                >
                  <Trash2 />
                </Button>
              </div>
            </div>
          ))}
        </CardContent>
      </Card>

      {edit && <EditCrewDialog crew={edit} open onOpenChange={(o) => !o && setEdit(null)} />}
      {remove && <DeleteCrewDialog crewId={remove.id} crewName={remove.name} open onOpenChange={(o) => !o && setRemove(null)} />}
    </>
  )
}
