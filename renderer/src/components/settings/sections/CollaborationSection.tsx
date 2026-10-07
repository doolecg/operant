import { useState } from 'react'
import { RotateCcw } from 'lucide-react'
import type { PurgeCandidate } from '@shared/types'
import { decodeIpcError } from '@shared/ipc'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Switch } from '@/components/ui/switch'
import { timeAgo } from '@/lib/format'
import { usePurgeNow, usePurgeStatus, useResetSettings, useSaveSettings, useSettings } from '@/lib/queries'
import { ConfirmDialog, NumberField, Row } from '../parts'

type Target = { operatorId: number | 'all'; label: string; count: number }

function PurgeCard({ retentionDays, enabled }: { retentionDays: number; enabled: boolean }) {
  const status = usePurgeStatus()
  const purge = usePurgeNow()
  const save = useSaveSettings()
  const [target, setTarget] = useState<Target | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<string | null>(null)

  const candidates: PurgeCandidate[] = status.data?.candidates ?? []
  const eligible = candidates.filter((c) => c.eligible)

  const close = () => {
    setTarget(null)
    setError(null)
  }
  const confirm = async () => {
    if (!target) return
    setError(null)
    try {
      const outcomes = await purge.mutateAsync([target.operatorId])
      const done = outcomes.filter((o) => o.purged).length
      const held = outcomes.filter((o) => !o.purged)
      setResult(
        `Purged ${done} operator${done === 1 ? '' : 's'}` +
          (held.length ? `; ${held.length} kept (${held.map((o) => `${o.label}: ${o.blockers.join(', ')}`).join('; ')})` : ''),
      )
      close()
    } catch (e) {
      setError(decodeIpcError(e).message)
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Retention</CardTitle>
        <CardDescription>
          Deleted operators are kept for a while so their spend and history stay readable, then purged for good (their spend moves to a
          summary).
        </CardDescription>
      </CardHeader>
      <CardContent className="divide-y">
        <Row label="Keep deleted operators for (days)" hint="0 makes every deleted operator eligible at once." htmlFor="retention">
          <NumberField
            id="retention"
            min={0}
            max={3650}
            value={retentionDays}
            onCommit={(v) => save.mutate({ collab: { purgeRetentionDays: v } })}
          />
        </Row>
        <Row label="Purge automatically" hint="Off keeps them until you purge them here." htmlFor="auto-purge">
          <Switch id="auto-purge" checked={enabled} onCheckedChange={(v) => save.mutate({ collab: { purgeEnabled: v } })} />
        </Row>
        <div className="space-y-2 py-3">
          <div className="flex items-center justify-between gap-4">
            <div className="text-sm">
              Deleted operators
              <span className="text-muted-foreground ml-2 text-xs">
                {candidates.length === 0 ? 'none' : `${eligible.length} of ${candidates.length} eligible`}
              </span>
            </div>
            <Button
              variant="outline"
              size="sm"
              disabled={eligible.length === 0}
              onClick={() => setTarget({ operatorId: 'all', label: 'every eligible operator', count: eligible.length })}
            >
              Purge all eligible
            </Button>
          </div>
          {candidates.length > 0 && (
            <ul className="divide-y rounded-md border">
              {candidates.map((c) => (
                <li key={c.operatorId} className="flex items-center justify-between gap-4 px-3 py-2">
                  <div className="min-w-0">
                    <div className="truncate text-sm">{c.label}</div>
                    <div className="text-muted-foreground text-xs">
                      Deleted {timeAgo(c.deletedAt)}
                      {!c.eligible && c.blockers.length > 0 ? ` · held back by ${c.blockers.join(', ')}` : ''}
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <Badge variant={c.eligible ? 'secondary' : 'outline'}>{c.eligible ? 'Eligible' : 'Waiting'}</Badge>
                    <Button
                      variant="ghost"
                      size="sm"
                      aria-label={`Purge ${c.label} now`}
                      onClick={() => setTarget({ operatorId: c.operatorId, label: c.label, count: 1 })}
                    >
                      Purge now
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          )}
          {result && (
            <p role="status" className="text-muted-foreground text-xs">
              {result}
            </p>
          )}
        </div>
      </CardContent>
      <ConfirmDialog
        open={target != null}
        title="Purge deleted operators"
        confirmLabel="Purge"
        busy={purge.isPending}
        error={error}
        onConfirm={confirm}
        onClose={close}
      >
        <p>
          This permanently removes {target?.label} ({target?.count} operator{target?.count === 1 ? '' : 's'}) with its messages and links.
          Spend history stays in the Cost tab. One that still owns a job or an unread message is kept.
        </p>
        <p>This cannot be undone.</p>
      </ConfirmDialog>
    </Card>
  )
}

export function CollaborationSection() {
  const settings = useSettings()
  const save = useSaveSettings()
  const reset = useResetSettings()
  const s = settings.data
  if (!s) return null
  const c = s.collab
  const set = (patch: Partial<typeof c>) => save.mutate({ collab: patch })

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Nudges</CardTitle>
          <CardDescription>
            When an operator has unread messages, Operant types one short line to wake it. Waiting longer means fewer wake-ups and fewer
            turns.
          </CardDescription>
          <CardAction>
            <Button variant="ghost" size="sm" onClick={() => reset.mutate('collab')}>
              <RotateCcw /> Reset section
            </Button>
          </CardAction>
        </CardHeader>
        <CardContent className="divide-y">
          <Row label="Idle before a nudge (seconds)" hint="How long an operator's terminal must be quiet before it is nudged." htmlFor="nudge-idle">
            <NumberField id="nudge-idle" min={1} max={3600} value={c.nudgeIdleSeconds} onCommit={(v) => set({ nudgeIdleSeconds: v })} />
          </Row>
          <Row
            label="Batch window (seconds)"
            hint="The newest unread message must be this old before a nudge, so messages arriving together share one wake-up."
            htmlFor="nudge-batch"
          >
            <NumberField id="nudge-batch" min={0} max={3600} value={c.nudgeBatchSeconds} onCommit={(v) => set({ nudgeBatchSeconds: v })} />
          </Row>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Jobs</CardTitle>
          <CardDescription>How long an operator holds a job, how many rejections a job gets, and when a long job is flagged.</CardDescription>
        </CardHeader>
        <CardContent className="divide-y">
          <Row label="Job lease (minutes)" hint="A claimed job returns to the board when its operator makes no call for this long." htmlFor="lease">
            <NumberField id="lease" min={1} max={1440} value={c.leaseMinutes} onCommit={(v) => set({ leaseMinutes: v })} />
          </Row>
          <Row label="Rejections per job" hint="Once a job has been rejected more often than this, the PM decides instead of sending it back again." htmlFor="max-rejects">
            <NumberField id="max-rejects" min={0} max={20} value={c.maxRejects} onCommit={(v) => set({ maxRejects: v })} />
          </Row>
          <Row label="Long job: estimate (minutes)" hint="A job estimated at this or more is held until you approve it to start, and you review it." htmlFor="long-estimate">
            <NumberField
              id="long-estimate"
              min={1}
              max={10000}
              value={c.longJobEstimateMinutes}
              onCommit={(v) => set({ longJobEstimateMinutes: v })}
            />
          </Row>
          <Row label="Long job: time spent (minutes)" hint="A job in progress longer than this goes to you for review and the PM is told. Work continues." htmlFor="long-elapsed">
            <NumberField
              id="long-elapsed"
              min={1}
              max={10000}
              value={c.longJobElapsedMinutes}
              onCommit={(v) => set({ longJobElapsedMinutes: v })}
            />
          </Row>
          <Row
            label="Update tracker job"
            hint="When a job finishes in a project that has a tracker file, open one “Update tracker” job for the project manager. Each project can also turn it off."
            htmlFor="tracker-jobs"
          >
            <Switch id="tracker-jobs" checked={c.trackerJobs} onCheckedChange={(v) => set({ trackerJobs: v })} />
          </Row>
        </CardContent>
      </Card>

      <PurgeCard retentionDays={c.purgeRetentionDays} enabled={c.purgeEnabled} />
    </>
  )
}
