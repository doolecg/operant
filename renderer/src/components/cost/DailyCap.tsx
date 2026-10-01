import { decodeIpcError } from '@shared/ipc'
import { useCapStatus, useResetCaps, useSaveSettings, useSettings } from '@/lib/queries'
import { CapEditor } from './Caps'

// The crew-wide daily budget (Settings > daily budget): progress, edit, raise, resume after a pause.
export function DailyCap() {
  const settings = useSettings()
  const caps = useCapStatus()
  const save = useSaveSettings()
  const reset = useResetCaps()
  const s = settings.data
  if (!s) return null
  const err = save.error ?? reset.error
  return (
    <section aria-label="Daily budget" className="bg-card space-y-2 rounded-lg border px-3.5 py-3">
      <h3 className="text-sm font-medium">Daily budget</h3>
      <CapEditor
        name="Daily budget"
        cap={caps.data?.daily ?? null}
        value={s.dailyBudgetUsd > 0 ? String(s.dailyBudgetUsd) : ''}
        placeholder="off"
        warnPct={s.tokens.capWarnPct}
        busy={save.isPending || reset.isPending}
        error={err ? decodeIpcError(err).message : null}
        onSetCap={(v) => save.mutate({ dailyBudgetUsd: v ?? 0 })}
        onRaise={(v) => save.mutate({ dailyBudgetUsd: v })}
        onReset={() => reset.mutate(['daily'])}
      />
    </section>
  )
}
