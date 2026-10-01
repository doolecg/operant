import type { OperatorUsage, WasteSignal } from '@shared/types'

function say(w: WasteSignal, who: string): string {
  switch (w.kind) {
    case 'cold-repeated':
      return `${who} restarted cold ${w.value} times: model or effort switches?`
    case 'output-share':
      return `${w.text} (warns above ${Math.round(w.threshold)}%): long replies or file dumps?`
    case 'no-tool-streak':
      return `${w.text}: chatting, or stuck?`
    case 'context-high':
      return `${w.text}: consider clearing between jobs.`
    case 'job-cost':
      return `${w.text}.`
  }
}

export function WasteSignals({ waste, operators }: { waste: WasteSignal[]; operators: OperatorUsage[] }) {
  return (
    <section aria-label="Waste signals" className="space-y-1.5">
      <h3 className="text-sm font-medium">Waste signals</h3>
      {waste.length === 0 ? (
        <p className="text-muted-foreground px-1 text-xs">Nothing is wasting tokens right now.</p>
      ) : (
        <ul className="bg-card divide-y rounded-lg border">
          {waste.map((w, i) => {
            const who = operators.find((o) => o.operatorId === w.operatorId)?.address ?? 'An operator'
            return (
              <li key={`${w.kind}:${w.operatorId}:${w.jobId}:${i}`} className="flex items-start gap-2 px-3 py-2 text-xs">
                <span className="mt-1.5 size-1.5 shrink-0 rounded-full bg-amber-400" aria-hidden />
                <span className="min-w-0 break-words">{say(w, who)}</span>
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}
