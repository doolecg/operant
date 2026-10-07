import { useState } from 'react'
import { Play, Trash2 } from 'lucide-react'
import { decodeIpcError } from '@shared/ipc'
import type { BudgetConfig, BudgetProgress, BudgetTarget } from '@shared/types'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { ConfirmDialog, NumberField } from '@/components/settings/parts'
import { useBudgets, useCrews, useResumeBudget, useSaveSettings, useSetBudgets, useSettings } from '@/lib/queries'
import { CapBar } from './Caps'

const MAX_CAP = 100_000

// One cap: spend against it, an editable amount (0 = no cap) and a Resume button while it holds the queue.
function CapRow({
  name,
  value,
  progress,
  warnPct,
  busy,
  onCap,
  onResume,
  onRemove,
}: {
  name: string
  value: number
  progress: BudgetProgress | null | undefined
  warnPct: number
  busy: boolean
  onCap: (usd: number) => void
  onResume?: () => void
  onRemove?: () => void
}) {
  const id = `budget-${name.replace(/\W+/g, '-')}`
  return (
    <div className="space-y-1.5 py-2.5">
      <div className="flex items-center gap-2">
        <label htmlFor={id} className="min-w-0 flex-1 truncate text-xs font-medium" title={name}>
          {name}
        </label>
        <NumberField id={id} aria-label={`${name} cap in USD`} min={0} max={MAX_CAP} step="0.5" value={value} disabled={busy} className="h-7 w-20 text-xs" onCommit={onCap} />
        <span className="text-muted-foreground text-[11px]">USD</span>
        {progress?.paused && onResume && (
          <Button size="xs" disabled={busy} aria-label={`Resume ${name}`} onClick={onResume}>
            <Play /> Resume
          </Button>
        )}
        {onRemove && (
          <Button size="icon" variant="ghost" className="size-6" aria-label={`Remove cap for ${name}`} disabled={busy} onClick={onRemove}>
            <Trash2 className="size-3.5" />
          </Button>
        )}
      </div>
      {progress ? <CapBar cap={progress} warnPct={warnPct} label={`${name} spend against cap`} /> : <p className="text-muted-foreground text-[11px]">No cap applies</p>}
    </div>
  )
}

// Caps for the day, each project and each job: they warn at the warning percentage and hold the queue at the cap.
export function BudgetsEditor() {
  const budgets = useBudgets()
  const settings = useSettings()
  const crews = useCrews()
  const setBudgets = useSetBudgets()
  const resume = useResumeBudget()
  const saveSettings = useSaveSettings()
  const [jobNo, setJobNo] = useState('')
  const [jobCap, setJobCap] = useState('')
  const [removeJob, setRemoveJob] = useState<number | null>(null)
  const b = budgets.data
  const s = settings.data
  if (!b || !s) return <p className="text-muted-foreground px-1 text-xs">{budgets.error ? 'Budgets could not be loaded.' : 'Loading...'}</p>

  const cfg = b.config
  const warnPct = s.tokens.capWarnPct
  const busy = setBudgets.isPending || resume.isPending || saveSettings.isPending
  const err = setBudgets.error ?? resume.error ?? saveSettings.error
  const patch = (p: Partial<BudgetConfig>) => setBudgets.mutate([p])
  // A map patch names only the keys it changes; 0 removes a cap.
  const doResume = (t: BudgetTarget) => resume.mutate([t])
  const addJob = () => {
    const n = Number(jobNo.replace(/^JOB#/i, ''))
    const cap = Number(jobCap)
    if (!Number.isInteger(n) || n <= 0 || !(cap > 0)) return
    patch({ jobUsd: { [String(n)]: cap } })
    setJobNo('')
    setJobCap('')
  }
  const jobRows = Object.entries(cfg.jobUsd)
    .map(([k, v]) => [Number(k), v] as const)
    .sort((a, c) => a[0] - c[0])

  return (
    <div className="space-y-3">
      {b.held.length > 0 && (
        <div role="status" className="space-y-1.5 rounded-lg border border-amber-400/50 bg-amber-400/10 px-3 py-2 text-xs">
          <p className="font-medium">Queued jobs are on hold</p>
          {b.held.map((h) => (
            <div key={`${h.crewId}`} className="flex items-center gap-2">
              <span className="min-w-0 flex-1">{h.reason}</span>
              <Button size="xs" disabled={busy} aria-label={h.crewId == null ? 'Resume all projects' : `Resume held project ${crews.data?.find((c) => c.id === h.crewId)?.name ?? h.crewId}`} onClick={() => doResume(h.crewId == null ? { scope: 'day' } : { scope: 'project', crewId: h.crewId })}>
                <Play /> Resume
              </Button>
            </div>
          ))}
        </div>
      )}

      <p className="text-muted-foreground text-[11px]">
        A cap warns at {warnPct}% of its amount (Settings, Tokens) and holds queued jobs at 100% when holding is on. Resume lets the held jobs start without raising the cap.
      </p>

      <div className="divide-y">
        <CapRow
          name="Day"
          value={s.dailyBudgetUsd}
          progress={b.day}
          warnPct={warnPct}
          busy={busy}
          onCap={(v) => saveSettings.mutate({ dailyBudgetUsd: v })}
          onResume={() => doResume({ scope: 'day' })}
        />
        {(crews.data ?? []).map((c) => (
          <CapRow
            key={c.id}
            name={`Project ${c.name}`}
            value={cfg.projectDailyUsd[String(c.id)] ?? 0}
            progress={b.projects.find((p) => p.crewId === c.id)}
            warnPct={warnPct}
            busy={busy}
            onCap={(v) => patch({ projectDailyUsd: { [String(c.id)]: v } })}
            onResume={() => doResume({ scope: 'project', crewId: c.id })}
          />
        ))}
        <CapRow name="Every job, default" value={cfg.jobDefaultUsd} progress={null} warnPct={warnPct} busy={busy} onCap={(v) => patch({ jobDefaultUsd: v })} />
        {jobRows.map(([runId, usd]) => (
          <CapRow
            key={runId}
            name={`JOB#${runId}`}
            value={usd}
            progress={b.jobs.find((j) => j.runId === runId)}
            warnPct={warnPct}
            busy={busy}
            onCap={(v) => (v > 0 ? patch({ jobUsd: { [String(runId)]: v } }) : setRemoveJob(runId))}
            onResume={() => doResume({ scope: 'job', runId })}
            onRemove={() => setRemoveJob(runId)}
          />
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs font-medium">Cap one job</span>
        <Input aria-label="Job number for a cap" className="h-7 w-24 text-xs" placeholder="JOB#" inputMode="numeric" value={jobNo} onChange={(e) => setJobNo(e.target.value)} />
        <Input aria-label="Cap for that job in USD" className="h-7 w-20 text-right text-xs" placeholder="USD" type="number" min={0} step="0.5" value={jobCap} onChange={(e) => setJobCap(e.target.value)} />
        <Button size="xs" variant="outline" disabled={busy} onClick={addJob}>
          Add job cap
        </Button>
      </div>

      <div className="space-y-2 text-xs">
        <label className="flex items-center justify-between gap-3">
          <span>
            Hold queued jobs at a cap
            <span className="text-muted-foreground block text-[11px]">Off: caps only warn.</span>
          </span>
          <Switch aria-label="Hold queued jobs at a cap" checked={cfg.pauseQueue} disabled={busy} onCheckedChange={(v) => patch({ pauseQueue: v })} />
        </label>
        <label className="flex items-center justify-between gap-3">
          <span>
            Stop a job at its own cap
            <span className="text-muted-foreground block text-[11px]">The job ends as failed.</span>
          </span>
          <Switch aria-label="Stop a job at its own cap" checked={cfg.stopJobAtCap} disabled={busy} onCheckedChange={(v) => patch({ stopJobAtCap: v })} />
        </label>
      </div>

      {err && (
        <p role="alert" className="text-destructive text-xs">
          {decodeIpcError(err).message}
        </p>
      )}

      <ConfirmDialog
        open={removeJob != null}
        title="Remove job cap"
        confirmLabel="Remove cap"
        busy={busy}
        onClose={() => setRemoveJob(null)}
        onConfirm={() => {
          if (removeJob != null) patch({ jobUsd: { [String(removeJob)]: 0 } })
          setRemoveJob(null)
        }}
      >
        <p>
          JOB#{removeJob} goes back to the default job cap ({cfg.jobDefaultUsd > 0 ? `$${cfg.jobDefaultUsd}` : 'none'}). Its spend so far is kept.
        </p>
      </ConfirmDialog>
    </div>
  )
}
