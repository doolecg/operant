import { useState } from 'react'
import { LESSON_KINDS, type LessonFilter, type LessonKind, type LessonStatus, type LearnStore, LEARN_STORES } from '@shared/learn'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { useCrews, useDrafts, useHindsightEntries, useLearnStatus, useMemoryFiles } from '@/lib/queries'
import { DraftsList } from './DraftsList'
import { LearningStatusPanel } from './LearningStatusPanel'
import { LessonsList } from './LessonsList'
import { Empty, ErrorLine, KIND_LABEL, STATUS_LABEL, STORE_LABEL } from './ui'

const ALL = 'all'
type Tab = 'lessons' | 'hindsight' | 'codegraph' | 'memory' | 'drafts'

function Filter({ label, value, onChange, options }: { label: string; value: string; onChange: (v: string) => void; options: Array<[string, string]> }) {
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger size="sm" aria-label={label} className="w-40">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {options.map(([v, l]) => (
          <SelectItem key={v} value={v}>
            {l}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

function HindsightTab({ crewId, search }: { crewId: number | null; search: string }) {
  const entries = useHindsightEntries(crewId, search, true)
  const r = entries.data
  return (
    <div className="space-y-3">
      <p className="text-muted-foreground rounded-md border border-dashed p-3 text-xs">
        Entries already written to Hindsight cannot be edited or deleted from here: Hindsight offers no call for it. Editing or deleting a lesson here changes only
        Operant&apos;s record and the personal memory file.
      </p>
      {entries.isPending && crewId != null && <p className="text-muted-foreground text-xs">Asking Hindsight…</p>}
      {crewId == null && <Empty>Pick a project to read its Hindsight entries.</Empty>}
      {r && !r.ok && <ErrorLine error={`Hindsight did not answer: ${r.error}`} />}
      <ErrorLine error={entries.error} />
      {r?.ok && (r.items.length === 0 ? <Empty>Hindsight has no matching entries for this project.</Empty> : (
        <ul className="space-y-2" aria-label="Hindsight entries">
          {r.items.map((t, i) => (
            <li key={i} className="rounded-md border p-3 text-sm whitespace-pre-wrap">
              {t}
            </li>
          ))}
        </ul>
      ))}
    </div>
  )
}

function MemoryTab({ crewId, search }: { crewId: number | null; search: string }) {
  const files = useMemoryFiles(crewId)
  const q = search.trim().toLowerCase()
  const list = (files.data ?? []).filter((f) => !q || `${f.name} ${f.description} ${f.body}`.toLowerCase().includes(q))
  return (
    <div className="space-y-3">
      <p className="text-muted-foreground text-xs">
        The project&apos;s personal memory files. Files Operant wrote (operant_lesson_N) change through their lesson on the Lessons tab; the rest are yours and are shown
        read-only.
      </p>
      <ErrorLine error={files.error} />
      {crewId == null ? (
        <Empty>Pick a project to read its memory files.</Empty>
      ) : list.length === 0 && !files.isPending ? (
        <Empty>No personal memory files match.</Empty>
      ) : (
        <ul className="space-y-2" aria-label="Personal memory files">
          {list.map((f) => (
            <li key={f.file} className="space-y-1 rounded-md border p-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-medium">{f.name || f.file}</span>
                <Badge variant="outline">{f.type || 'note'}</Badge>
                <span className="text-muted-foreground font-mono text-[11px]">{f.file}</span>
              </div>
              {f.description && <p className="text-muted-foreground text-xs">{f.description}</p>}
              <p className="text-sm whitespace-pre-wrap">{f.body}</p>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

// Everything Operant remembers, by store, with the learning status on top.
export function MemoryPage({ crewId }: { crewId: number | null }) {
  const crews = useCrews()
  const [tab, setTab] = useState<Tab>('lessons')
  const [search, setSearch] = useState('')
  const [project, setProject] = useState<string>('current')
  const [kind, setKind] = useState<string>(ALL)
  const [status, setStatus] = useState<string>(ALL)
  const [store, setStore] = useState<string>(ALL)
  const learn = useLearnStatus()
  const drafts = useDrafts()

  const filterCrew = project === 'current' ? crewId : project === ALL ? null : Number(project)
  const filter: LessonFilter = {
    ...(filterCrew != null ? { crewId: filterCrew } : {}),
    ...(kind !== ALL ? { kind: kind as LessonKind } : {}),
    ...(status !== ALL ? { status: status as LessonStatus } : {}),
    ...(tab === 'codegraph' ? { store: 'codegraph' as const } : store !== ALL ? { store: store as LearnStore } : {}),
    ...(search.trim() ? { search: search.trim() } : {}),
  }
  const readCrew = filterCrew ?? crewId
  const pendingDrafts = (drafts.data ?? []).filter((d) => d.status === 'pending').length

  return (
    <ScrollArea className="h-full" aria-label="Memory Manager">
      <div className="mx-auto max-w-[96rem] space-y-5 p-6">
        <div>
          <h2 className="text-xl font-semibold">Memory</h2>
          <p className="text-muted-foreground text-sm">Everything Operant has learned from your sessions, in each place it is kept.</p>
        </div>

        <LearningStatusPanel crewId={crewId} onShowDrafts={() => setTab('drafts')} />

        <div className="flex flex-wrap items-center gap-2" role="search" aria-label="Memory filters">
          <Input aria-label="Search memory" placeholder="Search text, files or symbols" value={search} onChange={(e) => setSearch(e.target.value)} className="h-8 w-64" />
          <Filter
            label="Project"
            value={project}
            onChange={setProject}
            options={[['current', 'This project'], [ALL, 'All projects'], ...(crews.data ?? []).map((c): [string, string] => [String(c.id), c.name])]}
          />
          <Filter label="Kind" value={kind} onChange={setKind} options={[[ALL, 'Any kind'], ...LESSON_KINDS.map((k): [string, string] => [k, KIND_LABEL[k]])]} />
          <Filter
            label="Status"
            value={status}
            onChange={setStatus}
            options={[[ALL, 'Any status'], ...(Object.keys(STATUS_LABEL) as LessonStatus[]).map((s): [string, string] => [s, STATUS_LABEL[s]])]}
          />
          {tab === 'lessons' && (
            <Filter label="Store" value={store} onChange={setStore} options={[[ALL, 'Any store'], ...LEARN_STORES.map((s): [string, string] => [s, STORE_LABEL[s]])]} />
          )}
        </div>

        <Tabs value={tab} onValueChange={(v) => setTab(v as Tab)}>
          <TabsList>
            <TabsTrigger value="lessons">Lessons{learn.data ? ` (${learn.data.totals.active + learn.data.totals.stale + learn.data.totals.pending})` : ''}</TabsTrigger>
            <TabsTrigger value="hindsight">Hindsight</TabsTrigger>
            <TabsTrigger value="codegraph">CodeGraph notes</TabsTrigger>
            <TabsTrigger value="memory">Personal memory</TabsTrigger>
            <TabsTrigger value="drafts">Skill drafts{pendingDrafts ? ` (${pendingDrafts})` : ''}</TabsTrigger>
          </TabsList>
          <TabsContent value="lessons">{tab === 'lessons' && <LessonsList filter={filter} crews={crews.data ?? []} />}</TabsContent>
          <TabsContent value="hindsight">{tab === 'hindsight' && <HindsightTab crewId={readCrew} search={search} />}</TabsContent>
          <TabsContent value="codegraph">
            {tab === 'codegraph' && (
              <div className="space-y-3">
                <p className="text-muted-foreground text-xs">
                  CodeGraph has no notes API, so these notes live in Operant, tagged to the files and symbols they name.
                </p>
                <LessonsList filter={filter} crews={crews.data ?? []} />
              </div>
            )}
          </TabsContent>
          <TabsContent value="memory">{tab === 'memory' && <MemoryTab crewId={readCrew} search={search} />}</TabsContent>
          <TabsContent value="drafts">{tab === 'drafts' && <DraftsList crewId={filterCrew ?? undefined} crews={crews.data ?? []} />}</TabsContent>
        </Tabs>
      </div>
    </ScrollArea>
  )
}
