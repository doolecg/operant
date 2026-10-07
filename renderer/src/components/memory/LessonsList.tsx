import { useMemo, useState } from 'react'
import { Pencil } from 'lucide-react'
import { LEARN_STORES, LESSON_KINDS, type LearnStore, type Lesson, type LessonFilter, type LessonKind } from '@shared/learn'
import type { Crew } from '@shared/types'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Markdown } from '@/components/ui/markdown'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { timeAgo } from '@/lib/format'
import { useEditLesson, useLessons, useMergeLessons, useMoveLesson, useSetLessonStatus } from '@/lib/queries'
import { Empty, ErrorLine, KIND_LABEL, STORE_LABEL, StatusBadge } from './ui'

const csv = (s: string) => s.split(',').map((x) => x.trim()).filter(Boolean)

function EditDialog({ lesson, onClose }: { lesson: Lesson; onClose: () => void }) {
  const edit = useEditLesson()
  const [text, setText] = useState(lesson.text)
  const [kind, setKind] = useState<LessonKind>(lesson.kind)
  const [files, setFiles] = useState(lesson.files.join(', '))
  const [symbols, setSymbols] = useState(lesson.symbols.join(', '))
  const save = () => edit.mutate([lesson.id, { text, kind, files: csv(files), symbols: csv(symbols) }], { onSuccess: onClose })
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Edit lesson {lesson.id}</DialogTitle>
          <DialogDescription>
            Changes reach Operant and the personal memory file. A copy already written to Hindsight stays as it was: Hindsight has no edit call.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1">
            <Label htmlFor="lesson-text">Lesson text</Label>
            <Textarea id="lesson-text" rows={4} value={text} onChange={(e) => setText(e.target.value)} />
          </div>
          <div className="space-y-1">
            <Label htmlFor="lesson-kind">Kind</Label>
            <Select value={kind} onValueChange={(v) => setKind(v as LessonKind)}>
              <SelectTrigger id="lesson-kind" className="w-48">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {LESSON_KINDS.map((k) => (
                  <SelectItem key={k} value={k}>
                    {KIND_LABEL[k]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label htmlFor="lesson-files">Files (comma separated)</Label>
            <Input id="lesson-files" value={files} onChange={(e) => setFiles(e.target.value)} />
          </div>
          <div className="space-y-1">
            <Label htmlFor="lesson-symbols">Symbols (comma separated)</Label>
            <Input id="lesson-symbols" value={symbols} onChange={(e) => setSymbols(e.target.value)} />
          </div>
        </div>
        <ErrorLine error={edit.error} />
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={edit.isPending || !text.trim()} onClick={save}>
            Save lesson
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function DeleteDialog({ lesson, onClose }: { lesson: Lesson; onClose: () => void }) {
  const set = useSetLessonStatus()
  const rejecting = lesson.status === 'pending'
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            {rejecting ? 'Reject' : 'Delete'} lesson {lesson.id}
          </DialogTitle>
          <DialogDescription>&quot;{lesson.text}&quot;</DialogDescription>
        </DialogHeader>
        <ul className="text-muted-foreground list-disc space-y-1 pl-5 text-xs">
          <li>It stops appearing in job briefs and is removed from the personal memory folder.</li>
          <li>
            Taught by {lesson.sourceJobs.length === 0 ? 'no job' : `${lesson.sourceJobs.length} job${lesson.sourceJobs.length === 1 ? '' : 's'}`}; seen {lesson.hits}{' '}
            {lesson.hits === 1 ? 'time' : 'times'}.
          </li>
          {lesson.stores.includes('hindsight') && <li>A copy already in Hindsight cannot be deleted from here.</li>}
        </ul>
        <ErrorLine error={set.error} />
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="destructive" disabled={set.isPending} onClick={() => set.mutate([lesson.id, 'deleted'], { onSuccess: onClose })}>
            {rejecting ? 'Reject lesson' : 'Delete lesson'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function MergeDialog({ lessons, onClose, onDone }: { lessons: Lesson[]; onClose: () => void; onDone: () => void }) {
  const merge = useMergeLessons()
  const [keep, setKeep] = useState(lessons[0]!.id)
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Merge {lessons.length} lessons</DialogTitle>
          <DialogDescription>Pick the lesson to keep. The others are deleted; their files, symbols, jobs and hit counts move onto it.</DialogDescription>
        </DialogHeader>
        <div role="radiogroup" aria-label="Lesson to keep" className="space-y-2">
          {lessons.map((l) => (
            <label key={l.id} className="flex cursor-pointer items-start gap-2 rounded-md border p-2 text-sm">
              <input type="radio" name="keep" checked={keep === l.id} onChange={() => setKeep(l.id)} aria-label={`Keep lesson ${l.id}`} className="mt-1" />
              <span>
                <span className="text-muted-foreground font-mono text-xs">#{l.id}</span> {l.text}
              </span>
            </label>
          ))}
        </div>
        <ErrorLine error={merge.error} />
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={merge.isPending}
            onClick={() =>
              merge.mutate([keep, lessons.map((l) => l.id).filter((i) => i !== keep)], {
                onSuccess: () => (onDone(), onClose()),
              })
            }
          >
            Merge lessons
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function LessonRow({
  lesson,
  crewName,
  selected,
  onSelect,
  onEdit,
  onDelete,
}: {
  lesson: Lesson
  crewName: string
  selected: boolean
  onSelect: (v: boolean) => void
  onEdit: () => void
  onDelete: () => void
}) {
  const setStatus = useSetLessonStatus()
  const move = useMoveLesson()
  const err = setStatus.error ?? move.error
  const targets = LEARN_STORES.filter((s) => !lesson.stores.includes(s))
  return (
    <li className="space-y-2 rounded-md border p-3" data-lesson={lesson.id}>
      <div className="flex items-start gap-3">
        <input type="checkbox" checked={selected} onChange={(e) => onSelect(e.target.checked)} aria-label={`Select lesson ${lesson.id}`} className="mt-1" />
        <div className="min-w-0 flex-1 space-y-1.5">
          <Markdown source={lesson.text} />
          <div className="flex flex-wrap items-center gap-1.5 text-xs">
            <span className="text-muted-foreground font-mono">#{lesson.id}</span>
            <Badge variant="secondary">{KIND_LABEL[lesson.kind]}</Badge>
            <StatusBadge status={lesson.status} />
            {lesson.scope === 'user' && <Badge variant="outline">About you</Badge>}
            {lesson.stores.map((s) => (
              <Badge key={s} variant="outline" className="font-normal">
                {STORE_LABEL[s]}
              </Badge>
            ))}
            <span className="text-muted-foreground">
              {crewName} · {lesson.sourceJobs.map((j) => `JOB#${j}`).join(', ') || 'no job'} · seen {lesson.hits}x · {timeAgo(lesson.updatedAt)}
            </span>
          </div>
          {(lesson.files.length > 0 || lesson.symbols.length > 0) && (
            <p className="text-muted-foreground font-mono text-[11px]">{[...lesson.files, ...lesson.symbols].join('  ')}</p>
          )}
        </div>
      </div>
      <div className="flex flex-wrap items-center justify-end gap-1.5">
        {lesson.status === 'pending' && (
          <Button size="sm" aria-label={`Activate lesson ${lesson.id}`} disabled={setStatus.isPending} onClick={() => setStatus.mutate([lesson.id, 'active'])}>
            Activate
          </Button>
        )}
        {lesson.status === 'stale' && (
          <Button size="sm" variant="outline" aria-label={`Mark lesson ${lesson.id} active again`} disabled={setStatus.isPending} onClick={() => setStatus.mutate([lesson.id, 'active'])}>
            Mark active
          </Button>
        )}
        {lesson.status === 'active' && (
          <Button size="sm" variant="outline" aria-label={`Mark lesson ${lesson.id} stale`} disabled={setStatus.isPending} onClick={() => setStatus.mutate([lesson.id, 'stale'])}>
            Mark stale
          </Button>
        )}
        {lesson.status === 'active' && targets.length > 0 && lesson.stores.length > 0 && (
          <Select value="" onValueChange={(to) => move.mutate([lesson.id, lesson.stores[0]!, to as LearnStore])}>
            <SelectTrigger size="sm" aria-label={`Move lesson ${lesson.id} to another store`} className="w-36">
              <SelectValue placeholder="Move to…" />
            </SelectTrigger>
            <SelectContent>
              {targets.map((s) => (
                <SelectItem key={s} value={s}>
                  {STORE_LABEL[s]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
        <Button size="sm" variant="ghost" aria-label={`Edit lesson ${lesson.id}`} onClick={onEdit}>
          <Pencil /> Edit
        </Button>
        {lesson.status !== 'deleted' && (
          <Button
            size="sm"
            variant="ghost"
            className="text-destructive"
            aria-label={`${lesson.status === 'pending' ? 'Reject' : 'Delete'} lesson ${lesson.id}`}
            onClick={onDelete}
          >
            {lesson.status === 'pending' ? 'Reject' : 'Delete'}
          </Button>
        )}
      </div>
      <ErrorLine error={err} />
    </li>
  )
}

export function LessonsList({ filter, crews }: { filter: LessonFilter; crews: Crew[] }) {
  const lessons = useLessons(filter)
  const [selected, setSelected] = useState<number[]>([])
  const [editing, setEditing] = useState<Lesson | null>(null)
  const [deleting, setDeleting] = useState<Lesson | null>(null)
  const [merging, setMerging] = useState(false)
  const list = useMemo(() => (lessons.data ?? []).filter((l) => filter.status || l.status !== 'deleted'), [lessons.data, filter.status])
  const picked = list.filter((l) => selected.includes(l.id))
  const sameCrew = new Set(picked.map((l) => l.crewId)).size <= 1
  const name = (id: number) => crews.find((c) => c.id === id)?.name ?? `project ${id}`

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <p className="text-muted-foreground text-xs" aria-live="polite">
          {lessons.isPending ? 'Loading…' : `${list.length} ${list.length === 1 ? 'lesson' : 'lessons'}`}
        </p>
        <Button
          size="sm"
          variant="outline"
          disabled={picked.length < 2 || !sameCrew}
          title={sameCrew ? undefined : 'Lessons of different projects cannot be merged'}
          onClick={() => setMerging(true)}
        >
          Merge selected ({picked.length})
        </Button>
      </div>
      <ErrorLine error={lessons.error} />
      {list.length === 0 && !lessons.isPending ? (
        <Empty>No lessons match. They appear here after a finished job is learned from.</Empty>
      ) : (
        <ul className="space-y-2" aria-label="Lessons">
          {list.map((l) => (
            <LessonRow
              key={l.id}
              lesson={l}
              crewName={name(l.crewId)}
              selected={selected.includes(l.id)}
              onSelect={(v) => setSelected((s) => (v ? [...s, l.id] : s.filter((i) => i !== l.id)))}
              onEdit={() => setEditing(l)}
              onDelete={() => setDeleting(l)}
            />
          ))}
        </ul>
      )}
      {editing && <EditDialog key={editing.id} lesson={editing} onClose={() => setEditing(null)} />}
      {deleting && <DeleteDialog lesson={deleting} onClose={() => setDeleting(null)} />}
      {merging && picked.length >= 2 && <MergeDialog lessons={picked} onClose={() => setMerging(false)} onDone={() => setSelected([])} />}
    </div>
  )
}
