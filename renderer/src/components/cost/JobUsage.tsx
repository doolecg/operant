import { ArrowLeft } from 'lucide-react'
import { decodeIpcError } from '@shared/ipc'
import type { JobAgentUsage } from '@shared/types'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { compact, usd } from '@/lib/format'
import { useJobUsage } from '@/lib/queries'
import { ExportButtons } from './ExportButtons'
import { TotalsCards } from './UsageParts'

const agentName = (a: JobAgentUsage) => (a.agentId == null ? 'Master' : a.seat || `Agent ${a.agentId}`)

// One job's page: totals and the cost of every agent that worked on it.
export function JobUsage({ runId, onBack }: { runId: number; onBack: () => void }) {
  const q = useJobUsage(runId)
  const u = q.data
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Button size="xs" variant="ghost" onClick={onBack}>
          <ArrowLeft /> All usage
        </Button>
        <h3 className="font-mono text-sm font-semibold">JOB#{runId}</h3>
        <div className="ml-auto">
          <ExportButtons views={[{ id: 'job', label: 'Job', view: { kind: 'job', runId } }]} />
        </div>
      </div>
      {!u ? (
        <p className="text-muted-foreground px-1 text-xs" role={q.error ? 'alert' : undefined}>
          {q.error ? decodeIpcError(q.error).message : 'Loading...'}
        </p>
      ) : (
        <>
          <p className="text-muted-foreground px-1 text-xs">{u.task}</p>
          <TotalsCards totals={u.totals} />
          <section aria-label={`Cost per agent for JOB#${runId}`} className="space-y-1.5">
            <h4 className="text-sm font-medium">Cost per agent</h4>
            <div className="bg-card overflow-x-auto rounded-lg border">
              <table className="w-full text-[11px]">
                <caption className="sr-only">Cost per agent</caption>
                <thead className="text-muted-foreground border-b">
                  <tr>
                    <th scope="col" className="px-2 py-1.5 text-left font-medium">Agent</th>
                    <th scope="col" className="px-2 py-1.5 text-left font-medium">Model</th>
                    <th scope="col" className="px-2 py-1.5 text-right font-medium">Input</th>
                    <th scope="col" className="px-2 py-1.5 text-right font-medium">Output</th>
                    <th scope="col" className="px-2 py-1.5 text-right font-medium">Cache</th>
                    <th scope="col" className="px-2 py-1.5 text-right font-medium">Cost</th>
                    <th scope="col" className="px-2 py-1.5 text-right font-medium">Turns</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {u.agents.map((a) => (
                    <tr key={a.agentId ?? 'master'}>
                      <th scope="row" className="px-2 py-1.5 text-left font-normal">
                        <span className="flex items-center gap-1.5">
                          {agentName(a)}
                          {a.status && <Badge variant="outline">{a.status}</Badge>}
                        </span>
                      </th>
                      <td className="text-muted-foreground max-w-28 truncate px-2 py-1.5 font-mono">{a.model || '-'}</td>
                      <td className="px-2 py-1.5 text-right tabular-nums">{compact(a.inputTokens)}</td>
                      <td className="px-2 py-1.5 text-right tabular-nums">{compact(a.outputTokens)}</td>
                      <td className="px-2 py-1.5 text-right tabular-nums">{compact(a.cacheRead + a.cacheWrite)}</td>
                      <td className="px-2 py-1.5 text-right font-medium tabular-nums">{usd(a.costUsd)}</td>
                      <td className="px-2 py-1.5 text-right tabular-nums">{a.turns}</td>
                    </tr>
                  ))}
                  {u.agents.length === 0 && (
                    <tr>
                      <td colSpan={7} className="text-muted-foreground px-2 py-3">No agents have spent anything on this job yet.</td>
                    </tr>
                  )}
                </tbody>
                <tfoot className="border-t font-medium">
                  <tr>
                    <th scope="row" colSpan={5} className="px-2 py-1.5 text-left">Total</th>
                    <td className="px-2 py-1.5 text-right tabular-nums">{usd(u.totals.costUsd)}</td>
                    <td className="px-2 py-1.5 text-right tabular-nums">{u.totals.turns}</td>
                  </tr>
                </tfoot>
              </table>
            </div>
          </section>
        </>
      )}
    </div>
  )
}
