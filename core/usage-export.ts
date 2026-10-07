import type { ExportFormat, ExportText, RunUsage, UsageReport, UsageSeries, UsageView } from '../shared/types'
import { jobUsage, queryUsage, querySeries, type QueryDeps } from './usage-query'

// RFC 4180: a field with a comma, quote or line break is quoted and its quotes doubled. A leading = + - @ is
// prefixed with a quote so a spreadsheet does not run it as a formula.
export function csvField(v: string | number | null | undefined): string {
  let s = v == null ? '' : String(v)
  if (typeof v === 'string' && /^[=+\-@\t\r]/.test(s)) s = `'${s}`
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

export function toCsv(header: string[], rows: Array<Array<string | number | null | undefined>>): string {
  return [header, ...rows].map((r) => r.map(csvField).join(',')).join('\r\n') + '\r\n'
}

const TOTAL_COLS = ['input_tokens', 'output_tokens', 'cache_read_tokens', 'cache_write_tokens', 'cost_usd', 'turns', 'legacy_turns']
const totalCells = (t: { inputTokens: number; outputTokens: number; cacheRead: number; cacheWrite: number; costUsd: number; turns: number; legacyTurns: number }) => [
  t.inputTokens,
  t.outputTokens,
  t.cacheRead,
  t.cacheWrite,
  Number(t.costUsd.toFixed(6)),
  t.turns,
  t.legacyTurns,
]

export function reportCsv(r: UsageReport): string {
  const groups = r.query.groupBy ?? []
  const header = [...groups.flatMap((g) => [g, `${g}_label`]), ...TOTAL_COLS]
  const rows = r.rows.map((row) => [...groups.flatMap((_, i) => [row.keys[i], row.labels[i]]), ...totalCells(row)])
  rows.push([...groups.flatMap((_, i) => [i === 0 ? 'TOTAL' : '', '']), ...totalCells(r.totals)])
  return toCsv(header, rows)
}

export function seriesCsv(s: UsageSeries): string {
  const header = ['bucket', ...(s.query.split ? [s.query.split, `${s.query.split}_label`] : []), 'cost_usd', 'tokens', 'turns']
  const rows = s.points.map((p) => [p.bucket, ...(s.query.split ? [p.split, p.splitLabel] : []), Number(p.costUsd.toFixed(6)), p.tokens, p.turns])
  return toCsv(header, rows)
}

export function jobCsv(j: RunUsage): string {
  const rows = j.agents.map((a) => [a.agentId, a.seat, a.model, a.status, ...totalCells(a)])
  rows.push([null, 'TOTAL', '', '', ...totalCells(j.totals)])
  return toCsv(['agent_id', 'seat', 'model', 'status', ...TOTAL_COLS], rows)
}

const stamp = (now: number) => new Date(now).toISOString().slice(0, 10)

// Any view as text in the chosen format; JSON is the query result as the renderer sees it.
export function exportView(d: QueryDeps, view: UsageView, format: ExportFormat): ExportText {
  if (format !== 'csv' && format !== 'json') throw new Error('The format must be csv or json')
  let data: UsageReport | UsageSeries | RunUsage
  let csv: string
  let name: string
  if (view.kind === 'report') {
    const r = queryUsage(d, view.query)
    data = r
    csv = reportCsv(r)
    name = `usage-${(r.query.groupBy ?? []).join('-') || 'total'}`
  } else if (view.kind === 'series') {
    const s = querySeries(d, view.query)
    data = s
    csv = seriesCsv(s)
    name = `usage-by-${s.query.bucket}${s.query.split ? `-${s.query.split}` : ''}`
  } else if (view.kind === 'job') {
    const j = jobUsage(d, view.runId)
    data = j
    csv = jobCsv(j)
    name = `usage-job-${view.runId}`
  } else throw new Error('Unknown view')
  const filename = `${name}-${stamp(d.now())}.${format}`
  return format === 'csv'
    ? { filename, mime: 'text/csv', text: csv }
    : { filename, mime: 'application/json', text: JSON.stringify(data, null, 2) }
}
