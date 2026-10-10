import { useState } from 'react'
import { RECALL_MODES, type RecallMode } from '@shared/aux-settings'
import { decodeIpcError } from '@shared/ipc'
import type { Lesson } from '@shared/learn'
import type { ResetResult } from '@shared/ops'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Textarea } from '@/components/ui/textarea'
import { KIND_LABEL } from '@/components/memory/ui'
import { toast } from '@/lib/toast'
import { useCrews, useLessons, useMemoryDelete, useMemoryDiagnostics, useMemoryEdit, useMemoryExport, useMemoryReset, useSaveSettings, useSettings } from '@/lib/queries'
import { ConfirmDialog, NumberField, Row } from '../parts'

const RECALL_LABEL: Record<RecallMode, string> = { off: 'Off', 'on-demand': 'On demand', 'session-start': 'Session start' }
const RECALL_HINT: Record<RecallMode, string> = {
  off: 'Nothing is recalled.',
  'on-demand': 'Memory is searched when an agent asks for it.',
  'session-start': 'Relevant memory is added when a session starts.',
}

const usd = (n: number) => `$${n.toFixed(n < 1 ? 4 : 2)}`
const fail = (e: unknown) => toast(decodeIpcError(e).message, true)

function LessonRow({ lesson, crewName }: { lesson: Lesson; crewName: string }) {
  const edit = useMemoryEdit()
  const del = useMemoryDelete()
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(lesson.text)
  const [confirm, setConfirm] = useState(false)

  return (
    <li className="space-y-2 py-3">
      {editing ? (
        <>
          <Textarea aria-label="Lesson text" rows={3} value={draft} onChange={(e) => setDraft(e.target.value)} />
          <div className="flex justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={() => (setEditing(false), setDraft(lesson.text))}>
              Cancel
            </Button>
            <Button
              size="sm"
              disabled={edit.isPending || !draft.trim() || draft === lesson.text}
              onClick={() => edit.mutate([lesson.id, { text: draft.trim() }], { onSuccess: () => setEditing(false), onError: fail })}
            >
              Save
            </Button>
          </div>
        </>
      ) : (
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 space-y-1">
            <p className="text-sm">{lesson.text}</p>
            <div className="flex flex-wrap items-center gap-2 text-xs">
              <Badge variant="secondary">{KIND_LABEL[lesson.kind]}</Badge>
              <span className="text-muted-foreground">
                {crewName} · {lesson.status}
              </span>
            </div>
          </div>
          <div className="flex shrink-0 gap-1.5">
            <Button variant="outline" size="sm" onClick={() => (setDraft(lesson.text), setEditing(true))}>
              Edit
            </Button>
            <Button variant="outline" size="sm" onClick={() => setConfirm(true)}>
              Delete
            </Button>
          </div>
        </div>
      )}
      <ConfirmDialog
        open={confirm}
        title="Delete this lesson?"
        confirmLabel="Delete"
        busy={del.isPending}
        onClose={() => setConfirm(false)}
        onConfirm={() => del.mutate([lesson.id], { onSuccess: () => setConfirm(false), onError: fail })}
      >
        <p>{lesson.text}</p>
      </ConfirmDialog>
    </li>
  )
}

export function MemorySection() {
  const settings = useSettings()
  const save = useSaveSettings()
  const diag = useMemoryDiagnostics()
  const crews = useCrews()
  const lessons = useLessons({})
  const exp = useMemoryExport()
  const reset = useMemoryReset()
  const [scope, setScope] = useState<string>('soul')
  const [confirm, setConfirm] = useState(false)
  const [result, setResult] = useState<ResetResult | null>(null)
  const s = settings.data
  if (!s) return null
  const m = s.memory
  const d = diag.data
  const crewList = crews.data ?? []
  const crewName = (id: number) => crewList.find((c) => c.id === id)?.name ?? `project ${id}`
  const list = (lessons.data ?? []).filter((l) => l.status !== 'deleted')
  const setMem = (patch: Partial<typeof m>) => save.mutate({ memory: patch }, { onError: fail })

  const doExport = () =>
    exp.mutate([], {
      onError: fail,
      onSuccess: (r) => {
        const url = URL.createObjectURL(new Blob([r.text], { type: 'text/plain' }))
        const a = document.createElement('a')
        a.href = url
        a.download = r.filename
        a.click()
        URL.revokeObjectURL(url)
      },
    })

  const scopeLabel = scope === 'soul' ? 'the Soul Bank' : scope === 'all' ? 'the Soul Bank and every project bank' : `the memory of ${crewName(Number(scope))}`
  const doReset = () =>
    reset.mutate(
      [scope === 'soul' || scope === 'all' ? { scope, confirm: true } : { scope: 'project', crewId: Number(scope), confirm: true }],
      {
        onError: fail,
        onSuccess: (r) => {
          setResult(r)
          setConfirm(false)
        },
      },
    )

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Memory provider</CardTitle>
          <CardDescription>The memory server and how much of it each bank holds.</CardDescription>
        </CardHeader>
        <CardContent className="divide-y">
          {d ? (
            <>
              <Row label="Hindsight" hint={d.hindsight.detail || undefined}>
                <Badge variant={d.hindsight.state === 'running' ? 'secondary' : 'outline'}>{d.hindsight.state}</Badge>
              </Row>
              <Row label="Banks">
                <span className="font-mono text-xs">{d.hindsight.banks || 'none'}</span>
              </Row>
              <Row label="Learn mode">
                <span className="text-sm">{d.learnMode}</span>
              </Row>
              {d.banks.map((b) => (
                <Row key={b.bank} label={b.name} hint={b.hindsightError || undefined}>
                  <span className="text-muted-foreground text-xs tabular-nums">
                    {b.lessons} lessons · {b.hindsightEntries == null ? 'Hindsight unavailable' : `${b.hindsightEntries} Hindsight entries`}
                  </span>
                </Row>
              ))}
            </>
          ) : (
            <p className="text-muted-foreground py-3 text-xs">{diag.error ? decodeIpcError(diag.error).message : 'Loading…'}</p>
          )}
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Recall</CardTitle>
          <CardDescription>What memory agents get back and how much of it.</CardDescription>
        </CardHeader>
        <CardContent className="divide-y">
          <Row label="Recall mode" hint={RECALL_HINT[m.recallMode]} htmlFor="mem-recall">
            <Select value={m.recallMode} onValueChange={(v) => setMem({ recallMode: v as RecallMode })}>
              <SelectTrigger id="mem-recall" className="w-44">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {RECALL_MODES.map((r) => (
                  <SelectItem key={r} value={r}>
                    {RECALL_LABEL[r]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Row>
          <Row label="Entries per recall" hint="1 to 50." htmlFor="mem-topk">
            <NumberField id="mem-topk" value={m.topK} min={1} max={50} onCommit={(n) => setMem({ topK: n })} />
          </Row>
          <Row label="Token limit" hint="100 to 20000 tokens per recall." htmlFor="mem-tokens">
            <NumberField id="mem-tokens" value={m.maxTokens} min={100} max={20000} onCommit={(n) => setMem({ maxTokens: n })} />
          </Row>
          <Row label="Include the Soul Bank" hint="Facts about you, shared across projects." htmlFor="mem-soul">
            <Switch id="mem-soul" checked={m.includeSoul} onCheckedChange={(v) => setMem({ includeSoul: v })} />
          </Row>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Lessons</CardTitle>
          <CardDescription>Edit or delete what was learned. {list.length} {list.length === 1 ? 'lesson' : 'lessons'}.</CardDescription>
        </CardHeader>
        <CardContent>
          {list.length === 0 ? (
            <p className="text-muted-foreground py-3 text-xs">{lessons.isPending ? 'Loading…' : 'No lessons yet.'}</p>
          ) : (
            <ul className="divide-y max-h-96 overflow-auto" aria-label="Lessons">
              {list.map((l) => (
                <LessonRow key={l.id} lesson={l} crewName={crewName(l.crewId)} />
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Export and reset</CardTitle>
          <CardDescription>Keep a copy of the memory, or wipe it.</CardDescription>
        </CardHeader>
        <CardContent className="divide-y">
          <Row label="Export" hint="Saves every lesson as a text file.">
            <Button variant="outline" size="sm" disabled={exp.isPending} onClick={doExport}>
              {exp.isPending ? 'Exporting…' : 'Export'}
            </Button>
          </Row>
          <Row label="Reset" hint="Deletes the lessons and the Hindsight bank. This cannot be undone.">
            <div className="flex items-center gap-2">
              <Select value={scope} onValueChange={setScope}>
                <SelectTrigger aria-label="Reset scope" className="w-52">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="soul">Soul Bank</SelectItem>
                  {crewList.map((c) => (
                    <SelectItem key={c.id} value={String(c.id)}>
                      Project: {c.name}
                    </SelectItem>
                  ))}
                  <SelectItem value="all">Everything</SelectItem>
                </SelectContent>
              </Select>
              <Button variant="destructive" size="sm" onClick={() => (setResult(null), setConfirm(true))}>
                Reset
              </Button>
            </div>
          </Row>
          {result && (
            <ul className="space-y-1 py-3 text-xs" aria-label="Reset result">
              {result.steps.map((st, i) => (
                <li key={i} className={st.ok ? 'text-muted-foreground' : 'text-destructive'}>
                  {st.target}: {st.ok ? 'done' : st.error}
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
      <ConfirmDialog open={confirm} title="Reset memory?" confirmLabel="Reset" busy={reset.isPending} onClose={() => setConfirm(false)} onConfirm={doReset}>
        <p>This permanently deletes {scopeLabel}: its lessons and its Hindsight entries.</p>
      </ConfirmDialog>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Diagnostics</CardTitle>
          <CardDescription>The recall settings in force, the last learn run and today's spend.</CardDescription>
        </CardHeader>
        <CardContent className="divide-y">
          {d && (
            <>
              <Row label="Recall in force">
                <span className="text-xs">
                  {RECALL_LABEL[d.recall.recallMode]} · top {d.recall.topK} · {d.recall.maxTokens} tokens · Soul {d.recall.includeSoul ? 'included' : 'excluded'}
                </span>
              </Row>
              <Row label="Last learn run" hint={d.lastRun?.error || undefined}>
                <span className="text-muted-foreground text-xs">
                  {d.lastRun
                    ? `${new Date(d.lastRun.at).toLocaleString()} · ${d.lastRun.extracted} extracted, ${d.lastRun.written} written, ${d.lastRun.merged} merged, ${d.lastRun.queued} queued${d.lastRun.cli ? ` · ${d.lastRun.cli}${d.lastRun.model ? ` ${d.lastRun.model}` : ''}` : ''}`
                    : 'None yet'}
                </span>
              </Row>
              <Row label="Spend today" hint={d.spend.blocked ?? undefined}>
                <span className="text-xs tabular-nums">
                  {d.spend.total.calls} calls · {d.spend.total.tokens.toLocaleString()} tokens · {usd(d.spend.total.usd)}
                  {d.spend.label ? ` · ${d.spend.label}` : ''}
                </span>
              </Row>
              {d.spend.lastError && (
                <p role="alert" className="text-destructive py-3 text-xs">
                  Last error: {d.spend.lastError}
                </p>
              )}
            </>
          )}
        </CardContent>
      </Card>
    </>
  )
}
