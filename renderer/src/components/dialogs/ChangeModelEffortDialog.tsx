// Changes an operator's model and effort, showing the apply plan from operators:previewChange first (ruling R1:
// a running Claude operator restarts as a fresh session). Open it with
// openDialog('changeModelEffort', { operatorId, model?, effort? }); model and effort pre-select a proposal.
import { useState } from 'react'
import { AlertTriangle } from 'lucide-react'
import { decodeIpcError } from '@shared/ipc'
import type { OperatorPatch } from '@shared/types'
import { hasEffort, hasModel, modelOptions, effortFromValue, effortValue, EFFORTS, DEFAULT_EFFORT } from '@/components/operators/models'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { usd } from '@/lib/format'
import { useApplyOperatorChange, useChangePlan, useOperator, usePresets } from '@/lib/queries'
import type { ChangeModelEffortPayload, DialogProps } from '@/registry'

export interface ChangeModelEffortRequest extends ChangeModelEffortPayload {
  model?: string
  effort?: string
}

export function ChangeModelEffortDialog({ payload, onClose }: DialogProps<ChangeModelEffortRequest>) {
  const operator = useOperator(payload?.operatorId ?? null)
  const presets = usePresets()
  const apply = useApplyOperatorChange()
  const [model, setModel] = useState<string | null>(payload?.model ?? null)
  const [effort, setEffort] = useState<string | null>(payload?.effort ?? null)

  const op = operator.data
  const nextModel = model ?? op?.model ?? ''
  const nextEffort = effort ?? op?.effort ?? ''
  const showEffort = op ? hasEffort({ agent: op.agent, model: nextModel }) : false

  const patch: OperatorPatch = {}
  if (op && model != null && model !== op.model) patch.model = model
  if (op && showEffort && effort != null && effort !== op.effort) patch.effort = effort
  const changed = Object.keys(patch).length > 0

  const plan = useChangePlan(op?.id ?? null, changed ? patch : null)
  const running = op != null && op.status !== 'stopped'
  const p = plan.data
  const restart = !!p?.requiresRestart

  const submit = () => {
    if (!op || !changed) return
    apply.mutate([op.id, patch], { onSuccess: onClose })
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Change model and effort</DialogTitle>
          <DialogDescription>
            {op ? (
              <>
                Operator <span className="font-mono">{op.role}</span>
                {running ? ' is running.' : ' is stopped; the change applies on its next start.'}
              </>
            ) : (
              'Loading the operator.'
            )}
          </DialogDescription>
        </DialogHeader>

        {op && (
          <div className="space-y-4">
            {hasModel(op) && (
              <div className="space-y-1.5">
                <Label htmlFor="change-model">Model</Label>
                <Select value={nextModel} onValueChange={setModel}>
                  <SelectTrigger id="change-model" className="w-full font-mono text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {modelOptions(op.agent, op.model, presets.data).map((m) => (
                      <SelectItem key={m} value={m} className="font-mono text-xs">
                        {m}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}
            {showEffort && (
              <div className="space-y-1.5">
                <Label htmlFor="change-effort">Effort</Label>
                <Select value={effortValue(nextEffort)} onValueChange={(v) => setEffort(effortFromValue(v))}>
                  <SelectTrigger id="change-effort" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={DEFAULT_EFFORT}>default</SelectItem>
                    {EFFORTS.map((e) => (
                      <SelectItem key={e} value={e}>
                        {e}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}
            {op.agent === 'codex' && (
              <p className="text-muted-foreground text-xs">Codex operators take a model only; effort is not available.</p>
            )}

            {!changed && <p className="text-muted-foreground text-xs">Pick a different model or effort to see what it does.</p>}

            {changed && p && (
              <div className="space-y-2 text-xs">
                {restart && (
                  <Notice>
                    <strong>Fresh restart.</strong> This operator stops and relaunches as a new session, so its conversation is
                    lost. Its jobs stay; it re-reads its job record.
                  </Notice>
                )}
                {p.model === 'cache-lost' && (
                  <Notice>
                    <strong>Cache loss.</strong> Changing the model drops the prompt cache
                    {p.estimateColdCostUsd != null ? (
                      <>
                        ; the first turns on the new model cost about <strong>{usd(p.estimateColdCostUsd)}</strong> to warm up.
                      </>
                    ) : (
                      '.'
                    )}
                  </Notice>
                )}
                {p.effort === 'conversation-lost' && !restart && (
                  <Notice>Changing the effort starts a fresh session on the next launch.</Notice>
                )}
                {p.effort === 'cache-kept' && (
                  <p className="text-muted-foreground">Nothing is running, so the cache is not affected; this applies on the next start.</p>
                )}
                {!restart && p.liveFields.length > 0 && (
                  <p className="text-muted-foreground">Applies live: {p.liveFields.join(', ')}.</p>
                )}
                {!restart && p.restartFields.length > 0 && !running && (
                  <p className="text-muted-foreground">Applies on the next start: {p.restartFields.join(', ')}.</p>
                )}
              </div>
            )}
            {changed && plan.error != null && <p className="text-destructive text-xs">{decodeIpcError(plan.error).message}</p>}
            {apply.error != null && <p className="text-destructive text-xs">{decodeIpcError(apply.error).message}</p>}
          </div>
        )}

        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={!op || !changed || !p || apply.isPending}>
            {restart ? 'Restart fresh and apply' : 'Apply'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function Notice({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-2.5">
      <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-amber-400" />
      <p>{children}</p>
    </div>
  )
}
