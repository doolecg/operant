import { useEffect, useState } from 'react'
import type { Operator, OperatorPatch } from '@shared/types'
import { Field, FormDialog } from '@/components/dashboard/Dialogs'
import { DEFAULT_EFFORT, EFFORTS, effortFromValue, effortValue, hasEffort } from '@/components/operators/models'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { useApplyOperatorChange } from '@/lib/queries'

const MODES = ['acceptEdits', 'bypassPermissions', 'manual', 'dontAsk', 'plan']
const DEFAULT_MODE = 'default'
// A fresh Master slot stores 'default' for the mode; the form treats it as empty.
const savedMode = (m: Operator) => (m.permissionMode === DEFAULT_MODE ? '' : m.permissionMode)

// The Master Terminal runs the user's own Claude Code: only the launch command (model, effort, mode) is editable.
export function MasterEditDialog({ master, open, onOpenChange }: { master: Operator; open: boolean; onOpenChange: (o: boolean) => void }) {
  const apply = useApplyOperatorChange()
  const [model, setModel] = useState(master.model)
  const [effort, setEffort] = useState(master.effort)
  const [mode, setMode] = useState(savedMode(master))

  useEffect(() => {
    if (open) {
      setModel(master.model)
      setEffort(master.effort)
      setMode(savedMode(master))
      apply.reset()
    }
  }, [open])

  const patch: OperatorPatch = {}
  if (model.trim() !== master.model) patch.model = model.trim()
  if (effort !== master.effort) patch.effort = effort
  if (mode !== savedMode(master)) patch.permissionMode = mode
  const changed = Object.keys(patch).length > 0
  const running = master.status !== 'stopped'

  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Edit the Master Terminal"
      description="Empty fields leave Claude Code to its own defaults. Everything else about this terminal is yours."
      submitLabel={running ? 'Restart and save' : 'Save'}
      canSubmit={changed}
      pending={apply.isPending}
      error={apply.error}
      onSubmit={() => apply.mutate([master.id, patch], { onSuccess: () => onOpenChange(false) })}
    >
      <Field id="master-model" label="Model" hint="Empty uses Claude Code's own default.">
        <Input id="master-model" value={model} onChange={(e) => setModel(e.target.value)} placeholder="default" className="font-mono" />
      </Field>
      <div className="grid grid-cols-2 gap-3">
        {hasEffort({ agent: 'claude', model }) && (
          <Field id="master-effort" label="Effort">
            <Select value={effortValue(effort)} onValueChange={(v) => setEffort(effortFromValue(v))}>
              <SelectTrigger id="master-effort" className="w-full">
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
          </Field>
        )}
        <Field id="master-mode" label="Permission mode">
          <Select value={mode || DEFAULT_MODE} onValueChange={(v) => setMode(v === DEFAULT_MODE ? '' : v)}>
            <SelectTrigger id="master-mode" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={DEFAULT_MODE}>default</SelectItem>
              {MODES.map((m) => (
                <SelectItem key={m} value={m}>
                  {m}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
      </div>
      {running && changed && <p className="text-xs text-amber-400">The running Master Terminal restarts as a fresh session.</p>}
    </FormDialog>
  )
}
