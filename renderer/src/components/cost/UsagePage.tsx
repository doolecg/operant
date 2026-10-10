import { useMemo, useState } from 'react'
import { ChevronDown, ChevronRight, Maximize2, Minimize2 } from 'lucide-react'
import { decodeIpcError } from '@shared/ipc'
import type { UsageFilter, UsageGroupBy, UsageQuery } from '@shared/types'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { useCrews, useUsageReport, useUsageSeries } from '@/lib/queries'
import { BudgetsEditor } from './Budgets'
import { ExportButtons } from './ExportButtons'
import { ProvidersSection } from './Providers'
import { RANGES, rangeBounds, rangeIsHourly, type RangeId } from './range'
import { TrendChart } from './TrendChart'
import { TotalsCards, UsageTable } from './UsageParts'

const ALL = '__all__'

const GROUPS: Array<{ id: UsageGroupBy; label: string; heading: string }> = [
  { id: 'day', label: 'Day', heading: 'Day' },
  { id: 'project', label: 'Project', heading: 'Project' },
  { id: 'model', label: 'Model', heading: 'Model' },
  { id: 'cli', label: 'CLI', heading: 'CLI' },
]
const SPLITTABLE = new Set<UsageGroupBy>(['project', 'model', 'cli', 'provider'])

function FilterSelect({ label, value, onChange, options }: { label: string; value: string; onChange: (v: string) => void; options: Array<{ value: string; label: string }> }) {
  return (
    <div className="min-w-0 space-y-0.5">
      <label className="text-muted-foreground block truncate text-[11px] whitespace-nowrap" id={`filter-${label}`}>
        {label}
      </label>
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger size="sm" className="h-7 w-full min-w-0 text-xs [&>span]:truncate" aria-labelledby={`filter-${label}`}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={ALL}>All</SelectItem>
          {options.map((o) => (
            <SelectItem key={o.value} value={o.value}>
              {o.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  )
}

// The distinct values of one grouping inside the date range, to fill a filter's choices.
function useChoices(group: UsageGroupBy, from: number | undefined, to: number | undefined) {
  const q = useUsageReport({ filter: { from, to }, groupBy: [group] })
  return (q.data?.rows ?? []).filter((r) => r.keys[0]).map((r) => ({ value: r.keys[0]!, label: r.labels[0] || r.keys[0]! }))
}

function Collapsible({ title, children, defaultOpen = false }: { title: string; children: React.ReactNode; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen)
  const Icon = open ? ChevronDown : ChevronRight
  return (
    <section aria-label={title} className="space-y-2">
      <button type="button" aria-expanded={open} className="flex items-center gap-1 text-sm font-medium" onClick={() => setOpen((o) => !o)}>
        <Icon className="size-4" /> {title}
      </button>
      {open && children}
    </section>
  )
}

// The Usage tab: filters, totals, trend, grouped rows, provider limits, budgets and export.
export function UsagePage({
  crewId,
  wide,
  onToggleWide,
}: {
  crewId: number
  wide: boolean
  onToggleWide: () => void
}) {
  const [range, setRange] = useState<RangeId>('30d')
  const [customFrom, setCustomFrom] = useState('')
  const [customTo, setCustomTo] = useState('')
  // The project filter follows the open project until a different one is chosen.
  const [projectChoice, setProjectChoice] = useState<{ crewId: number; value: string } | null>(null)
  const project = projectChoice && projectChoice.crewId === crewId ? projectChoice.value : String(crewId)
  const [model, setModel] = useState(ALL)
  const [cli, setCli] = useState(ALL)
  const [provider, setProvider] = useState(ALL)
  const [group, setGroup] = useState<UsageGroupBy>('day')

  const { from, to } = useMemo(() => rangeBounds(range, customFrom, customTo), [range, customFrom, customTo])
  const crews = useCrews()
  const filter: UsageFilter = {
    from,
    to,
    crewId: project === ALL ? undefined : Number(project),
    model: model === ALL ? undefined : model,
    cli: cli === ALL ? undefined : cli,
    provider: provider === ALL ? undefined : provider,
  }
  const query: UsageQuery = { filter, groupBy: [group], trend: from != null }
  const splitBy = SPLITTABLE.has(group) ? group : undefined
  const seriesQuery = { filter, bucket: rangeIsHourly({ from, to }) ? ('hour' as const) : ('day' as const), split: splitBy }
  const report = useUsageReport(query)
  const series = useUsageSeries(seriesQuery)
  const models = useChoices('model', from, to)
  const clis = useChoices('cli', from, to)
  const providers = useChoices('provider', from, to)

  const groupDef = GROUPS.find((g) => g.id === group)!
  const data = report.data

  return (
    <ScrollArea className="h-full">
      <div className="space-y-4 p-3">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <h2 className="text-sm font-semibold">Usage</h2>
          <Button size="icon" variant="ghost" className="ml-auto size-6" aria-label={wide ? 'Narrow the Usage panel' : 'Widen the Usage panel'} onClick={onToggleWide}>
            {wide ? <Minimize2 className="size-3.5" /> : <Maximize2 className="size-3.5" />}
          </Button>
          <span className="text-muted-foreground min-w-0 basis-full text-[11px]">
            Tokens and cost per day, project, model and CLI. Costs not reported by a provider are estimated from tokens at list prices.
          </span>
        </div>

        <section aria-label="Usage filters" className="space-y-2">
          <div role="group" aria-label="Date range" className="flex flex-wrap items-end gap-1">
            {RANGES.map((r) => (
              <Button key={r.id} size="xs" variant={r.id === range ? 'secondary' : 'ghost'} aria-pressed={r.id === range} onClick={() => setRange(r.id)}>
                {r.label}
              </Button>
            ))}
            {range === 'custom' && (
              <>
                <Input aria-label="From date" type="date" className="h-6 w-32 text-[11px]" value={customFrom} onChange={(e) => setCustomFrom(e.target.value)} />
                <Input aria-label="To date" type="date" className="h-6 w-32 text-[11px]" value={customTo} onChange={(e) => setCustomTo(e.target.value)} />
              </>
            )}
          </div>
          <div className="grid grid-cols-[repeat(auto-fill,minmax(9rem,1fr))] gap-2">
            <FilterSelect
              label="Project"
              value={project}
              onChange={(v) => setProjectChoice({ crewId, value: v })}
              options={(crews.data ?? []).map((c) => ({ value: String(c.id), label: c.name }))}
            />
            <FilterSelect label="Model" value={model} onChange={setModel} options={models} />
            <FilterSelect label="CLI" value={cli} onChange={setCli} options={clis} />
            <FilterSelect label="Provider" value={provider} onChange={setProvider} options={providers} />
          </div>
        </section>

        {!data ? (
          <p className="text-muted-foreground px-1 text-xs" role={report.error ? 'alert' : undefined}>
            {report.error ? decodeIpcError(report.error).message : 'Loading...'}
          </p>
        ) : (
          <>
            <TotalsCards totals={data.totals} trend={data.trend} />

            <section aria-label="Spend trend" className="bg-card space-y-2 rounded-lg border px-3 py-2.5">
              <h3 className="text-sm font-medium">Spend per {seriesQuery.bucket}</h3>
              <TrendChart points={series.data?.points ?? []} split={splitBy != null} />
            </section>

            <section aria-label="Usage breakdown" className="space-y-1.5">
              <div className="flex flex-wrap items-center gap-2">
                <h3 className="text-sm font-medium">Breakdown</h3>
                <div role="group" aria-label="Group by" className="ml-auto flex flex-wrap gap-1">
                  {GROUPS.map((g) => (
                    <Button key={g.id} size="xs" variant={g.id === group ? 'secondary' : 'ghost'} aria-pressed={g.id === group} onClick={() => setGroup(g.id)}>
                      {g.label}
                    </Button>
                  ))}
                </div>
              </div>
              <UsageTable
                rows={data.rows}
                totals={data.totals}
                firstHeading={groupDef.heading}
                caption={`Usage grouped by ${groupDef.label.toLowerCase()}`}
              />
              <ExportButtons
                views={[
                  { id: 'table', label: `Table by ${groupDef.label.toLowerCase()}`, view: { kind: 'report', query } },
                  { id: 'trend', label: `Trend per ${seriesQuery.bucket}`, view: { kind: 'series', query: seriesQuery } },
                ]}
              />
            </section>
          </>
        )}

        <ProvidersSection />

        <Collapsible title="Budgets" defaultOpen>
          <div className="bg-card rounded-lg border px-3.5 py-3">
            <BudgetsEditor />
          </div>
        </Collapsible>
      </div>
    </ScrollArea>
  )
}
