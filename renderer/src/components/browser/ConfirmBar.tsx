import { ShieldQuestion } from 'lucide-react'
import { Button } from '@/components/ui/button'

// The shape of a browser:confirm push.
export interface ConfirmRequest {
  id: string
  tool: string
  summary: string
}

// A strip above the page while the AI waits for a yes or no. Not a dialog role on purpose: useOverlayOpen would hide
// the native view for it. Shows the oldest request; the next one follows its answer.
export function ConfirmBar({
  requests,
  allowAll,
  onAnswer,
  onStopAllowAll,
}: {
  requests: readonly ConfirmRequest[]
  allowAll: boolean
  onAnswer: (id: string, allow: boolean, all?: boolean) => void
  onStopAllowAll: () => void
}) {
  const req = requests[0]
  if (!req) return allowAll ? <AllowAllNote onStop={onStopAllowAll} /> : null
  return (
    <div role="group" aria-label="AI action needs approval" aria-live="assertive" className="border-primary/50 bg-primary/10 mx-2 mb-1.5 flex shrink-0 items-center gap-2 rounded-lg border px-2.5 py-1.5 text-xs">
      <ShieldQuestion aria-hidden className="text-primary size-4 shrink-0" />
      <span className="min-w-0 flex-1 truncate" title={`AI wants to ${req.summary}`}>
        AI wants to {req.summary}
        {requests.length > 1 && <span className="text-muted-foreground"> ({requests.length - 1} more waiting)</span>}
      </span>
      <Button type="button" size="sm" className="h-6 px-2 text-xs" aria-label="Allow AI action" onClick={() => onAnswer(req.id, true)}>
        Allow
      </Button>
      <Button type="button" size="sm" variant="outline" className="h-6 px-2 text-xs" aria-label="Allow all AI actions" onClick={() => onAnswer(req.id, true, true)}>
        Allow all
      </Button>
      <Button type="button" size="sm" variant="outline" className="h-6 px-2 text-xs" aria-label="Deny AI action" onClick={() => onAnswer(req.id, false)}>
        Deny
      </Button>
    </div>
  )
}

function AllowAllNote({ onStop }: { onStop: () => void }) {
  return (
    <div role="group" aria-label="Allowing all AI actions" className="border-primary/50 bg-primary/10 mx-2 mb-1.5 flex shrink-0 items-center gap-2 rounded-lg border px-2.5 py-1.5 text-xs">
      <ShieldQuestion aria-hidden className="text-primary size-4 shrink-0" />
      <span className="min-w-0 flex-1 truncate">Allowing all AI actions</span>
      <Button type="button" size="sm" variant="outline" className="h-6 px-2 text-xs" aria-label="Stop allowing all" onClick={onStop}>
        Stop
      </Button>
    </div>
  )
}
